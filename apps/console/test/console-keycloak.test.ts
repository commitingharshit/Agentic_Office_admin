// The admin console signing in through Keycloak, as a browser meets it: a real `next start` in Keycloak mode, a fake Keycloak (authorization
// endpoint is only a redirect target here; its token endpoint and key set are real HTTP), and the real sync + admin API behind it.
// What is under test is ours: state and PKCE handling, who gets a console session, and that every request re-asks the API who they are.
//   Needs a production build and AUTH_TEST_PG + the role passwords (as web.test.ts).
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../../accounts-sync/src/api/admin.ts';
import { syncHandler } from '../../accounts-sync/src/api/sync.ts';
import { JwksVerifier } from '../../accounts-sync/src/auth/jwks.ts';

const ownerUrl = process.env.AUTH_TEST_PG;
const skip = !ownerUrl && 'AUTH_TEST_PG not set';
const tag = Date.now().toString(36);
const SERVICE_TOKEN = `kc-console-token-${tag}-0123456789abcdef`;
const CONSOLE_SECRET = `console-secret-${tag}-0123456789`;
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const free = async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); const p = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
let ISS = '';
const idToken = (c: Record<string, unknown>) => {
  const now = Math.floor(Date.now() / 1000), head = b64u({ alg: 'RS256', kid: 'kc1', typ: 'JWT' }), body = b64u({ iss: ISS, aud: 'ao-admin-console', iat: now, exp: now + 300, ...c });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
};
/** codes the fake Keycloak will redeem: code → what it was issued for. */
const codes = new Map<string, { challenge: string; nonce: string; claims: Record<string, unknown> }>();
let tokenCalls = 0;

let web: ChildProcess, kc: Server, api: Server, base: string, port: number, owner: pg.Client, ro: pg.Pool, adm: pg.Pool, app: pg.Pool;
const created: string[] = [];
let output = '';

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  // fake Keycloak: key set + token endpoint
  kc = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.endsWith('/certs')) { res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'kc1', alg: 'RS256', use: 'sig' }] })); return; }
    if (u.pathname.endsWith('/token') && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        tokenCalls++;
        const f = new URLSearchParams(b), issued = codes.get(f.get('code') ?? '');
        const bad = (e: string) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e })); };
        if (!issued) return bad('invalid_grant');
        codes.delete(f.get('code')!);   // a code works once
        if (f.get('client_id') !== 'ao-admin-console' || f.get('client_secret') !== CONSOLE_SECRET) return bad('unauthorized_client');
        if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== issued.challenge) return bad('invalid_grant');
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id_token: idToken({ nonce: issued.nonce, ...issued.claims }), access_token: 'x', token_type: 'Bearer' }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => kc.listen(0, '127.0.0.1', r));
  const kcPort = (kc.address() as AddressInfo).port;
  ISS = `http://127.0.0.1:${kcPort}/realms/agentic-office`;
  const v = new JwksVerifier({ issuer: ISS, audience: ['agentic-office-desktop', 'ao-admin-console'], jwksUrl: `${ISS}/protocol/openid-connect/certs`, algs: ['RS256'] });
  const sync = syncHandler({ app, keycloak: { issuer: ISS, verify: (t) => v.verify(t) }, exchangeLimit: 10_000 });
  const admin = adminHandler({ ro, admin: adm, tokens: parseTokens(`console:${SERVICE_TOKEN}`) });
  api = createServer((req, res) => { void sync(req, res).then((h) => { if (!h) return admin(req, res); }); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiPort = (api.address() as AddressInfo).port;
  port = await free(); base = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', AUTH_BASE_URL: base, AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef', AUTH_DATABASE_URL: as('ao_auth', process.env.AO_AUTH_PASSWORD),
      AO_ADMIN_API_URL: `http://127.0.0.1:${apiPort}`, AO_ADMIN_API_TOKEN: SERVICE_TOKEN, ADMIN_HOSTS: '127.0.0.1', KEYCLOAK_ISSUER: ISS, KEYCLOAK_CONSOLE_SECRET: CONSOLE_SECRET,
      // Compose passes every unset setting as an EMPTY string; an empty value must mean "use the default", not "set to nothing".
      AO_SYNC_API_URL: '', KEYCLOAK_INTERNAL_URL: '', KEYCLOAK_CONSOLE_CLIENT_ID: '' },
  });
  web.stdout?.on('data', (d) => { output += d; }); web.stderr?.on('data', (d) => { output += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`next did not start:\n${output}`);
});
after(async () => {
  if (skip) return;
  web?.kill('SIGTERM');
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  kc?.close(); api?.close();
  await Promise.all([owner?.end(), ro?.end(), adm?.end(), app?.end()]);
});

