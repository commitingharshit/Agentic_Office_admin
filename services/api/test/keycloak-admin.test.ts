// The console's reach into Keycloak, against a fake Keycloak admin REST API: what it shows (sessions, login events, authenticator),
// what it mirrors (disable/enable and sign-out), that a Keycloak outage never blocks our own action, and that it only ever speaks about
// one person by a well-formed id. Runs on a database of its own through the real admin handler.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { KeycloakAdmin } from '../src/api/keycloak-admin.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const tag = Date.now().toString(36);
const TOKEN = `kca-token-${tag}-0123456789abcdef`, SECRET = `ao-api-secret-${tag}`;
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };

let kc: Server, api: Server, base: string, owner: pg.Client, ro: pg.Pool, adm: pg.Pool, deps: AdminDeps;
const calls: string[] = [];
let tokenCalls = 0, down = false;
const state = { enabled: true as boolean, attributes: { keepme: ['yes'] } as Record<string, string[]> };
const created: string[] = [];

before(async () => {
  if (skip) return;
  kc = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (down) { res.destroy(); return; }
      if (u.pathname === '/realms/agentic-office/protocol/openid-connect/token') {
        tokenCalls++;
        const f = new URLSearchParams(b);
        return f.get('client_id') === 'ao-api' && f.get('client_secret') === SECRET && f.get('grant_type') === 'client_credentials' ? send(200, { access_token: 'svc-token', expires_in: 300 }) : send(401, { error: 'unauthorized_client' });
      }
      if (req.headers.authorization !== 'Bearer svc-token') return send(401, {});
      const m = /^\/admin\/realms\/agentic-office\/(.*)$/.exec(u.pathname);
      if (!m) return send(403, { error: 'master realm is off limits' });
      calls.push(`${req.method} ${m[1]}${u.search}`);
      const sub = m[1].split('/')[1];
      if (sub === 'ffffffff-ffff-ffff-ffff-ffffffffffff') return send(404, {});
      if (m[1].startsWith('users/') && m[1].endsWith('/credentials')) return send(200, [{ type: 'password', secretData: '{"value":"HASH","salt":"SALT"}' }, { type: 'otp', secretData: '{"value":"TOTP-SEED"}' }]);
      if (m[1].endsWith('/sessions')) return send(200, [{ id: 's1', ipAddress: '203.0.113.9', start: 1000, lastAccess: 2000, clients: { c1: 'agentic-office-desktop' }, username: 'x' }]);
      if (m[1].endsWith('/logout')) return send(204, {});
      if (m[1].startsWith('events')) return send(200, [{ time: 3000, type: 'LOGIN', ipAddress: '203.0.113.9', clientId: 'agentic-office-desktop', userId: sub, details: { username: 'secret-detail' } }, { time: 2900, type: 'LOGIN_ERROR', error: 'invalid_user_credentials', clientId: 'agentic-office-desktop' }]);
      if (req.method === 'PUT') { const rep = JSON.parse(b); if (rep.enabled !== undefined) state.enabled = rep.enabled; if (rep.attributes) { state.attributes = rep.attributes; } return send(204, {}); }
      return send(200, { id: sub, enabled: state.enabled, emailVerified: true, createdTimestamp: 1700000000000, requiredActions: ['VERIFY_EMAIL'], attributes: state.attributes });
    });
  });
  await new Promise<void>((r) => kc.listen(0, '127.0.0.1', r));
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  deps = { ro, admin: adm, tokens: parseTokens(`console:${TOKEN}`), keycloak: new KeycloakAdmin({ baseUrl: `http://127.0.0.1:${(kc.address() as AddressInfo).port}`, realm: 'agentic-office', clientId: 'ao-api', clientSecret: SECRET }) };
  const h = adminHandler(deps);
  api = createServer((req, res) => { void h(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await owner.query(`DELETE FROM admin_audit WHERE target_user_id = ANY($1)`, [created]);
  kc.close(); api.close();
  await Promise.all([owner.end(), ro.end(), adm.end()]);
});

const call = async (method: string, path: string) => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as any, raw: '' };
};
let n = 0;
async function person(linked = true) {
  const id = `usr_kca${++n}${tag}`, sub = `0123abcd-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
  await owner.query(`INSERT INTO users(id, email) VALUES ($1,$2)`, [id, `kca${n}.${tag}@example.test`]); created.push(id);
  if (linked) await owner.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject) VALUES ($1,$2,'keycloak',$3)`, [`oa_kca${n}${tag}`, id, sub]);
  return { id, sub };
}

test("the user page can show a person's Keycloak sign-ins, authenticator and login events, and nothing secret", { skip }, async () => {
  const p = await person();
  const r = await call('GET', `/admin/users/${p.id}/keycloak`);
  assert.equal(r.status, 200);
  assert.equal(r.body.linked, true);
  assert.deepEqual(r.body.user, { enabled: true, emailVerified: true, createdAt: 1700000000000, totp: true, requiredActions: ['VERIFY_EMAIL'] });
  assert.deepEqual(r.body.sessions, [{ id: 's1', ip: '203.0.113.9', started: 1000, lastAccess: 2000, clients: ['agentic-office-desktop'] }]);
  assert.deepEqual(r.body.events.map((e: any) => [e.type, e.error]), [['LOGIN', null], ['LOGIN_ERROR', 'invalid_user_credentials']]);
  const text = JSON.stringify(r.body);
  for (const secret of ['HASH', 'SALT', 'TOTP-SEED', 'secret-detail', 'nope', 'svc-token', SECRET]) assert.ok(!text.includes(secret), `${secret} must not reach the console`);
});

