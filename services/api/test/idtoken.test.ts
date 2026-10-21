// Our own sign-in service's ID tokens: the JWKS verifier on its own, then the desktop exchange
// (`POST /v1/auth/exchange {id_token, nonce}`) against a live database (AO_TEST_PG + role passwords).
// The issuer is faked with local Ed25519 / RSA / EC keys and a JWKS server, so verification, nonce binding,
// the account checks and row-level security run for real.
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { JwksVerifier } from '../src/auth/jwks.ts';
import { syncHandler } from '../src/api/sync.ts';

const ISS = 'https://auth.agentic-office.test';
const AUD = 'agentic-office-desktop';
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ed25519');

type Alg = 'EdDSA' | 'RS256' | 'ES256' | 'HS256' | 'none';
function mint(claims: Record<string, unknown>, o: { alg?: Alg; kid?: string; key?: KeyObject; header?: Record<string, unknown> } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const alg = o.alg ?? 'EdDSA';
  const head = b64u({ alg, kid: o.kid ?? (alg === 'RS256' ? 'rsa1' : alg === 'ES256' ? 'ec1' : 'ed1'), typ: 'JWT', ...o.header });
  const body = b64u({ iss: ISS, aud: AUD, iat: now, exp: now + 300, ...claims });
  const data = Buffer.from(`${head}.${body}`);
  let sig: Buffer;
  if (alg === 'EdDSA') sig = cryptoSign(null, data, o.key ?? ed.privateKey);
  else if (alg === 'RS256') sig = cryptoSign('sha256', data, o.key ?? rsa.privateKey);
  else if (alg === 'ES256') sig = cryptoSign('sha256', data, { key: o.key ?? ec.privateKey, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'HS256') sig = createHmac('sha256', 'secret').update(data).digest();
  else sig = Buffer.alloc(0);
  return `${head}.${body}.${sig.toString('base64url')}`;
}
const jwk = (k: KeyObject, kid: string, extra: Record<string, unknown> = {}) => ({ ...k.export({ format: 'jwk' }), kid, ...extra });

let jwks: Server, jwksUrl: string, jwksHits = 0;
let served: Array<Record<string, unknown>>;
before(async () => {
  served = [jwk(ed.publicKey, 'ed1'), jwk(rsa.publicKey, 'rsa1'), jwk(ec.publicKey, 'ec1'), { kty: 'oct', kid: 'junk', k: 'AAAA' }];
  jwks = createServer((_q, res) => { jwksHits++; res.end(JSON.stringify({ keys: served })); });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks`;
});
after(() => { jwks.close(); });

const verifier = () => new JwksVerifier({ issuer: ISS, audience: AUD, jwksUrl });

test('verifier: EdDSA, RS256 and ES256 tokens from the issuer verify', async () => {
  const v = verifier();
  for (const alg of ['EdDSA', 'RS256', 'ES256'] as const) {
    const c = await v.verify(mint({ sub: 'usr_x', email: 'a@example.test', nonce: 'n1' }, { alg }));
    assert.deepEqual([c.sub, c.email, c.nonce], ['usr_x', 'a@example.test', 'n1'], alg);
  }
  assert.equal((await v.verify(mint({ sub: 'usr_x', aud: ['other', AUD] }))).sub, 'usr_x', 'the audience may be a list');
});

test('verifier: expired, not-yet-valid, wrong issuer, wrong audience, no subject are refused', async () => {
  const v = verifier();
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(v.verify(mint({ sub: 'u', exp: now - 60 })), /expired/);
  await assert.rejects(v.verify(mint({ sub: 'u', nbf: now + 600 })), /not yet valid/);
  await assert.rejects(v.verify(mint({ sub: 'u', iss: 'https://evil.test' })), /another sign-in service/);
  await assert.rejects(v.verify(mint({ sub: 'u', aud: 'some-other-client' })), /another app/);
  await assert.rejects(v.verify(mint({ sub: 'u', aud: undefined })), /another app/);
  await assert.rejects(v.verify(mint({ sub: '' })), /no user/);
  await assert.rejects(v.verify(mint({ sub: 7 as unknown as string })), /no user/);
});

test('verifier: forged, tampered and re-labelled tokens are refused', async () => {
  const v = verifier();
  await assert.rejects(v.verify(mint({ sub: 'u' }, { key: other.privateKey })), /signature/);
  const good = mint({ sub: 'usr_victim' });
  const [h, , s] = good.split('.');
  await assert.rejects(v.verify(`${h}.${b64u({ iss: ISS, aud: AUD, exp: 9_999_999_999, sub: 'usr_admin' })}.${s}`), /signature/);
  // algorithm confusion: none, HMAC, and an RSA key presented as EdDSA (and the reverse)
  await assert.rejects(v.verify(mint({ sub: 'u' }, { alg: 'none' })), /unsupported/);
  await assert.rejects(v.verify(mint({ sub: 'u' }, { alg: 'HS256' })), /unsupported/);
  await assert.rejects(v.verify(mint({ sub: 'u' }, { alg: 'EdDSA', kid: 'rsa1' })), /unsupported/);
  await assert.rejects(v.verify(mint({ sub: 'u' }, { alg: 'RS256', kid: 'ed1' })), /unsupported/);
  await assert.rejects(v.verify(mint({ sub: 'u' }, { kid: 'junk' })), /unknown key/);   // a key we could not read is not a key
  for (const junk of ['', 'a.b', 'a.b.c.d', 'not a token', `${b64u({ alg: 'EdDSA' })}.${b64u({})}.x`]) await assert.rejects(v.verify(junk), /sign-in token|unsupported/, junk);
});

test('verifier: a rotated key is picked up, but unknown key ids cannot make us hammer the issuer', async () => {
  const v = verifier();
  await v.verify(mint({ sub: 'u' }));
  const fresh = generateKeyPairSync('ed25519');
  const t = mint({ sub: 'u' }, { key: fresh.privateKey, kid: 'ed2' });
  await assert.rejects(v.verify(t), /unknown key/);            // not published yet
  served.push(jwk(fresh.publicKey, 'ed2'));
  // The refetch is throttled (30 s), so the new key is seen on the next allowed fetch; a new verifier has none of that state.
  assert.equal((await verifier().verify(t)).sub, 'u');
  const hitsBefore = jwksHits;
  const probe = verifier();
  await probe.verify(mint({ sub: 'u' }));
  for (let i = 0; i < 25; i++) await assert.rejects(probe.verify(mint({ sub: 'u' }, { kid: `junk${i}` })), /unknown key/);
  assert.ok(jwksHits - hitsBefore <= 3, `25 bad key ids caused ${jwksHits - hitsBefore} fetches`);
  served.pop();
});

// ── the exchange, with a database ───────────────────────────────────────────────────────────────
const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
let api: Server, base: string, owner: pg.Client, app: pg.Pool;
const created: string[] = [];

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  const sync = syncHandler({ app, verifyIdToken: (t) => verifier().verify(t), oauth: { issuer: ISS, authorization_endpoint: `${ISS}/a`, token_endpoint: `${ISS}/t`, client_id: AUD } });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  api.close();
  await Promise.all([app.end(), owner.end()]);
});

async function person(name: string, status = 'active'): Promise<string> {
  const id = `usr_${name}_${tag}`;
  await owner.query(`INSERT INTO users(id, email, display_name, status) VALUES ($1,$2,$3,$4)`, [id, `${name}.${tag}@example.test`, name, status]);
  created.push(id);
  return id;
}
const http = async (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  const r = await fetch(base + path, { ...rest, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, body: (await r.json()) as any };
};
const exchange = (body: Record<string, unknown>) => http('/v1/auth/exchange', { method: 'POST', body: JSON.stringify({ device_name: 'test-mac', platform: 'darwin', ...body }) });

test('the sign-in endpoints are advertised to the desktop app', { skip }, async () => {
  const c = await http('/v1/auth/config');
  assert.deepEqual(c.body.oauth, { issuer: ISS, authorization_endpoint: `${ISS}/a`, token_endpoint: `${ISS}/t`, client_id: AUD });
});

test('exchange: a valid ID token with this device\'s nonce becomes a working device token', { skip }, async () => {
  const id = await person('ok');
  const r = await exchange({ id_token: mint({ sub: id, nonce: 'nonce-ok-1', email: `new.${tag}@example.test`, name: 'Okay Person', picture: 'https://img.example.test/p.png' }), nonce: 'nonce-ok-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.token, /^aod_/);
  assert.equal(r.body.user.id, id);
  assert.equal(r.body.user.email, `new.${tag}@example.test`);
  assert.equal(r.body.user.avatar_url, 'https://img.example.test/p.png');
  const me = await http('/v1/me', { token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, id);
  const stored = (await owner.query('SELECT token_hash FROM device_tokens WHERE user_id = $1', [id])).rows[0].token_hash;
  assert.notEqual(stored, r.body.token);
});

test('exchange: the nonce binds the token to the sign-in this device started', { skip }, async () => {
  const id = await person('nonce');
  const t = mint({ sub: id, nonce: 'real-nonce' });
  for (const nonce of [undefined, '', 'someone-elses', 123]) assert.equal((await exchange({ id_token: t, nonce })).status, 401, String(nonce));
  const noNonceInToken = mint({ sub: id });
  assert.equal((await exchange({ id_token: noNonceInToken, nonce: 'anything' })).status, 401);
  assert.equal((await exchange({ id_token: noNonceInToken })).status, 401);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM device_tokens WHERE user_id=$1', [id])).rows[0].n, 0, 'no token was minted');
  assert.equal((await exchange({ id_token: t, nonce: 'real-nonce' })).status, 200);
});

test('exchange: tokens that do not verify, and people who do not exist or may not sign in, get no device token', { skip }, async () => {
  const gone = await person('gone', 'deleted'), off = await person('off', 'disabled');
  const n = { nonce: 'n' };
  assert.equal((await exchange({ ...n, id_token: mint({ sub: 'usr_nobody', ...n }) })).status, 401, 'a verified token for a user we do not have');
  assert.equal((await exchange({ ...n, id_token: mint({ sub: off, ...n }) })).status, 403);
  assert.match((await exchange({ ...n, id_token: mint({ sub: off, ...n }) })).body.error, /disabled/);
  assert.equal((await exchange({ ...n, id_token: mint({ sub: gone, ...n }) })).status, 403);
  assert.equal((await exchange({ ...n, id_token: mint({ sub: off, ...n }, { key: other.privateKey }) })).status, 401);
  assert.equal((await exchange({ ...n, id_token: mint({ sub: off, aud: 'x', ...n }) })).status, 401);
  assert.equal((await exchange({ ...n, id_token: 'garbage' })).status, 401);
  assert.equal((await exchange({ ...n })).status, 400, 'no id_token and no Clerk configured');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM device_tokens WHERE user_id = ANY($1)', [[gone, off]])).rows[0].n, 0);
});

test('exchange: a hostile avatar URL is not stored, and a disabled account\'s existing token stops working', { skip }, async () => {
  const id = await person('avatar');
  for (const picture of ['http://insecure.test/p.png', 'javascript:alert(1)', 'https://x.test/"onerror=1']) {
    const r = await exchange({ id_token: mint({ sub: id, nonce: 'a', picture }), nonce: 'a' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.avatar_url, null, picture);
  }
  const r = await exchange({ id_token: mint({ sub: id, nonce: 'b' }), nonce: 'b' });
  await owner.query(`UPDATE users SET status='disabled' WHERE id=$1`, [id]);
  await new Promise((s) => setTimeout(s, 10));
  const me = await http('/v1/me', { token: r.body.token });
  assert.ok([401, 403].includes(me.status), `got ${me.status}`);
});

test('without Clerk configured, a Clerk-shaped bearer token is simply not accepted', { skip }, async () => {
  const fake = `${b64u({ alg: 'RS256', kid: 'k' })}.${b64u({ sub: 'user_x', iss: 'https://clerk.test', exp: 9_999_999_999 })}.sig`;
  assert.equal((await http('/v1/me', { token: fake })).status, 401);
});

test('exchange attempts are rate limited per client address', { skip }, async () => {
  // This server has the default limit (30 a minute). Junk tokens count: guessing is what the limit is for.
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) codes.push((await exchange({ id_token: 'garbage', nonce: 'n' })).status);
  assert.ok(codes.includes(429), codes.join(','));
  const first = codes.indexOf(429);
  assert.ok(first > 0, 'the first attempts were let through');
  assert.equal(codes.slice(0, first).every((c) => c !== 429), true);
  assert.equal(codes.slice(first).every((c) => c === 429), true, 'and once limited it stays limited for the window');
});
