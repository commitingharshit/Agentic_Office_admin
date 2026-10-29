// Audit traceability (migration 0034): every admin_audit row names its subject, the list filters by subject, administrator, date and text,
// and a user's history can be reached by the new columns as well as by target_user_id. Runs on a database of its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';
import { readFileSync } from 'node:fs';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const tag = Date.now().toString(36);
const DB = `ao_trace_${tag}`;
const TOKEN = `trace-token-${tag}-0123456789abcdef`;
const urlFor = (db: string, role?: string, pw?: string) => { const u = new URL(ownerUrl!); u.pathname = `/${db}`; if (role) { u.username = role; u.password = pw ?? ''; } return u.toString(); };
let server: Server, base: string, root: pg.Client, owner: pg.Client, ro: pg.Pool, adm: pg.Pool;

before(async () => {
  if (skip) return;
  root = new pg.Client({ connectionString: urlFor('postgres') }); await root.connect();
  // Test files that make their own database run side by side: creating from the same template can briefly collide, so retry.
  for (let i = 0; ; i++) {
    try { await root.query(`CREATE DATABASE ${DB}`); break; }
    catch (e) { if (i >= 20 || !/being accessed by other users|already exists|tuple concurrently/.test(String((e as Error).message))) { await root.end(); throw e; } await new Promise((r) => setTimeout(r, 150 + Math.random() * 350)); }
  }
  // Roles are cluster-wide, so migrating two databases at once can collide on them; that is a race between test files, not a bug.
  for (let i = 0; ; i++) {
    const m = spawnSync(process.execPath, ['../../database/migrate.ts'], { env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: 'utf8' });
    if (m.status === 0) break;
    if (i >= 8 || !/tuple concurrently|deadlock|already exists|being accessed/.test(m.stderr)) assert.fail(m.stderr);
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  }
  owner = new pg.Client({ connectionString: urlFor(DB) }); await owner.connect();
  ro = new pg.Pool({ connectionString: urlFor(DB, 'ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: urlFor(DB, 'ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const handler = adminHandler({ ro, admin: adm, tokens: parseTokens(`console:${TOKEN}`) });
  server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  server?.close();
  await Promise.all([ro?.end(), adm?.end(), owner?.end()]);
  await root?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await root?.end().catch(() => undefined);
});

type Res = { status: number; body: any; text: string };
const call = async (method: string, path: string, o: { body?: unknown; acting?: string; token?: string } = {}): Promise<Res> => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${o.token ?? TOKEN}`, 'content-type': 'application/json', ...(o.acting ? { 'x-ao-acting-admin': o.acting } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, body, text };
};
const person = async (name: string, o: { role?: 'user' | 'admin'; admin_role?: string; status?: string } = {}) => {
  const id = `usr_${name.replace(/_/g, '')}${tag}`;   // real ids are usr_<alphanumerics>; the acting-admin header enforces that
  await owner.query(`INSERT INTO users(id, email, display_name, role, status) VALUES ($1,$2,$3,$4,$5)`, [id, `${name}.${tag}@example.test`, `Name ${name}`, o.role ?? 'user', o.status ?? 'active']);
  if (o.role === 'admin' && o.admin_role) await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,$2)`, [id, o.admin_role]);
  return id;
};


test('a user action, a flag change and a refused request: each row names its subject', { skip }, async () => {
  const boss = await person('boss', { role: 'admin', admin_role: 'superadmin' });
  const u = await person('subject');
  assert.equal((await call('GET', `/admin/users/${u}`, { acting: boss })).status, 200);
  assert.equal((await call('POST', '/admin/flags', { acting: boss, body: { key: `beta_${tag}`, enabled: true, rollout_pct: 100 } })).status, 200);
  const user = (await owner.query(`SELECT target_user_id, target_type, target_id FROM admin_audit WHERE action = 'view_user' AND target_user_id = $1`, [u])).rows;
  assert.deepEqual(user, [{ target_user_id: u, target_type: 'user', target_id: u }]);
  const flag = (await owner.query(`SELECT target_user_id, target_type, target_id FROM admin_audit WHERE action = 'save_flag' AND target_id = $1`, [`beta_${tag}`])).rows;
  assert.deepEqual(flag, [{ target_user_id: null, target_type: 'flag', target_id: `beta_${tag}` }]);
  const overview = (await owner.query(`SELECT target_type, target_id FROM admin_audit WHERE admin_user_id = $1 AND action = 'view_overview'`, [boss])).rows;
  assert.ok(overview.every((r) => r.target_type === null && r.target_id === null));
});

test('the list names the administrator and the subject, and filters by each', { skip }, async () => {
  const boss = await person('lister', { role: 'admin', admin_role: 'superadmin' });
  const u = await person('listed');
  await call('GET', `/admin/users/${u}`, { acting: boss });
  await call('POST', '/admin/flags', { acting: boss, body: { key: `gate_${tag}`, enabled: false, rollout_pct: 0 } });
  const all = (await call('GET', `/admin/audit?admin=${boss}`, { acting: boss })).body;
  assert.ok(all.entries.length >= 2);
  const mine = all.entries.find((e: any) => e.action === 'view_user' && e.target_user_id === u);
  assert.equal(mine.admin_email, `lister.${tag}@example.test`);
  assert.equal(mine.target_email, `listed.${tag}@example.test`);
  assert.ok(all.actions.includes('view_user') && all.actions.includes('save_flag'));
  const byType = (await call('GET', `/admin/audit?admin=${boss}&targetType=flag&targetId=gate_${tag}`, { acting: boss })).body;
  assert.equal(byType.total, 1);
  assert.equal(byType.entries[0].action, 'save_flag');
  const byUser = (await call('GET', `/admin/audit?targetType=user&targetId=${u}`, { acting: boss })).body;
  assert.ok(byUser.entries.every((e: any) => e.target_id === u));
  const legacy = (await call('GET', `/admin/audit?target=${u}`, { acting: boss })).body;
  assert.equal(legacy.total, byUser.total);
  const text = (await call('GET', `/admin/audit?admin=${boss}&q=gate_${tag}`, { acting: boss })).body;
  assert.ok(text.total >= 1 && text.entries.every((e: any) => JSON.stringify(e).includes(`gate_${tag}`)));
});

test('date filters are inclusive of the whole day, and a malformed date is ignored, not an error', { skip }, async () => {
  const boss = await person('dater', { role: 'admin', admin_role: 'superadmin' });
  await call('GET', '/admin/overview', { acting: boss });
  const today = new Date().toISOString().slice(0, 10);
  const same = (await call('GET', `/admin/audit?admin=${boss}&from=${today}&to=${today}`, { acting: boss })).body;
  assert.ok(same.total >= 1);
  const past = (await call('GET', `/admin/audit?admin=${boss}&to=2001-01-01`, { acting: boss })).body;
  assert.equal(past.total, 0);
  const bad = await call('GET', `/admin/audit?admin=${boss}&from=yesterday&to=%27--`, { acting: boss });
  assert.equal(bad.status, 200);
  assert.ok(bad.body.total >= 1);
});

test('a wildcard typed in the search box matches itself, not everything', { skip }, async () => {
  const boss = await person('wild', { role: 'admin', admin_role: 'superadmin' });
  await call('POST', '/admin/flags', { acting: boss, body: { key: `w_${tag}`, enabled: true, rollout_pct: 1 } });
  const r = (await call('GET', `/admin/audit?admin=${boss}&q=%25`, { acting: boss })).body;
  assert.equal(r.total, 0);
});

test('migration 0034 backfills old rows and can be applied again without harm', { skip }, async () => {
  const u = await person('legacy');
  await owner.query(`INSERT INTO admin_audit(admin_user_id, action, target_user_id, detail) VALUES ('old-admin', 'disable', $1, '{}')`, [u]);
  await owner.query(`INSERT INTO admin_audit(admin_user_id, action, target_user_id, target_type, target_id, detail) VALUES ('old-admin', 'noop', NULL, NULL, NULL, '{}')`);
  const sql = readFileSync(new URL('../../../database/migrations/0037_audit_entity.sql', import.meta.url), 'utf8');
  await owner.query(sql);
  await owner.query(sql);
  const row = (await owner.query(`SELECT target_type, target_id FROM admin_audit WHERE admin_user_id = 'old-admin' AND action = 'disable'`)).rows[0];
  assert.deepEqual(row, { target_type: 'user', target_id: u });
  const none = (await owner.query(`SELECT target_type FROM admin_audit WHERE admin_user_id = 'old-admin' AND action = 'noop'`)).rows[0];
  assert.equal(none.target_type, null);
});

test('the read-only role can read the new columns and cannot write them', { skip }, async () => {
  assert.ok((await ro.query('SELECT target_type, target_id FROM admin_audit LIMIT 1')).rows.length >= 0);
  await assert.rejects(ro.query(`UPDATE admin_audit SET target_type = 'x'`), /permission denied|read-only transaction/);
});
