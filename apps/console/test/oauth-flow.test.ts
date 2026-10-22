// The desktop sign-in end to end, against a live database that has all of accounts-sync's migrations:
//   sign up → browser session → authorization code + PKCE → tokens → our verifier → accounts-sync exchange → device token.
// Better Auth runs for real (as the least-privilege ao_auth role); only the Google/Microsoft redirects are not covered,
// because they need those providers' credentials.
//   AUTH_TEST_PG=postgres://ao_owner:…@host/db  AO_AUTH_PASSWORD=…  AO_APP_PASSWORD=…
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { toNodeHandler } from 'better-auth/node';
import pg from 'pg';
import { JwksVerifier } from '../../../services/api/src/auth/jwks.ts';
import { syncHandler } from '../../../services/api/src/api/sync.ts';
import { createAuth, DESKTOP_CLIENT_ID } from '../src/lib/auth';

const ownerUrl = process.env.AUTH_TEST_PG;
const skip = !ownerUrl && 'AUTH_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);

let authServer: Server, apiServer: Server, base: string, apiBase: string;
let owner: pg.Client, authPool: pg.Pool, appPool: pg.Pool, auth: ReturnType<typeof createAuth>;
const emails: string[] = [];

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  authPool = new pg.Pool({ connectionString: as('ao_auth', process.env.AO_AUTH_PASSWORD) });
  appPool = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  // The auth service on a real port: its base URL is its issuer, as in production.
  const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>((r) => probe.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  auth = createAuth({ pool: authPool, baseURL: base, secret: 'test-secret-0123456789abcdef0123456789abcdef' });
  authServer = createServer(toNodeHandler(auth));
  await new Promise<void>((r) => authServer.listen(port, '127.0.0.1', r));
  const verifier = new JwksVerifier({ issuer: base, audience: DESKTOP_CLIENT_ID, jwksUrl: `${base}/api/auth/jwks` });
  const sync = syncHandler({ app: appPool, verifyIdToken: (t) => verifier.verify(t) });
  apiServer = createServer(async (req, res) => { if (!(await sync(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
  authServer.close(); apiServer.close();
  await Promise.all([owner.end(), authPool.end(), appPool.end()]);
});

const b64u = (b: Buffer) => b.toString('base64url');
const pkce = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) }; };
const REDIRECT = 'http://127.0.0.1:53211/callback';

/** Signs up a person; returns their session cookie and user id. */
async function signUp(name: string, password = 'a-long-enough-password') {
  const email = `${name}.${tag}@example.test`;
  emails.push(email);
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email, password, name }) });
  const body = await r.json() as { user?: { id: string } };
  return { status: r.status, email, password, id: body.user?.id as string, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}
async function signIn(email: string, password: string) {
  const r = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email, password }) });
  return { status: r.status, body: await r.json() as any, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') };
}
function authorizeUrl(o: { challenge?: string; method?: string; redirect?: string; nonce?: string; state?: string; client?: string; scope?: string }) {
  const q = new URLSearchParams({ response_type: 'code', client_id: o.client ?? DESKTOP_CLIENT_ID, redirect_uri: o.redirect ?? REDIRECT, scope: o.scope ?? 'openid profile email offline_access', state: o.state ?? 'st1', nonce: o.nonce ?? 'nonce-1' });
  if (o.challenge) { q.set('code_challenge', o.challenge); q.set('code_challenge_method', o.method ?? 'S256'); }
  return `${base}/api/auth/oauth2/authorize?${q}`;
}
// What a browser sends when it follows the link. fetch() overwrites sec-fetch-mode, so use a raw request:
// the provider answers a navigation with a real redirect (and an API client with JSON).
const authorize = (cookie: string | null, url: string) => new Promise<{ status: number; headers: { get(k: string): string | null } }>((resolve, reject) => {
  const u = new URL(url);
  const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml', ...(cookie ? { cookie } : {}) } }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } } }));
  });
  req.on('error', reject); req.end();
});
async function getCode(cookie: string, o: Parameters<typeof authorizeUrl>[0]) {
  const r = await authorize(cookie, authorizeUrl(o));
  const loc = r.headers.get('location') ?? '';
  return { status: r.status, loc, code: loc.startsWith(REDIRECT) ? new URL(loc).searchParams.get('code') : null, state: loc.startsWith(REDIRECT) ? new URL(loc).searchParams.get('state') : null };
}
const token = (params: Record<string, string>) => fetch(`${base}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
  .then(async (r) => ({ status: r.status, body: await r.json() as any }));
const redeem = (code: string, verifier: string, redirect = REDIRECT) => token({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: DESKTOP_CLIENT_ID, code_verifier: verifier });
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const exchange = async (idToken: string, nonce: string) => {
  const r = await fetch(`${apiBase}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken, nonce, device_name: 'e2e-mac', platform: 'darwin' }) });
  return { status: r.status, body: await r.json() as any };
};

