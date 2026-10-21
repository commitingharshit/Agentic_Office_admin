// Sign-in through Keycloak at the API: the desktop app sends Keycloak's ID token (and the nonce it chose); the API maps it to a person.
// Keycloak is faked with a local signer and key server, so only our mapping and refusals are under test (a real Keycloak is exercised by
// scripts/dev/keycloak-check.mjs). The cases that protect people: the same identity is the same person every time, an existing account
// is joined only through a VERIFIED email, and nothing is created or linked on a refusal.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { JwksVerifier } from '../src/auth/jwks.ts';
import { syncHandler } from '../src/api/sync.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const ISS = `https://kc.test/realms/agentic-office-${tag}`, CLIENT = 'agentic-office-desktop';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(c: Record<string, unknown>, o: { iss?: string; aud?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', kid: 'kc1', typ: 'JWT' });
  const body = b64u({ iss: o.iss ?? ISS, aud: o.aud ?? CLIENT, iat: now, exp: now + 300, ...c });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
}
let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, v2: JwksVerifier;
const made: string[] = [];

before(async () => {
  if (skip) return;
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'kc1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const v = v2 = new JwksVerifier({ issuer: ISS, audience: [CLIENT, 'ao-admin-console'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`, algs: ['RS256'] });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  const sync = syncHandler({ app, keycloak: { issuer: ISS, verify: (t) => v.verify(t) }, oauth: { issuer: ISS, authorization_endpoint: `${ISS}/protocol/openid-connect/auth`, token_endpoint: `${ISS}/protocol/openid-connect/token`, client_id: CLIENT }, exchangeLimit: 10_000 });
  api = createServer((req, res) => { void sync(req, res).then((h) => { if (!h) res.writeHead(404).end(); }); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [made]);
  api.close(); jwks.close();
  await Promise.all([app.end(), owner.end()]);
});

const exchange = async (token: string, nonce: string | null = 'n1') => {
  const r = await fetch(`${base}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: token, nonce, device_name: 'kc-test', platform: 'darwin' }) });
  const body = (await r.json()) as any;
  if (r.status === 200) made.push(body.user.id);
  return { status: r.status, body };
};
const rows = async (sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows;
let n = 0;
const sub = () => `kc-${tag}-${++n}`;

test('the app is told to sign in at Keycloak', { skip }, async () => {
  const r = await fetch(`${base}/v1/auth/config`); const b = (await r.json()) as any;
  assert.equal(b.oauth.issuer, ISS); assert.equal(b.oauth.client_id, CLIENT); assert.ok(b.oauth.authorization_endpoint.startsWith(ISS));
});

test('a new person is created once, and the same Keycloak identity is the same person on every later sign-in', { skip }, async () => {
  const s = sub(), email = `new.${tag}.${n}@example.test`;
  const a = await exchange(mint({ sub: s, nonce: 'n1', email, email_verified: true, name: 'New Person' }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(a.body.token.startsWith('aod_')); assert.match(a.body.user.id, /^usr_/); assert.equal(a.body.user.email, email);
  const u = (await rows('SELECT email_verified, display_name FROM users WHERE id = $1', [a.body.user.id]))[0];
  assert.deepEqual([u.email_verified, u.display_name], [true, 'New Person']);
  const b = await exchange(mint({ sub: s, nonce: 'n2', email, email_verified: true }), 'n2');
  assert.equal(b.body.user.id, a.body.user.id, 'same person');
  assert.equal(Number((await rows(`SELECT count(*) FROM oauth_accounts WHERE provider = 'keycloak' AND subject = $1`, [s]))[0].count), 1);
  // even if their email changed at Keycloak, they are still themselves
  const c = await exchange(mint({ sub: s, nonce: 'n3', email: `changed.${tag}@example.test`, email_verified: true }), 'n3');
  assert.equal(c.body.user.id, a.body.user.id);
});

test('an existing account is joined through a verified email, once, keeping its id and data', { skip }, async () => {
  const email = `old.${tag}@example.test`, uid = `usr_old${tag}`;
  await owner.query(`INSERT INTO users(id, email, display_name, role) VALUES ($1,$2,'Old Person','admin')`, [uid, email]);
  made.push(uid);
  const s = sub();
  const r = await exchange(mint({ sub: s, nonce: 'n1', email: email.toUpperCase(), email_verified: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.id, uid, 'their existing account, not a new one');
  assert.equal(r.body.user.role, 'admin', 'with its role intact');
  assert.equal(Number((await rows('SELECT count(*) FROM users WHERE lower(email) = $1', [email]))[0].count), 1, 'no duplicate');
  assert.equal((await rows('SELECT email_verified FROM users WHERE id = $1', [uid]))[0].email_verified, true);
  assert.equal((await exchange(mint({ sub: s, nonce: 'n2' }), 'n2')).body.user.id, uid, 'and from then on by identity alone');
});

test('an UNVERIFIED email never joins an existing account, and nothing is created or linked', { skip }, async () => {
  const email = `victim.${tag}@example.test`, uid = `usr_victim${tag}`;
  await owner.query(`INSERT INTO users(id, email, display_name) VALUES ($1,$2,'Victim')`, [uid, email]);
  made.push(uid);
  const s = sub();
  const r = await exchange(mint({ sub: s, nonce: 'n1', email, email_verified: false }));
  assert.equal(r.status, 409); assert.match(r.body.error, /already exists/);
  assert.equal(Number((await rows(`SELECT count(*) FROM oauth_accounts WHERE subject = $1`, [s]))[0].count), 0, 'no identity linked');
  assert.equal(Number((await rows('SELECT count(*) FROM users WHERE lower(email) = $1', [email]))[0].count), 1, 'no second account');
  const missing = await exchange(mint({ sub: sub(), nonce: 'n1', email, email_verified: undefined }));
  assert.equal(missing.status, 409, 'a token that does not say verified is treated as unverified');
});

test('a person with an unverified email and no existing account can still sign up', { skip }, async () => {
  const r = await exchange(mint({ sub: sub(), nonce: 'n1', email: `fresh.${tag}.${n}@example.test`, email_verified: false }));
  assert.equal(r.status, 200);
  assert.equal((await rows('SELECT email_verified FROM users WHERE id = $1', [r.body.user.id]))[0].email_verified, false);
});

test('a disabled account is refused, and a deleted one too', { skip }, async () => {
  for (const status of ['disabled', 'deleted']) {
    const s = sub(), uid = `usr_${status}${tag}`;
    await owner.query(`INSERT INTO users(id, email, status) VALUES ($1,$2,$3)`, [uid, `${status}.${tag}@example.test`, status]);
    made.push(uid);
    await owner.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject) VALUES ($1,$2,'keycloak',$3)`, [`oa_${status}${tag}`, uid, s]);
    const r = await exchange(mint({ sub: s, nonce: 'n1' }));
    assert.equal(r.status, 403, status);
  }
});

