// The sync API and Clerk sign-in against a live database (AO_TEST_PG + role passwords, as in
// schema.test.ts) and MinIO (AO_TEST_MINIO). Clerk is faked with a local RSA key and JWKS server,
// so the verifier, the user mapping and RLS run for real.
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler } from '../src/api/admin.ts';
import { ClerkVerifier, frontendApiFromPublishableKey } from '../src/auth/clerk.ts';
import { S3 } from '../src/api/s3.ts';
import { syncHandler } from '../src/api/sync.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const ISS = 'https://fake-clerk.test';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'k1';
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(claims: Record<string, unknown>, o: { kid?: string; key?: typeof privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', kid: o.kid ?? KID, typ: 'JWT' });
  const body = b64u({ iss: ISS, iat: now, nbf: now - 1, exp: now + 300, ...claims });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(o.key ?? privateKey).toString('base64url')}`;
}
const A = `user_a_${tag}`, B = `user_b_${tag}`, ADM = `user_adm_${tag}`;
const s3 = process.env.AO_TEST_MINIO ? new S3({ endpoint: process.env.AO_TEST_MINIO, accessKey: process.env.MINIO_ROOT_USER!, secretKey: process.env.MINIO_ROOT_PASSWORD! }) : undefined;

let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool, verifier: ClerkVerifier;
let jwksHits = 0;

before(async () => {
  if (skip) return;
  jwks = createServer((_req, res) => { jwksHits++; res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] })); });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), s3 });
  const admin = adminHandler({ ro, admin: adm, tokens: new Map(), s3, verifyClerk: (t) => verifier.verify(t) });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  const ids = (await owner.query('SELECT id FROM users WHERE clerk_user_id = ANY($1)', [[A, B, ADM]])).rows.map((r) => r.id);
  if (s3) for (const id of ids) for (const o of await s3.list('ao-user-blobs', `${id}/`)) await s3.delete('ao-user-blobs', o.key);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await owner.query(`DELETE FROM admin_audit WHERE admin_user_id LIKE $1`, [`%${tag}%`]);
  api.close(); jwks.close();
  await Promise.all([app.end(), ro.end(), adm.end(), owner.end()]);
});

const tokenA = () => mint({ sub: A, email: `a.${tag}@example.test`, name: 'Ana', azp: 'app://agentic-office', provider: 'oauth_google' });
const tokenB = () => mint({ sub: B, email: `b.${tag}@example.test`, azp: 'app://agentic-office' });
const call = async (path: string, token: string, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

test('publishable key decodes to the Frontend API', () => {
  assert.equal(frontendApiFromPublishableKey(`pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`), 'https://clever-cat-1.clerk.accounts.dev');
  assert.throws(() => frontendApiFromPublishableKey('sk_test_x'));
});

test('Clerk tokens: valid, expired, wrong issuer, forged, another app, unknown key', { skip }, async () => {
  assert.equal((await verifier.verify(tokenA())).sub, A);
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(verifier.verify(mint({ sub: A, exp: now - 60 })), /expired/);
  await assert.rejects(verifier.verify(mint({ sub: A, iss: 'https://evil.test' })), /another sign-in service/);
  const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(verifier.verify(mint({ sub: A }, { key: other })), /signature/);
  await assert.rejects(verifier.verify(mint({ sub: A, azp: 'https://phish.test' })), /another app/);
  const before = jwksHits;
  await assert.rejects(verifier.verify(mint({ sub: A }, { kid: 'rotated' })), /unknown key/);
  assert.equal(jwksHits, before + 1, 'an unknown kid refetches the keys once');
});

test('sign-in creates our user once, with its identity, and refuses a disabled account', { skip }, async () => {
  assert.equal((await call('/v1/session', 'not.a.jwt', { method: 'POST' })).status, 401);
  const s1 = await call('/v1/session', tokenA(), { method: 'POST' });
  assert.equal(s1.status, 200);
  assert.match(s1.body.user.id, /^usr_/);
  const s2 = await call('/v1/session', tokenA(), { method: 'POST' });
  assert.equal(s2.body.user.id, s1.body.user.id);
  const oa = await owner.query('SELECT provider, email FROM oauth_accounts WHERE user_id = $1', [s1.body.user.id]);
  assert.deepEqual(oa.rows, [{ provider: 'google', email: `a.${tag}@example.test` }]);
  const b = await call('/v1/session', tokenB(), { method: 'POST' });
  await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [b.body.user.id]);
  // The id cache is per process; a fresh handler sees the disable at once (an existing one within a minute).
  const fresh = syncHandler({ app, verify: (t) => verifier.verify(t), s3 });
  const srv = createServer(async (q, r) => { await fresh(q, r); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/me`, { headers: { authorization: `Bearer ${tokenB()}` } });
  srv.close();
  assert.equal(r.status, 403);
  await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [b.body.user.id]);
});