test('sign-up creates a person in accounts-sync\'s users table with a usr_ id, as the least-privilege role', { skip }, async () => {
  const u = await signUp('first');
  assert.equal(u.status, 200);
  assert.match(u.id, /^usr_[0-9a-z]{26}$/);
  const row = (await owner.query('SELECT id, email, display_name, role, status, email_verified FROM users WHERE id = $1', [u.id])).rows[0];
  assert.deepEqual([row.email, row.display_name, row.role, row.status], [u.email, 'first', 'user', 'active']);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = $1 AND provider_id = $2', [u.id, 'credential'])).rows[0].n, 1);
  assert.ok((await owner.query('SELECT password FROM auth_accounts WHERE user_id = $1', [u.id])).rows[0].password.length > 30, 'a password hash, never the password');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1', [u.id])).rows[0].n, 1);
  assert.equal((await signUp('first')).status >= 400, true, 'the same email cannot sign up twice');
  assert.equal((await signUp('shortpw', 'short')).status >= 400, true, 'a short password is refused');
});

test('the whole desktop flow: authorize with PKCE → tokens → verify → exchange → a device token that works', { skip }, async () => {
  const u = await signUp('flow');
  const { verifier, challenge } = pkce();
  const a = await getCode(u.cookie, { challenge, nonce: 'n-flow', state: 'state-flow' });
  assert.equal(a.status, 302, a.loc);
  assert.ok(a.code, `no code in ${a.loc}`);
  assert.equal(a.state, 'state-flow', 'the state comes back');
  const t = await redeem(a.code!, verifier);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(t.body.id_token && t.body.refresh_token && t.body.access_token);
  const c = claimsOf(t.body.id_token);
  assert.deepEqual([c.sub, c.aud, c.iss, c.nonce, c.email], [u.id, DESKTOP_CLIENT_ID, base, 'n-flow', u.email]);
  assert.ok(c.exp - c.iat <= 600, 'ID tokens are short-lived');
  const x = await exchange(t.body.id_token, 'n-flow');
  assert.equal(x.status, 200, JSON.stringify(x.body));
  assert.equal(x.body.user.id, u.id);
  const me = await fetch(`${apiBase}/v1/me`, { headers: { authorization: `Bearer ${x.body.token}` } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as any).user.email, u.email);
  assert.equal((await exchange(t.body.id_token, 'a-different-nonce')).status, 401, 'another device\'s nonce is refused');
});

test('without a browser session the authorize step sends the person to sign in, not to a code', { skip }, async () => {
  const { challenge } = pkce();
  const r = await authorize(null, authorizeUrl({ challenge }));
  assert.equal(r.status, 302);
  const loc = r.headers.get('location') ?? '';
  assert.ok(loc.includes('/sign-in'), loc);
  assert.ok(!loc.startsWith(REDIRECT), 'no code is issued to a signed-out browser');
});

test('PKCE is mandatory and checked: no challenge, plain, a wrong verifier and a replayed code all fail', { skip }, async () => {
  const u = await signUp('pkce');
  const none = await getCode(u.cookie, {});
  assert.equal(none.code, null, 'no code without a challenge');
  const plain = await getCode(u.cookie, { challenge: 'plainchallenge-0123456789-0123456789-0123456789', method: 'plain' });
  assert.equal(plain.code, null, 'plain is not accepted');
  const { verifier, challenge } = pkce();
  const a = await getCode(u.cookie, { challenge });
  assert.ok(a.code);
  assert.notEqual((await redeem(a.code!, b64u(randomBytes(32)))).status, 200, 'a wrong verifier');
  const again = await getCode(u.cookie, { challenge });
  assert.equal((await redeem(again.code!, verifier)).status, 200);
  assert.notEqual((await redeem(again.code!, verifier)).status, 200, 'a code works once');
});

test('only the registered loopback redirect is honoured, and only for the desktop client', { skip }, async () => {
  const u = await signUp('redir');
  const { challenge } = pkce();
  for (const redirect of ['http://evil.test/callback', 'https://127.0.0.1:53211/callback', 'http://127.0.0.1:53211/other', 'http://localhost.evil.test:80/callback', 'agentic-office://x']) {
    const r = await authorize(u.cookie, authorizeUrl({ challenge, redirect }));
    const loc = r.headers.get('location') ?? '';
    assert.ok(!/[?&]code=/.test(loc), `${redirect} got a code: ${loc}`);
  }
  assert.ok(!(await getCode(u.cookie, { challenge, client: 'someone-elses-app' })).code, 'an unknown client');
  // Any loopback port is fine (the desktop app picks a free one).
  const a = await authorize(u.cookie, authorizeUrl({ challenge, redirect: 'http://127.0.0.1:60999/callback' }));
  assert.match(a.headers.get('location') ?? '', /^http:\/\/127\.0\.0\.1:60999\/callback\?code=/);
});