test('a token that is not for this sign-in is refused: wrong nonce, no nonce, wrong audience, wrong issuer, bad signature, expired', { skip }, async () => {
  const s = sub(), good = { sub: s, nonce: 'n1', email: `x.${tag}.${n}@example.test`, email_verified: true };
  assert.equal((await exchange(mint(good), 'other')).status, 401, 'nonce of another attempt');
  assert.equal((await exchange(mint(good), null)).status, 401, 'no nonce');
  assert.equal((await exchange(mint(good, { aud: 'someone-else' }))).status, 401, 'another app');
  assert.notEqual((await exchange(mint(good, { iss: 'https://evil.test/realms/x' }))).status, 200, 'another issuer');
  const t = mint(good); const [h, p, sig] = t.split('.');
  assert.equal((await exchange(`${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), email: 'attacker@example.test' })).toString('base64url')}.${sig}`)).status, 401, 'edited claims');
  assert.equal((await exchange(mint({ ...good, exp: Math.floor(Date.now() / 1000) - 600 }))).status, 401, 'expired');
  assert.equal(Number((await rows(`SELECT count(*) FROM oauth_accounts WHERE subject = $1`, [s]))[0].count), 0, 'none of that created anyone');
});

// ── the edge cases: not in the database, at the same moment, no email, again while signed in, and what goes into the database ──