test('events are idempotent by id, ordered per session, and private to their user', { skip }, async () => {
  const sid = `ses_${tag}`;
  const ev = (n: number, id = `evt_${tag}_${n}`) => ({ event_id: id, session_id: sid, workspace_id: `wsnew_${tag}`, sequence: n, type: 'run.state', payload_b64: Buffer.from(`ciphertext ${n}`).toString('base64'), created_at: new Date().toISOString() });
  const first = await call('/v1/events', tokenA(), { method: 'POST', body: JSON.stringify({ events: [ev(1), ev(2), ev(3)] }) });
  assert.deepEqual(first.body, { acked: [`evt_${tag}_1`, `evt_${tag}_2`, `evt_${tag}_3`], rejected: [] });
  const retry = await call('/v1/events', tokenA(), { method: 'POST', body: JSON.stringify({ events: [ev(2), ev(3), ev(3, `evt_${tag}_x`)] }) });
  assert.deepEqual(retry.body.acked, [`evt_${tag}_2`, `evt_${tag}_3`]);
  assert.equal(retry.body.rejected[0].event_id, `evt_${tag}_x`);
  const page = await call(`/v1/events?session_id=${sid}&after=1`, tokenA());
  assert.deepEqual(page.body.events.map((e: { sequence: number }) => e.sequence), [2, 3]);
  assert.equal(Buffer.from(page.body.events[0].payload_b64, 'base64').toString(), 'ciphertext 2');
  const other = await call(`/v1/events?session_id=${sid}`, tokenB());
  assert.deepEqual(other.body.events, []);
  const n = await owner.query('SELECT count(*)::int AS n FROM session_events WHERE session_id = $1', [sid]);
  assert.equal(n.rows[0].n, 3);
});