type Res = { status: number; location: string | null; body: string; setCookie: string[] };
const get = (path: string, o: { cookie?: string; host?: string } = {}) => new Promise<Res>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.host ? { host: o.host } : {}) } }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, body, setCookie: (res.headers['set-cookie'] as string[]) ?? [] }));
  });
  req.on('error', reject); req.end();
});
const post = (path: string, cookie?: string) => new Promise<Res>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-length': 0 } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, body, setCookie: (res.headers['set-cookie'] as string[]) ?? [] }));
  });
  req.on('error', reject); req.end();
});
const jar = (r: Res) => r.setCookie.map((c) => c.split(';')[0]).filter((c) => !/=\s*$/.test(c)).join('; ');
let n = 0;
async function makeUser(role: 'user' | 'admin', status = 'active', verified = true) {
  const id = `usr_kc${role}${++n}${tag}`, email = `${role}${n}.${tag}@example.test`, sub = `kc-sub-${tag}-${n}`;
  await owner.query(`INSERT INTO users(id, email, display_name, role, status, email_verified) VALUES ($1,$2,$3,$4,$5,$6)`, [id, email, `Name ${n}`, role, status, verified]);
  await owner.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject) VALUES ($1,$2,'keycloak',$3)`, [`oa_kc${n}${tag}`, id, sub]);
  created.push(id);
  return { id, email, sub };
}
/** Start a sign-in the way a browser would, and let the fake Keycloak issue a code for `claims`. */
async function startLogin(claims: Record<string, unknown>, next = '/admin/users') {
  const l = await get(`/admin/login?next=${encodeURIComponent(next)}`);
  assert.equal(l.status, 303, l.body.slice(0, 200));
  const u = new URL(l.location!);
  const code = randomBytes(8).toString('hex');
  codes.set(code, { challenge: u.searchParams.get('code_challenge')!, nonce: u.searchParams.get('nonce')!, claims });
  return { url: u, code, state: u.searchParams.get('state')!, cookie: jar(l), response: l };
}

test('an unsigned-in visitor is sent to Keycloak, with PKCE, state and nonce, and a signed login cookie', { skip }, async () => {
  const r = await get('/admin/users');
  assert.equal(r.status, 307); assert.match(r.location!, /\/admin\/login\?next=/);
  const l = await startLogin({});
  assert.equal(l.url.origin + l.url.pathname, `${ISS}/protocol/openid-connect/auth`);
  const q = l.url.searchParams;
  assert.deepEqual([q.get('client_id'), q.get('response_type'), q.get('code_challenge_method'), q.get('redirect_uri')], ['ao-admin-console', 'code', 'S256', `${base}/admin/callback`]);
  assert.ok(q.get('state')!.length >= 24 && q.get('nonce')!.length >= 24);
  const set = l.response.setCookie.join(';');
  assert.match(set, /ao_admin_login=/); assert.match(set, /HttpOnly/i); assert.match(set, /SameSite=lax/i);
});

test('an admin signs in and gets a console session; the page shows who they are; the device token the sign-in minted is revoked', { skip }, async () => {
  const a = await makeUser('admin');
  const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true, name: 'Name' }, '/admin/users');
  const cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.equal(cb.status, 303, cb.body.slice(0, 200)); assert.equal(new URL(cb.location!).pathname, '/admin/users');
  const session = jar(cb);
  assert.match(session, /ao_admin_session=/);
  assert.match(cb.setCookie.join(';'), /ao_admin_session=[^;]+;.*HttpOnly/i);
  const page = await get('/admin/users', { cookie: session });
  assert.equal(page.status, 200, page.body.slice(0, 200)); assert.ok(page.body.includes(a.email));
  const tokens = (await owner.query(`SELECT revoked_at FROM device_tokens WHERE user_id = $1 AND device_name = 'admin console'`, [a.id])).rows;
  assert.ok(tokens.length >= 1 && tokens.every((t) => t.revoked_at), 'the console keeps no device token');
  assert.equal((await get('/admin/users', {})).status, 307, 'and without the cookie there is no session');
});

test('someone who is not an admin gets no session; neither does a disabled person or an unverified email on an existing account', { skip }, async () => {
  const plain = await makeUser('user');
  let l = await startLogin({ sub: plain.sub, email: plain.email, email_verified: true });
  let cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(cb.location!, /denied=1/); assert.equal(jar(cb).includes('ao_admin_session'), false);
  const off = await makeUser('admin', 'disabled');
  l = await startLogin({ sub: off.sub, email: off.email, email_verified: true });
  cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(cb.location!, /disabled=1/); assert.equal(jar(cb).includes('ao_admin_session'), false);
  const owned = await makeUser('admin');
  l = await startLogin({ sub: `someone-else-${tag}`, email: owned.email, email_verified: false });
  cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(cb.location!, /unverified/); assert.equal(jar(cb).includes('ao_admin_session'), false, 'typing an admin\'s address into a sign-up does not make you them');
});

test('state must match this browser; a code is used once; a cancelled or failed sign-in ends cleanly', { skip }, async () => {
  const a = await makeUser('admin');
  const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true });
  const wrong = await get(`/admin/callback?code=${l.code}&state=not-the-state`, { cookie: l.cookie });
  assert.match(wrong.location!, /signin=expired/); assert.equal(jar(wrong).includes('ao_admin_session'), false);
  const calls = tokenCalls;
  const noCookie = await get(`/admin/callback?code=${l.code}&state=${l.state}`);
  assert.match(noCookie.location!, /signin=expired/); assert.equal(tokenCalls, calls, 'a callback without our cookie never reaches Keycloak');
  const ok = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.equal(ok.status, 303); assert.ok(jar(ok).includes('ao_admin_session'));
  const replay = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(replay.location!, /signin=failed/, 'the same code twice');
  const l2 = await startLogin({});
  assert.match((await get(`/admin/callback?error=access_denied&state=${l2.state}`, { cookie: l2.cookie })).location!, /signin=cancelled/);
});

test('a forged or edited session cookie is no session', { skip }, async () => {
  const a = await makeUser('admin');
  const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true });
  const cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  const real = /ao_admin_session=([^;]+)/.exec(cb.setCookie.join(';'))![1];
  const [body, sig] = real.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), id: 'usr_someoneelse' })).toString('base64url');
  for (const bad of [`${edited}.${sig}`, `${body}.${sig.slice(0, -2)}xx`, 'x.y', body, '']) assert.equal((await get('/admin/users', { cookie: `ao_admin_session=${bad}` })).status, 307, bad.slice(0, 20));
});

test('every request re-asks the API: a demoted or disabled admin loses the console on their next click', { skip }, async () => {
  for (const change of [`role = 'user'`, `status = 'disabled'`]) {
    const a = await makeUser('admin');
    const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true });
    const session = jar(await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie }));
    assert.equal((await get('/admin/users', { cookie: session })).status, 200);
    await owner.query(`UPDATE users SET ${change} WHERE id = $1`, [a.id]);
    const after = await get('/admin/users', { cookie: session });
    assert.equal(after.status, 307, change); assert.match(after.location!, /denied=1/);
  }
});

test('the sign-in routes exist only on the private hostnames, and sign-out ends the session and Keycloak\'s', { skip }, async () => {
  for (const p of ['/admin/login', '/admin/callback?code=x&state=y']) assert.equal((await get(p, { host: 'public.example.test' })).status, 404, p);
  assert.equal((await post('/admin/logout', undefined)).status, 303);
  const a = await makeUser('admin');
  const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true });
  const session = jar(await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie }));
  const out = await post('/admin/logout', session);
  assert.equal(out.status, 303);
  const to = new URL(out.location!);
  assert.equal(to.origin + to.pathname, `${ISS}/protocol/openid-connect/logout`); assert.equal(to.searchParams.get('client_id'), 'ao-admin-console');
  assert.match(out.setCookie.join(';'), /ao_admin_session=;/);
  assert.notEqual((await get('/admin/logout', { cookie: session })).status, 303, 'a link or an image cannot sign anyone out (post only)');
});

test('a failed sign-in ends on a page that says so and offers Keycloak again, never the old sign-in page', { skip }, async () => {
  const home = await get('/?signin=expired');
  assert.equal(home.status, 200);
  assert.match(home.body, /took too long/); assert.match(home.body, /href="\/admin\/login"/); assert.doesNotMatch(home.body, /href="\/sign-in"/);
  assert.match((await get('/?signin=unverified')).body, /already exists/);
  assert.match((await get('/?denied=1')).body, /for administrators/);
});

test('already signed in: the sign-in link goes straight where they were headed, without another trip to Keycloak', { skip }, async () => {
  const a = await makeUser('admin');
  const l = await startLogin({ sub: a.sub, email: a.email, email_verified: true });
  const session = jar(await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie }));
  const again = await get('/admin/login?next=%2Fadmin%2Fbilling', { cookie: session });
  assert.equal(again.status, 303); assert.equal(new URL(again.location!).pathname, '/admin/billing', 'straight to the page');
  assert.equal(again.setCookie.some((c) => c.startsWith('ao_admin_login=')), false, 'no new login started');
  assert.equal((await get('/admin/login?next=%2Fadmin%2Fbilling', { cookie: 'ao_admin_session=forged.value' })).location!.startsWith(ISS), true, 'a forged session cookie does not count as signed in');
  assert.equal(new URL((await get('/admin/login?next=https%3A%2F%2Fevil.example%2F', { cookie: session })).location!).pathname, '/admin', 'and the destination can only be a page of the console');
});

const postForm = (path: string, fields: Record<string, string>, cookie?: string) => new Promise<Res>((resolve, reject) => {
  const data = new URLSearchParams(fields).toString();
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, body, setCookie: (res.headers['set-cookie'] as string[]) ?? [] }));
  });
  req.on('error', reject); req.write(data); req.end();
});

test('a person who is turned away can ask to be let in; an administrator sees it, approves it, and then they get in', { skip }, async () => {
  const asker = await makeUser('user');
  let l = await startLogin({ sub: asker.sub, email: asker.email, email_verified: true });
  let cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(cb.location!, /denied=1/);
  const ask = jar(cb);
  assert.match(ask, /ao_access_ask=/); assert.equal(ask.includes('ao_admin_session'), false, 'being turned away grants nothing');
  assert.match(cb.setCookie.join(';'), /ao_access_ask=[^;]+;.*HttpOnly/i);
  // the landing page offers the request to them, and to nobody without the cookie
  const withForm = await get('/?denied=1', { cookie: ask });
  assert.match(withForm.body, /Request admin access/); assert.ok(withForm.body.includes(asker.email));
  assert.equal((await get('/?denied=1')).body.includes('Request admin access'), false);
  // nothing without our cookie, and a forged cookie is nothing
  assert.match((await postForm('/request-access', { note: 'x' })).location!, /signin=expired/);
  assert.match((await postForm('/request-access', { note: 'x' }, 'ao_access_ask=eyJpZCI6InVzcl9ldmlsIn0.AAAA')).location!, /signin=expired/);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM access_requests WHERE user_id = 'usr_evil'`)).rows[0].n, 0);
  // the real request, twice
  const one = await postForm('/request-access', { note: 'I run billing for the beta' }, ask);
  assert.equal(one.status, 303); assert.match(one.location!, /requested=1/);
  await postForm('/request-access', { note: 'again' }, ask);
  const rows = (await owner.query(`SELECT id, note, status FROM access_requests WHERE user_id = $1`, [asker.id])).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].note, 'I run billing for the beta'); assert.equal(rows[0].status, 'pending');
  assert.match((await get('/?requested=1', { cookie: ask })).body, /Request sent/);
  // an administrator sees it in the console and in the notifications
  const boss = await makeUser('admin');
  l = await startLogin({ sub: boss.sub, email: boss.email, email_verified: true });
  const session = jar(await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie }));
  const page = await get('/admin/access', { cookie: session });
  assert.equal(page.status, 200); assert.ok(page.body.includes(asker.email)); assert.match(page.body, /Approve/); assert.match(page.body, /I run billing for the beta/);
  assert.match((await get('/admin/notifications', { cookie: session })).body, /asking for admin access/);
  // approve (as the console's button does, through the API) and they get a console
  const ok = await fetch(`${(api.address() as AddressInfo) ? `http://127.0.0.1:${(api.address() as AddressInfo).port}` : ''}/admin/access-requests/${rows[0].id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${SERVICE_TOKEN}`, 'x-ao-acting-admin': boss.id, 'content-type': 'application/json' }, body: JSON.stringify({ admin_role: 'analyst' }) });
  assert.equal(ok.status, 200);
  l = await startLogin({ sub: asker.sub, email: asker.email, email_verified: true }, '/admin/access');
  cb = await get(`/admin/callback?code=${l.code}&state=${l.state}`, { cookie: l.cookie });
  assert.match(jar(cb), /ao_admin_session=/, 'once approved they sign in to the console');
  const mine = await get('/admin/access', { cookie: jar(cb) });
  assert.equal(mine.status, 200);
});