test('two sign-ins for the same new person at the same moment make ONE account', { skip }, async () => {
  // Without an email there is no unique-email index to catch a duplicate: only the sign-in's own care keeps it to one account.
  const s = sub();
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => exchange(mint({ sub: s, nonce: `n${i}`, name: 'Racer' }), `n${i}`)));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(new Set(rs.map((r) => r.body.user.id)).size, 1, 'the same person every time');
  assert.equal(Number((await rows(`SELECT count(*) FROM oauth_accounts WHERE provider = 'keycloak' AND subject = $1`, [s]))[0].count), 1, 'one identity');
  assert.equal(Number((await rows(`SELECT count(DISTINCT user_id) FROM oauth_accounts WHERE provider = 'keycloak' AND subject = $1`, [s]))[0].count), 1);
  // and the same with an email, where the account is found or made once
  const s2 = sub(), email = `race.${tag}.${n}@example.test`;
  const rs2 = await Promise.all(Array.from({ length: 12 }, (_, i) => exchange(mint({ sub: s2, nonce: `m${i}`, email, email_verified: true }), `m${i}`)));
  assert.ok(rs2.every((r) => r.status === 200), JSON.stringify(rs2.map((r) => r.status)));
  assert.equal(Number((await rows('SELECT count(*) FROM users WHERE lower(email) = $1', [email]))[0].count), 1);
});

test('a person with no email at all can sign in, and is the same person next time', { skip }, async () => {
  const s = sub();
  const a = await exchange(mint({ sub: s, nonce: 'n1', name: 'No Email' }));
  assert.equal(a.status, 200); assert.equal(a.body.user.email, null);
  assert.equal((await exchange(mint({ sub: s, nonce: 'n2' }), 'n2')).body.user.id, a.body.user.id);
});