test('a refresh token renews the session, and rotating it makes the old one useless', { skip }, async () => {
  const u = await signUp('refresh');
  const { verifier, challenge } = pkce();
  const a = await getCode(u.cookie, { challenge });
  const t = await redeem(a.code!, verifier);
  const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: DESKTOP_CLIENT_ID });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.ok(r1.body.id_token);
  assert.notEqual(r1.body.refresh_token, t.body.refresh_token, 'refresh tokens rotate');
  const replay = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: DESKTOP_CLIENT_ID });
  assert.notEqual(replay.status, 200, 'the rotated token is dead');
});

test('wrong passwords and unknown people get the same refusal', { skip }, async () => {
  const u = await signUp('pw');
  const bad = await signIn(u.email, 'not-the-right-password');
  const unknown = await signIn(`nobody.${tag}@example.test`, 'not-the-right-password');
  assert.equal(bad.status, unknown.status);
  assert.ok(bad.status >= 400);
  assert.equal(bad.body.message, unknown.body.message, 'no hint about which emails exist');
  assert.equal((await signIn(u.email, u.password)).status, 200);
});

test('a disabled account cannot sign in or exchange, and a deleted one neither', { skip }, async () => {
  const u = await signUp('off');
  const { verifier, challenge } = pkce();
  const t = await redeem((await getCode(u.cookie, { challenge, nonce: 'n-off' })).code!, verifier);
  assert.equal(t.status, 200);
  await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
  const blocked = await signIn(u.email, u.password);
  assert.ok(blocked.status >= 400, 'no new session');
  const x = await exchange(t.body.id_token, 'n-off');
  assert.equal(x.status, 403, 'the ID token they already hold buys nothing');
  assert.match(x.body.error, /disabled/);
  await owner.query(`UPDATE users SET status = 'deleted' WHERE id = $1`, [u.id]);
  assert.equal((await exchange(t.body.id_token, 'n-off')).status, 403);
  await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [u.id]);
  assert.equal((await signIn(u.email, u.password)).status, 200, 'and enabling restores sign-in');
});

test('the JWKS is public and the private key never leaves the database in the clear', { skip }, async () => {
  const j = await (await fetch(`${base}/api/auth/jwks`)).json() as { keys: Array<Record<string, string>> };
  assert.ok(j.keys.length >= 1);
  for (const k of j.keys) { assert.equal(k.d, undefined, 'no private part'); assert.ok(k.kid); }
  const row = (await owner.query('SELECT "privateKey" FROM jwks LIMIT 1')).rows[0];
  assert.ok(!/"d"\s*:/.test(row.privateKey), 'the stored private key is encrypted');
});

test('the sign-in service role can do sign-in and nothing else', { skip }, async () => {
  const q = (sql: string) => authPool.query(sql);
  await assert.rejects(q('SELECT 1 FROM credit_ledger'), /permission denied/);
  await assert.rejects(q('SELECT 1 FROM coupons'), /permission denied/);
  await assert.rejects(q('SELECT 1 FROM device_tokens'), /permission denied/);
  await assert.rejects(q('SELECT 1 FROM session_events'), /permission denied/);
  await assert.rejects(q('SELECT 1 FROM admin_audit'), /permission denied/);
  await assert.rejects(q('DELETE FROM users'), /permission denied/);
  await assert.rejects(q(`UPDATE users SET role = 'admin'`), /permission denied/);
  await assert.rejects(q(`UPDATE users SET status = 'active'`), /permission denied/);
  await assert.rejects(q(`UPDATE users SET clerk_user_id = 'x'`), /permission denied/);
  assert.ok((await q('SELECT count(*) FROM users')).rowCount === 1);
});

test('nobody can make themselves an admin through sign-up', { skip }, async () => {
  const email = `evil.${tag}@example.test`; emails.push(email);
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: 'a-long-enough-password', name: 'evil', role: 'admin', status: 'active', email_verified: true, emailVerified: true }) });
  const row = (await owner.query('SELECT role, email_verified FROM users WHERE email = $1', [email])).rows[0];
  if (r.status === 200) assert.deepEqual([row.role, row.email_verified], ['user', false]);
  else assert.ok(!row);
});