test('Better Auth is retired: with Keycloak on, its sign-in, authenticator, consent and API do not exist', { skip }, async () => {
  for (const p of ['/sign-in', '/mfa', '/consent', '/api/auth/sign-in/email', '/api/auth/get-session', '/api/auth/.well-known/openid-configuration']) {
    const r = await get(p, { host: '127.0.0.1' });
    assert.equal(r.status, 404, `${p} answered ${r.status}`);
  }
  assert.equal((await postForm('/api/auth/sign-in/email', { email: 'a@b.test', password: 'x' })).status, 404);
  assert.equal((await get('/')).status, 200, 'the landing page and the Keycloak sign-in still work');
});

test('someone who is not signed in is sent to sign in and comes back to the page they asked for', { skip }, async () => {
  for (const p of ['/admin/payments', '/admin/access', '/admin/users?q=ann', '/admin']) {
    const r = await get(p);
    assert.equal(r.status, 307, p);
    assert.equal(new URL(r.location!, base).searchParams.get('next'), p, `${p} keeps its address through sign-in`);
  }
  // a header sent by the browser cannot point the sign-in somewhere else: the proxy overwrites it, and anything outside /admin falls back
  const evil = await new Promise<Res>((resolve, reject) => { const req = httpRequest({ host: '127.0.0.1', port, path: '/admin/payments', headers: { 'x-ao-path': 'https://evil.example/' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, body: '', setCookie: [] })); }); req.on('error', reject); req.end(); });
  assert.equal(new URL(evil.location!, base).searchParams.get('next'), '/admin/payments');
});