test('signing in again while already signed in adds a sign-in, keeps the person, and never grows without limit', { skip }, async () => {
  const s = sub(), email = `again.${tag}.${n}@example.test`;
  const first = await exchange(mint({ sub: s, nonce: 'a0', email, email_verified: true }), 'a0');
  const before = await fetch(`${base}/v1/credits/balance`, { headers: { authorization: `Bearer ${first.body.token}` } });
  assert.equal(before.status, 200);
  for (let i = 1; i <= 27; i++) await exchange(mint({ sub: s, nonce: `a${i}`, email, email_verified: true }), `a${i}`);
  const live = Number((await rows(`SELECT count(*) FROM device_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [first.body.user.id]))[0].count);
  assert.ok(live <= 25, `at most 25 live sign-ins (${live})`);
  assert.equal((await fetch(`${base}/v1/credits/balance`, { headers: { authorization: `Bearer ${first.body.token}` } })).status, 401, 'the oldest sign-in was ended to stay within the limit');
  assert.equal(Number((await rows('SELECT count(*) FROM users WHERE lower(email) = $1', [email]))[0].count), 1, 'still one person');
});

test('every sign-in is recorded for the person: through what, from which app, machine and address', { skip }, async () => {
  const s = sub(), email = `rec.${tag}.${n}@example.test`;
  const r = await exchange(mint({ sub: s, nonce: 'n1', email, email_verified: true }, { aud: 'ao-admin-console' }));
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 150));
  const ev = await rows('SELECT provider, client, device_name, platform, ip FROM sign_in_events WHERE user_id = $1', [r.body.user.id]);
  assert.equal(ev.length, 1); assert.deepEqual([ev[0].provider, ev[0].client, ev[0].device_name, ev[0].platform], ['keycloak', 'ao-admin-console', 'kc-test', 'darwin']);
  assert.ok(ev[0].ip, 'with the address the server saw');
});

test('a refused sign-in leaves nothing behind: no account, no identity, no record', { skip }, async () => {
  const s = sub(), email = `none.${tag}.${n}@example.test`;
  const before = Number((await rows('SELECT count(*) FROM sign_in_events'))[0].count);
  assert.equal((await exchange(mint({ sub: s, nonce: 'n1', email, email_verified: true }), 'wrong')).status, 401);
  assert.equal(Number((await rows('SELECT count(*) FROM users WHERE lower(email) = $1', [email]))[0].count), 0);
  assert.equal(Number((await rows(`SELECT count(*) FROM oauth_accounts WHERE subject = $1`, [s]))[0].count), 0);
  assert.equal(Number((await rows('SELECT count(*) FROM sign_in_events'))[0].count), before);
});

test('the sign-in answer carries the plan, with what it costs and gives; the plan list shows only plans that are on', { skip }, async () => {
  const email = `plan.${tag}.${n}@example.test`;
  const r = await exchange(mint({ sub: sub(), nonce: 'n1', email, email_verified: true }));
  assert.equal(r.body.entitlements.plan.id, 'free'); assert.equal(r.body.entitlements.plan.price_cents, 0); assert.equal(r.body.entitlements.managed_inference, false);
  const list = (await (await fetch(`${base}/v1/plans`, { headers: { authorization: `Bearer ${r.body.token}` } })).json()) as any;
  const ids = list.plans.map((p: any) => p.id);
  assert.ok(ids.includes('free') && ids.includes('beta')); assert.ok(!ids.includes('pro') && !ids.includes('max5x') && !ids.includes('max20x'), 'draft plans are not offered');
  assert.equal((await fetch(`${base}/v1/plans`)).status, 401);
});

test("the person's plan and role are handed to Keycloak at sign-in, once, and never trusted from a token", { skip }, async () => {
  const calls: Array<[string, Record<string, string>]> = [];
  const fakeAdmin = { setAttributes: async (sub: string, a: Record<string, string>) => { calls.push([sub, a]); } } as any;
  const sync2 = syncHandler({ app, keycloak: { issuer: ISS, verify: (t) => v2.verify(t) }, keycloakAdmin: fakeAdmin, exchangeLimit: 10_000 });
  const srv2 = createServer((req, res) => { void sync2(req, res).then((h) => { if (!h) res.writeHead(404).end(); }); });
  await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  const go = async (claims: Record<string, unknown>, nonce: string) => { const r = await fetch(`${b2}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: mint(claims), nonce, device_name: 'd', platform: 'p' }) }); const body = (await r.json()) as any; if (r.status === 200) made.push(body.user.id); return { status: r.status, body }; };
  try {
    const s = sub(), email = `attr.${tag}.${n}@example.test`;
    const a = await go({ sub: s, nonce: 'n1', email, email_verified: true }, 'n1');
    assert.equal(a.status, 200);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(calls, [[s, { ao_plan: 'free', ao_role: 'user' }]]);
    // a token that already carries the same plan and role: nothing to update
    calls.length = 0;
    await go({ sub: s, nonce: 'n2', email, email_verified: true, ao_plan: 'free', ao_role: 'user' }, 'n2');
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(calls.length, 0);
    // a token that CLAIMS admin does not make anyone admin: the database decides
    const forged = await go({ sub: s, nonce: 'n3', email, email_verified: true, ao_role: 'admin', ao_plan: 'beta' }, 'n3');
    assert.equal(forged.body.user.role, 'user'); assert.equal(forged.body.entitlements.plan.id, 'free');
  } finally { srv2.close(); }
});