test('blobs and revisions: hash-checked, per user, optimistic', { skip: skip || (!s3 && 'AO_TEST_MINIO not set') }, async () => {
  const bytes = Buffer.from(`encrypted document ${tag}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const bad = await call(`/v1/blobs/${'0'.repeat(64)}`, tokenA(), { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(bad.status, 400);
  const doc = `doc_${tag}`;
  const early = await call('/v1/revisions', tokenA(), { method: 'POST', body: JSON.stringify({ doc_id: doc, revision: 1, content_hash: hash, bytes: bytes.length }) });
  assert.equal(early.status, 409);
  assert.equal((await call(`/v1/blobs/${hash}`, tokenA(), { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } })).status, 200);
  assert.deepEqual((await call(`/v1/blobs/${hash}`, tokenA())).body, bytes);
  assert.equal((await call(`/v1/blobs/${hash}`, tokenB())).status, 404, "another user's namespace");
  const r1 = await call('/v1/revisions', tokenA(), { method: 'POST', body: JSON.stringify({ doc_id: doc, revision: 1, content_hash: hash, bytes: bytes.length, op_id: 'op1' }) });
  assert.equal(r1.status, 200);
  const stale = await call('/v1/revisions', tokenA(), { method: 'POST', body: JSON.stringify({ doc_id: doc, revision: 1, content_hash: hash }) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.latest, 1);
  assert.equal((await call('/v1/revisions', tokenA(), { method: 'POST', body: JSON.stringify({ doc_id: doc, revision: 2, content_hash: hash }) })).status, 200);
  assert.deepEqual((await call(`/v1/revisions/${doc}`, tokenA())).body.revisions.map((x: { revision: number }) => x.revision), [2, 1]);
});

test('devices, workspaces, sessions, memory references and cursors round-trip', { skip }, async () => {
  const t = tokenA();
  assert.equal((await call(`/v1/devices/dev_${tag}`, t, { method: 'PUT', body: JSON.stringify({ name: 'Laptop', platform: 'macOS', app_version: '1.0' }) })).status, 200);
  await call(`/v1/workspaces/ws_${tag}`, t, { method: 'PUT', body: JSON.stringify({ name: 'Board pack' }) });
  await call(`/v1/sessions/ses2_${tag}`, t, { method: 'PUT', body: JSON.stringify({ workspace_id: `ws_${tag}`, title: 'Q3 review', latest_checkpoint_id: `chk_${tag}` }) });
  const me = await call('/v1/me', t);
  assert.equal(me.body.devices[0].name, 'Laptop');
  assert.equal(me.body.workspaces[0].name, 'Board pack');
  const ss = await call(`/v1/sessions?workspace_id=ws_${tag}`, t);
  assert.equal(ss.body.sessions[0].latest_checkpoint_id, `chk_${tag}`);
  await call(`/v1/memory/mem_${tag}`, t, { method: 'PUT', body: JSON.stringify({ source_version: 'v1', kind: 'decision', expected_version: null }) });
  const mem = await call('/v1/memory', t);
  assert.match(mem.body.memories[0].memory_uri, /^mnemo:\/\/usr_.+\/mem_/);
  assert.deepEqual((await call('/v1/memory', tokenB())).body.memories, []);
  assert.equal((await call(`/v1/memory/mem_${tag}`, t, { method: 'PUT', body: JSON.stringify({ source_version: 'stale', expected_version: null }) })).status, 409);
  assert.equal((await call(`/v1/memory/mem_${tag}`, t, { method: 'DELETE', body: JSON.stringify({ expected_version: 'stale' }) })).status, 409);
  assert.equal((await call(`/v1/memory/mem_${tag}`, t, { method: 'DELETE', body: JSON.stringify({ expected_version: 'v1' }) })).status, 200);
  assert.deepEqual((await call('/v1/memory', t)).body.memories, []);
  assert.equal((await call(`/v1/memory/mem_${tag}`, t, { method: 'PUT', body: JSON.stringify({ source_version: 'v2', expected_version: 'v1' }) })).status, 409);
  await call(`/v1/cursors/dev_${tag}/events`, t, { method: 'PUT', body: JSON.stringify({ cursor: '42' }) });
  assert.equal((await call(`/v1/cursors/dev_${tag}/events`, t)).body.cursor, '42');
});

test('admins sign in with Clerk: role claim or our admin row; others get 403', { skip }, async () => {
  const adminTok = mint({ sub: ADM, email: `adm.${tag}@example.test`, role: 'admin' });
  const ok = await call('/admin/me', adminTok);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.admin, `adm.${tag}@example.test`);
  assert.equal((await call('/admin/overview', tokenA())).status, 403);
  const a = await owner.query('SELECT id FROM users WHERE clerk_user_id = $1', [A]);
  await owner.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [a.rows[0].id]);
  assert.equal((await call('/admin/me', tokenA())).status, 200);
  await owner.query(`UPDATE users SET role = 'user' WHERE id = $1`, [a.rows[0].id]);
});

test('device metrics: numbers only, private to the user, summarised for admins', { skip }, async () => {
  const r = await call('/v1/metrics', tokenA(), { method: 'POST', body: JSON.stringify({ device_id: `dev_${tag}`, metrics: {
    event_write_ms: { count: 40, p50: 0.1, p95: 2.5, max: 9 }, retrieval_ms: { count: 5, p50: 40, p95: 120, max: 130 },
    gauges: { extraction_lag_s: 30, outbox_pending: 4, note: 'not a number' }, 'Bad Name': 1, text: 'secret transcript',
  } }) });
  assert.equal(r.status, 200);
  const a = await owner.query('SELECT id FROM users WHERE clerk_user_id = $1', [A]);
  const stored = (await owner.query('SELECT metrics FROM device_metrics WHERE user_id = $1', [a.rows[0].id])).rows[0].metrics;
  assert.deepEqual(stored.gauges, { extraction_lag_s: 30, outbox_pending: 4 });
  assert.equal('text' in stored || 'Bad Name' in stored, false, 'only numbers under valid names are kept');
  const h = await call('/admin/health', mint({ sub: ADM, role: 'admin' }));
  assert.ok(h.body.devices.reporting >= 1 && h.body.devices.event_write_p95_ms >= 2.5 && h.body.devices.retrieval_p95_ms >= 120 && h.body.devices.extraction_lag_s >= 30);
});

test('desktop sign-in: a Clerk token becomes a device token; sign-out, admin sign-out and disable end it', { skip }, async () => {
  const cfg = await fetch(base + '/v1/auth/config').then((r) => r.json());
  assert.ok('publishableKey' in cfg);
  const bad = await fetch(base + '/v1/auth/exchange', { method: 'POST', body: JSON.stringify({ clerk_token: 'nope' }) });
  assert.equal(bad.status, 401);
  const ex = async () => (await fetch(base + '/v1/auth/exchange', { method: 'POST', body: JSON.stringify({ clerk_token: tokenA(), device_name: 'Test Mac', platform: 'darwin' }) })).json();
  const d1 = await ex();
  assert.match(d1.token, /^aod_[A-Za-z0-9_-]{43}$/);
  assert.equal(d1.user.email, `a.${tag}@example.test`);
  assert.equal((await call('/v1/me', d1.token)).status, 200);
  const stored = (await owner.query('SELECT token_hash FROM device_tokens WHERE user_id = $1', [d1.user.id])).rows.map((r) => r.token_hash);
  assert.ok(stored.length >= 1 && !stored.includes(d1.token), 'only the hash is stored');
  // A forged device token is refused; B cannot see A's tokens through RLS.
  assert.equal((await call('/v1/me', 'aod_' + 'x'.repeat(43))).status, 401);
  const c = await app.connect();
  try {
    await c.query('BEGIN'); await c.query(`SELECT set_config('app.user_id', 'usr_someone_else', true)`);
    assert.equal((await c.query('SELECT count(*)::int n FROM device_tokens')).rows[0].n, 0);
    await c.query('ROLLBACK');
  } finally { c.release(); }
  // Sign-out ends this device only.
  const d2 = await ex();
  assert.equal((await call('/v1/auth/signout', d1.token, { method: 'POST' })).status, 200);
  assert.equal((await call('/v1/me', d1.token)).status, 401);
  assert.equal((await call('/v1/me', d2.token)).status, 200);
  // No provider or email claim (as with some Microsoft accounts): the server asks Clerk, records every
  // linked identity, and replaces the provider-less 'clerk' row a first sign-in left behind.
  const C = `user_c_${tag}`;
  await fetch(base + '/v1/session', { method: 'POST', headers: { authorization: `Bearer ${mint({ sub: C })}` } });
  assert.deepEqual((await owner.query('SELECT provider FROM oauth_accounts WHERE subject = $1', [C])).rows.map((x) => x.provider), ['clerk']);
  let linked: Array<{ provider: string; email: string; image?: string }> = [{ provider: 'oauth_microsoft', email: `c.${tag}@outlook.test`, image: 'https://img.example.test/c.png' }];
  const asked = syncHandler({ app, verify: (t) => verifier.verify(t), s3, clerkIdentities: async (sub) => (sub === C ? linked : []) });
  const s2 = createServer(async (req, res) => { await asked(req, res); });
  await new Promise<void>((ok) => s2.listen(0, '127.0.0.1', ok));
  const exC = () => fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/v1/auth/exchange`, { method: 'POST', body: JSON.stringify({ clerk_token: mint({ sub: C }) }) });
  const provs = async () => (await owner.query('SELECT provider, email FROM oauth_accounts WHERE subject = $1 AND revoked_at IS NULL ORDER BY provider', [C])).rows.map((x) => `${x.provider}:${x.email}`);
  try {
    assert.equal((await exC()).status, 200);
    assert.deepEqual(await provs(), [`microsoft:c.${tag}@outlook.test`]);
    const tokC = (await (await exC()).json()).token;
    const meC = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/v1/me`, { headers: { authorization: `Bearer ${tokC}` } }).then((r) => r.json());
    assert.deepEqual(meC.identities.map((i: { provider: string }) => i.provider), ['microsoft'], 'the placeholder is not listed');
    assert.equal(meC.user.avatar_url, 'https://img.example.test/c.png', 'the profile photo comes from Clerk');
    assert.equal((await owner.query('SELECT email FROM users WHERE clerk_user_id = $1', [C])).rows[0].email, `c.${tag}@outlook.test`);
    // Later the same person links Google in Clerk: both are recorded, once each, however often they sign in.
    linked = [...linked, { provider: 'oauth_google', email: `c.${tag}@gmail.test` }];
    assert.equal((await exC()).status, 200);
    assert.equal((await exC()).status, 200);
    assert.deepEqual(await provs(), [`google:c.${tag}@gmail.test`, `microsoft:c.${tag}@outlook.test`]);
    // Clerk unreachable: sign-in still works, identities stay as they were.
    const down = syncHandler({ app, verify: (t) => verifier.verify(t), s3, clerkIdentities: async () => { throw new Error('down'); } });
    const r = await new Promise<number>((ok) => { const s3v = createServer(async (q, w) => { await down(q, w); }); s3v.listen(0, '127.0.0.1', async () => {
      const st = (await fetch(`http://127.0.0.1:${(s3v.address() as AddressInfo).port}/v1/auth/exchange`, { method: 'POST', body: JSON.stringify({ clerk_token: mint({ sub: C }) }) })).status;
      s3v.close(); ok(st); }); });
    assert.equal(r, 200);
    assert.equal((await provs()).length, 2);
    const uidC = (await owner.query('SELECT id FROM users WHERE clerk_user_id = $1', [C])).rows[0].id;
    assert.equal((await owner.query('SELECT providers FROM admin_user_overview WHERE id = $1', [uidC])).rows[0].providers, 'google,microsoft');
  } finally { s2.close(); await owner.query('DELETE FROM users WHERE clerk_user_id = $1', [C]); }
  // Admin force sign-out ends every device (the per-token cache lasts up to a minute, so a fresh handler checks).
  const signOut = await adminHandlerForTest();
  const r = await signOut(d1.user.id);
  assert.equal(r.devices, 1);
  const fresh = syncHandler({ app, verify: (t) => verifier.verify(t), s3 });
  const srv = createServer(async (req, res) => { await fresh(req, res); });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const u = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/me`;
    assert.equal((await fetch(u, { headers: { authorization: `Bearer ${d2.token}` } })).status, 401);
    const d3 = await ex();
    await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [d3.user.id]);
    assert.equal((await fetch(u, { headers: { authorization: `Bearer ${d3.token}` } })).status, 403);
    await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [d3.user.id]);
  } finally { srv.close(); }
});

async function adminHandlerForTest() {
  // Drive the admin API's force sign-out the way the console does.
  const tok = mint({ sub: ADM, role: 'admin', azp: 'app://agentic-office' });
  return async (id: string) => (await call(`/admin/users/${id}/sign-out`, tok, { method: 'POST' })).body as { devices: number };
}