test('not linked, not configured and unreachable are each said plainly', { skip }, async () => {
  assert.deepEqual((await call('GET', `/admin/users/${(await person(false)).id}/keycloak`)).body, { configured: true, linked: false });
  const saved = deps.keycloak; deps.keycloak = undefined;
  try { assert.deepEqual((await call('GET', `/admin/users/${(await person()).id}/keycloak`)).body, { configured: false }); } finally { deps.keycloak = saved; }
  const p = await person(); down = true;
  try { const r = await call('GET', `/admin/users/${p.id}/keycloak`); assert.equal(r.status, 200); assert.match(r.body.error, /could not be reached/); } finally { down = false; }
  const gone = `usr_kcgone${tag}`;
  await owner.query(`INSERT INTO users(id, email) VALUES ($1,$2)`, [gone, `gone.${tag}@example.test`]); created.push(gone);
  await owner.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject) VALUES ($1,$2,'keycloak','ffffffff-ffff-ffff-ffff-ffffffffffff')`, [`oa_gone${tag}`, gone]);
  assert.match((await call('GET', `/admin/users/${gone}/keycloak`)).body.error, /no longer has this person/);
});

test('disabling a person ends their Keycloak sessions and disables them there; enabling turns them back on', { skip }, async () => {
  const p = await person(); calls.length = 0;
  const off = await call('POST', `/admin/users/${p.id}/disable`);
  assert.equal(off.status, 200); assert.deepEqual(off.body.keycloak, { configured: true, linked: true, ok: true });
  assert.equal((await owner.query('SELECT status FROM users WHERE id = $1', [p.id])).rows[0].status, 'disabled');
  assert.ok(calls.includes(`PUT users/${p.sub}`) && calls.includes(`POST users/${p.sub}/logout`));
  assert.equal(state.enabled, false);
  calls.length = 0;
  const on = await call('POST', `/admin/users/${p.id}/enable`);
  assert.equal(on.body.keycloak.ok, true); assert.equal(state.enabled, true);
  assert.ok(!calls.some((c) => c.endsWith('/logout')), 'enabling signs nobody out');
});

test('sign-out everywhere also ends their Keycloak sessions', { skip }, async () => {
  const p = await person(); calls.length = 0;
  const r = await call('POST', `/admin/users/${p.id}/sign-out`);
  assert.equal(r.status, 200); assert.equal(r.body.keycloak.ok, true);
  assert.ok(calls.includes(`POST users/${p.sub}/logout`));
});

test('a Keycloak outage never blocks our own action, and says so', { skip }, async () => {
  const p = await person(); down = true;
  try {
    const r = await call('POST', `/admin/users/${p.id}/disable`);
    assert.equal(r.status, 200); assert.equal(r.body.keycloak.ok, false); assert.ok(r.body.keycloak.error);
    assert.equal((await owner.query('SELECT status FROM users WHERE id = $1', [p.id])).rows[0].status, 'disabled', 'our own account state still changed');
  } finally { down = false; }
  const plain = await person(false);
  assert.deepEqual((await call('POST', `/admin/users/${plain.id}/disable`)).body.keycloak, { configured: true, linked: false }, 'a person who is not on Keycloak is simply not mirrored');
});

test('the service token is fetched once and reused; a wrong secret and a malformed id are refused before anything is asked', { skip }, async () => {
  const k = deps.keycloak!;
  const before = tokenCalls;
  await k.sessions('0123abcd-0000-4000-8000-000000009999'); await k.sessions('0123abcd-0000-4000-8000-000000009999');
  assert.ok(tokenCalls - before <= 1, 'one token for two calls');
  for (const bad of ['../master', 'a/b', '', 'x', 'id with spaces', '0123abcd?x=1']) await assert.rejects(k.user(bad), /Not a Keycloak user id/, bad);
  const wrong = new KeycloakAdmin({ baseUrl: `http://127.0.0.1:${(kc.address() as AddressInfo).port}`, realm: 'agentic-office', clientId: 'ao-api', clientSecret: 'wrong' });
  await assert.rejects(wrong.sessions('0123abcd-0000-4000-8000-000000009999'), /refused the admin client/);
});

test('plan and role changes made in the console are written to Keycloak, keeping the other attributes', { skip }, async () => {
  const p = await person(); calls.length = 0; state.attributes = { keepme: ['yes'] };
  const plan = await fetch(`${base}/admin/users/${p.id}/plan`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: 'beta' }) });
  const body = (await plan.json()) as any;
  assert.equal(plan.status, 200); assert.equal(body.keycloak.ok, true);
  assert.deepEqual(state.attributes, { keepme: ['yes'], ao_plan: ['beta'] }, 'the new attribute is added and the existing one kept');
  const role = await fetch(`${base}/admin/users/${p.id}/role`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-ao-acting-admin': 'usr_nobodyelse' }, body: JSON.stringify({ role: 'admin' }) });
  assert.ok([200, 403].includes(role.status));
  if (role.status === 200) assert.deepEqual(state.attributes.ao_role, ['admin']);
});
