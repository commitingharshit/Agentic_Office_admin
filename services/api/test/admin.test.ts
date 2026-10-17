// The admin API against a live, migrated database (same env as schema.test.ts) and, when
// AO_TEST_MINIO is set (http://127.0.0.1:59000 with MINIO_ROOT_USER/PASSWORD), real MinIO.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../api/admin.ts';
import { S3 } from '../api/s3.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const TOKEN = 'test-admin-token-0123456789abcdef';
const tag = Date.now().toString(36);
const A = `usr_adm_a_${tag}`, B = `usr_adm_b_${tag}`;
const s3 = process.env.AO_TEST_MINIO ? new S3({ endpoint: process.env.AO_TEST_MINIO, accessKey: process.env.MINIO_ROOT_USER!, secretKey: process.env.MINIO_ROOT_PASSWORD! }) : undefined;
let owner: pg.Client, server: Server, base: string, ro: pg.Pool, admin: pg.Pool;

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  await owner.query(`INSERT INTO users(id, email, display_name, last_active_at) VALUES ($1,'alice.${tag}@example.test','Alice',now()),($2,'bob.${tag}@example.test','Bob',NULL)`, [A, B]);
  await owner.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject) VALUES ($1,$2,'google',$3),($4,$5,'microsoft',$6)`, [`oa_a_${tag}`, A, `g_${tag}`, `oa_b_${tag}`, B, `m_${tag}`]);
  await owner.query(`INSERT INTO workspaces(id, user_id, name) VALUES ($1,$2,'Plans')`, [`ws_a_${tag}`, A]);
  await owner.query(`INSERT INTO sessions(id, user_id, workspace_id) VALUES ($1,$2,$3)`, [`ses_a_${tag}`, A, `ws_a_${tag}`]);
  await owner.query(`INSERT INTO session_events(event_id, user_id, session_id, sequence, type, payload, created_at) VALUES ($1,$2,$3,1,'run.state','\\x00',now())`, [`evt_a_${tag}`, A, `ses_a_${tag}`]);
  await owner.query(`INSERT INTO document_revisions(doc_id, revision, user_id, content_hash, blob_key, bytes) VALUES ($1,1,$2,'h',$3,2048)`, [`doc_a_${tag}`, A, `ao-user-blobs/${A}/h`]);
  if (s3) await s3.put('ao-user-blobs', `${A}/h`, 'ciphertext');
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  admin = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  server = createServer(adminHandler({ ro, admin, tokens: parseTokens(`tester:${TOKEN}`), s3 }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [[A, B]]);
  await owner.query(`DELETE FROM admin_audit WHERE admin_user_id = 'tester'`);
  server.close();
  await Promise.all([ro.end(), admin.end(), owner.end()]);
});

const call = async (path: string, init: RequestInit = {}, token: string | null = TOKEN) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
};
const audits = async (action: string, target?: string) =>
  (await owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE admin_user_id = 'tester' AND action = $1 AND ($2::text IS NULL OR target_user_id = $2)`, [action, target ?? null])).rows[0].n as number;

test('admin API: no token is 401, a wrong token is 403', { skip }, async () => {
  assert.equal((await call('/admin/overview', {}, null)).status, 401);
  assert.equal((await call('/admin/overview', {}, 'not-the-admin-token-at-all-xx')).status, 403);
  assert.equal((await call('/healthz', {}, null)).status, 200);
});

test('overview counts real rows and is audited', { skip }, async () => {
  const { status, body } = await call('/admin/overview');
  assert.equal(status, 200);
  assert.ok(body.totals.users >= 2 && body.totals.signups_today >= 2 && body.totals.dau >= 1);
  assert.equal(body.signups.length, 14);
  assert.ok(body.providers.some((p: { provider: string }) => p.provider === 'google'));
  assert.ok(body.active.at(-1).active_users >= 1);
  assert.equal(await audits('view_overview'), 1);
});

test('users: search, filter, sort and CSV', { skip }, async () => {
  const s = await call(`/admin/users?q=alice.${tag}`);
  assert.deepEqual(s.body.users.map((u: { id: string }) => u.id), [A]);
  assert.equal(s.body.users[0].storage_bytes, 2048);
  assert.equal(s.body.pageSize, 25);   // a missing pageSize is the default, not the minimum
  const ms = await call(`/admin/users?provider=microsoft&q=${tag}`);
  assert.deepEqual(ms.body.users.map((u: { id: string }) => u.id), [B]);
  const sorted = await call(`/admin/users?q=${tag}&sort=email&dir=asc`);
  assert.deepEqual(sorted.body.users.map((u: { id: string }) => u.id), [A, B]);
  const csv = await call(`/admin/users?q=${tag}&format=csv`);
  assert.match(csv.body, /^id,email,/);
  assert.equal(csv.body.trim().split('\n').length, 3);
  assert.equal(await audits('export_users_csv'), 1);
});

test('user detail and export carry metadata, never event payloads', { skip }, async () => {
  const d = await call(`/admin/users/${A}`);
  assert.equal(d.body.user.email, `alice.${tag}@example.test`);
  assert.equal(d.body.identities[0].provider, 'google');
  assert.equal(d.body.workspaces[0].sessions, 1);
  const x = await call(`/admin/users/${A}/export`);
  assert.equal(x.body.session_events.length, 1);
  assert.equal('payload' in x.body.session_events[0], false);
  assert.equal(await audits('view_user', A), 1);
  assert.equal(await audits('export', A), 1);
});

test('disable and enable change status and are audited', { skip }, async () => {
  assert.equal((await call(`/admin/users/${B}/disable`, { method: 'POST' })).status, 200);
  assert.equal((await owner.query('SELECT status FROM users WHERE id=$1', [B])).rows[0].status, 'disabled');
  await call(`/admin/users/${B}/enable`, { method: 'POST' });
  assert.equal((await owner.query('SELECT status FROM users WHERE id=$1', [B])).rows[0].status, 'active');
  assert.equal(await audits('disable', B), 1);
  const so = await call(`/admin/users/${B}/sign-out`, { method: 'POST' });
  assert.equal(so.body.clerk, false);
});

test('SQL view: reads work; writes, two statements and payloads are refused', { skip }, async () => {
  const ok = await call('/admin/sql', { method: 'POST', body: JSON.stringify({ sql: `SELECT id FROM users WHERE id = '${A}'` }) });
  assert.deepEqual(ok.body.rows, [[A]]);
  const w = await call('/admin/sql', { method: 'POST', body: JSON.stringify({ sql: `UPDATE users SET display_name='x' WHERE id='${A}'` }) });
  assert.equal(w.status, 400);
  assert.match(w.body.error, /read-only|permission denied/);
  const two = await call('/admin/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1; SELECT 2' }) });
  assert.equal(two.status, 400);
  const pay = await call('/admin/sql', { method: 'POST', body: JSON.stringify({ sql: 'SELECT payload FROM session_events LIMIT 1' }) });
  assert.equal(pay.status, 400);
  assert.equal(await audits('sql'), 4);
});

test('health reports the database, and the backup when MinIO is set', { skip }, async () => {
  const h = await call('/admin/health');
  assert.ok(h.body.db.bytes > 0 && h.body.db.max_connections > 0);
  assert.ok(Array.isArray(h.body.tables) && h.body.tables.length > 0);
  if (s3) assert.equal(h.body.backup.configured, true);
  assert.ok('archived_count' in h.body.wal && 'failed_count' in h.body.wal, 'WAL archiving status is reported');
});

test('delete needs the typed confirmation, then removes rows and blobs', { skip }, async () => {
  const bad = await call(`/admin/users/${A}`, { method: 'DELETE', body: JSON.stringify({ confirm: 'nope' }) });
  assert.equal(bad.status, 400);
  const r = await call(`/admin/users/${A}`, { method: 'DELETE', body: JSON.stringify({ confirm: `alice.${tag}@example.test` }) });
  assert.equal(r.status, 200);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [A])).rows[0].n, 0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1', [A])).rows[0].n, 0);
  if (s3) {
    assert.equal(r.body.blobsDeleted, 1);
    assert.deepEqual(await s3.list('ao-user-blobs', `${A}/`), []);
  }
  assert.equal(await audits('delete', A), 2);   // the refused attempt and the real one
  assert.equal(await audits('delete_done', A), 1);
});
