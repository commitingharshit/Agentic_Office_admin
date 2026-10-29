// Credits, coupons, API keys, devices and managed inference through the real HTTP handlers, against a
// live database (AO_TEST_PG + role passwords). Clerk is faked with a local RSA key (as in sync.test.ts)
// and the model provider with a function, so only the money, access and error paths are under test.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';
import { ClerkVerifier } from '../src/auth/clerk.ts';
import { estimateInputTokens, worstCase, type StreamUpstream, type Upstream } from '../src/api/inference.ts';
import type { Laya } from '../src/api/laya.ts';
import { syncHandler } from '../src/api/sync.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const ISS = 'https://fake-clerk.test';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = b64u({ iss: ISS, iat: now, nbf: now - 1, exp: now + 300, sub, email: `${sub}@example.test`, azp: 'app://agentic-office' });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
}
const ADMIN_TOKEN = `ops-token-${tag}-0123456789abcdef`;
const PRICING = { 'm-small': { in: 1000, out: 2000 } };   // credits per 1,000 tokens: 1 credit per input token, 2 per output token

let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool;
type Behaviour = (model: string, body: Record<string, unknown>) => ReturnType<Upstream>;
let behaviour: Behaviour = async () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
let upstreamCalls = 0;
let streamCalls = 0;
let streamBehaviour: StreamUpstream = async () => ({ status: 200, body: null });
const layaSaw: string[] = [];
let layaBehaviour: Laya = async (t) => { layaSaw.push(t); return { pattern: 'direct', confidence: 0.8, probabilities: { direct: 0.8, plan: 0.2 }, model: 'laya_test' }; };
const users: string[] = [];

before(async () => {
  if (skip) return;
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), pricing: PRICING, upstream: (m, b) => { upstreamCalls++; return behaviour(m, b); }, streamUpstream: (m, b, sig) => { streamCalls++; return streamBehaviour(m, b, sig); }, laya: (t, w) => layaBehaviour(t, w), exchangeLimit: 10_000 });
  const admin = adminHandler({ ro, admin: adm, tokens: parseTokens(`ops:${ADMIN_TOKEN}`) });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM coupon_redemptions WHERE user_id = ANY($1)', [users]);
  await owner.query(`DELETE FROM coupons WHERE code LIKE $1`, [`%${tag.toUpperCase()}%`]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await owner.query(`DELETE FROM admin_audit WHERE detail::text LIKE $1 OR target_user_id = ANY($2)`, [`%${tag.toUpperCase()}%`, users]);
  api.close(); jwks.close();
  await Promise.all([app.end(), ro.end(), adm.end(), owner.end()]);
});

const http = async (path: string, token: string | null, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() } as { status: number; body: any };
};
const post = (path: string, token: string | null, data: unknown, headers: Record<string, string> = {}) => http(path, token, { method: 'POST', body: JSON.stringify(data), headers });
const admin = (path: string, init: RequestInit = {}) => http(path, ADMIN_TOKEN, init);
/** A signed-in user: their id and a device token, as the desktop gets it. */
async function signedIn(name: string): Promise<{ id: string; tok: string }> {
  const sub = `u_${name}_${tag}`;
  const r = await post('/v1/auth/exchange', null, { clerk_token: mint(sub), device_name: `${name}-mac`, platform: 'darwin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id, tok: r.body.token };
}
const grantTo = (id: string, amount: number, pool = 'paid') => owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason) VALUES ($1,'grant',$2,$3,'test')`, [id, pool, amount]);
const toBeta = (id: string) => owner.query(`INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,'beta') ON CONFLICT (user_id) DO UPDATE SET plan_id='beta'`, [id]);
const chat = (tok: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post('/v1/inference/responses', tok, { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, ...extra }, headers);
const total = async (tok: string) => (await http('/v1/credits/balance', tok)).body.total as number;

test('a new user is on the free plan with no credits, and cannot use managed inference', { skip }, async () => {
  const u = await signedIn('free');
  const e = await http('/v1/me/entitlements', u.tok);
  assert.equal(e.status, 200);
  assert.deepEqual([e.body.plan.id, e.body.managed_inference], ['free', false]);
  assert.deepEqual((await http('/v1/credits/balance', u.tok)).body, { promo: 0, paid: 0, reserved: 0, total: 0 });
  const before = upstreamCalls;
  const r = await chat(u.tok);
  assert.equal(r.status, 403);
  assert.equal(upstreamCalls, before, 'a refused request never reaches the model');
});

test('every account route needs a sign-in', { skip }, async () => {
  for (const [m, p] of [['GET', '/v1/credits/balance'], ['POST', '/v1/coupons/redeem'], ['GET', '/v1/usage'], ['GET', '/v1/me/devices'], ['GET', '/v1/api-keys'], ['POST', '/v1/inference/responses']] as const)
    assert.equal((await http(p, null, { method: m })).status, 401, `${m} ${p}`);
  assert.equal((await http('/v1/credits/balance', 'aod_forged')).status, 401);
  assert.equal((await http('/v1/credits/balance', 'aok_forged')).status, 401);
});

test('coupons: admin creates one, a user redeems it once, the balance and plan follow', { skip }, async () => {
  const u = await signedIn('coupon');
  const code = `WELCOME-${tag.toUpperCase()}`;
  const made = await admin('/admin/coupons', { method: 'POST', body: JSON.stringify({ code: code.toLowerCase(), amount: 500, max_redemptions: 5, plan_id: 'beta', grant_valid_days: 30, note: 'beta testers' }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.code, code);
  assert.equal((await admin('/admin/coupons', { method: 'POST', body: JSON.stringify({ code, amount: 5 }) })).status, 409, 'a duplicate code');
  const r = await post('/v1/coupons/redeem', u.tok, { code: ` ${code.toLowerCase()} ` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.granted, r.body.pool, r.body.plan, r.body.balance.promo], [500, 'promo', 'beta', 500]);
  assert.equal((await post('/v1/coupons/redeem', u.tok, { code })).status, 409);
  assert.equal(await total(u.tok), 500);
  const e = await http('/v1/me/entitlements', u.tok);
  assert.deepEqual([e.body.plan.id, e.body.managed_inference], ['beta', true]);
  const listed = (await admin('/admin/coupons')).body.coupons.find((c: { code: string }) => c.code === code);
  assert.equal(listed.redeemed_count, 1);
});

test('coupons: bad codes get one answer, and guessing is rate limited', { skip }, async () => {
  const u = await signedIn('guess');
  const off = `OFFCODE-${tag.toUpperCase()}`;
  await admin('/admin/coupons', { method: 'POST', body: JSON.stringify({ code: off, amount: 5 }) });
  await admin(`/admin/coupons/${off}/disable`, { method: 'POST' });
  const answers = new Set<string>();
  for (const code of ['NOSUCHCODE', off, '', 'x'.repeat(200)]) {
    const r = await post('/v1/coupons/redeem', u.tok, { code });
    assert.equal(r.status, 400);
    answers.add(r.body.error);
  }
  assert.equal(answers.size, 1, 'unknown, disabled, empty and oversize codes are indistinguishable');
  for (let i = 0; i < 4; i++) await post('/v1/coupons/redeem', u.tok, { code: `GUESS-${i}-AAAA` });   // 8 wrong in total
  const blocked = await post('/v1/coupons/redeem', u.tok, { code: 'GUESS-9-AAAA' });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.retry_after > 0);
  const other = await signedIn('guess2');
  assert.equal((await post('/v1/coupons/redeem', other.tok, { code: 'NOSUCHCODE' })).status, 400, 'the limit is per user');
});

test('a coupon with a limit stops at the limit under simultaneous requests over HTTP', { skip }, async () => {
  const code = `RACE-${tag.toUpperCase()}`;
  await admin('/admin/coupons', { method: 'POST', body: JSON.stringify({ code, amount: 10, max_redemptions: 2 }) });
  const us = await Promise.all(Array.from({ length: 6 }, (_, i) => signedIn(`race${i}`)));
  const rs = await Promise.all(us.map((u) => post('/v1/coupons/redeem', u.tok, { code })));
  assert.equal(rs.filter((r) => r.status === 200).length, 2);
  assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 400));
});

test('managed inference: holds the worst case, charges the real use, returns the rest', { skip }, async () => {
  const u = await signedIn('chat'); await toBeta(u.id); await grantTo(u.id, 10_000);
  behaviour = async () => ({ status: 200, body: { id: 'x', choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: { prompt_tokens: 12, completion_tokens: 30 } } });
  const r = await chat(u.tok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.choices[0].message.content, 'hello');
  assert.equal(r.body.ao.charged, 12 * 1 + 30 * 2);                 // 72
  assert.equal(r.body.ao.balance, 10_000 - 72);
  assert.equal(await total(u.tok), 10_000 - 72);
  const use = (await http('/v1/usage', u.tok)).body;
  assert.deepEqual(use.totals, { cost: 72, tokens_in: 12, tokens_out: 30, requests: 1 });
  assert.equal(use.events[0].model, 'm-small');
  assert.equal((await http('/v1/credits/balance', u.tok)).body.reserved, 0);
});

test('Laya shadow: an answered request is predicted and kept; a refused one, or a Laya failure, is not', { skip }, async () => {
  const u = await signedIn('laya'); await toBeta(u.id); await grantTo(u.id, 10_000);
  const rows = async () => (await owner.query('SELECT request_id, model, request_text, pattern, confidence, probabilities, laya_model FROM laya_shadow WHERE user_id = $1 ORDER BY id', [u.id])).rows;
  const settle = async (n: number) => { for (let i = 0; i < 50 && (await rows()).length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
  behaviour = async () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } });
  const r = await chat(u.tok, { messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'make a deck' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await settle(1);
  assert.deepEqual(await rows(), [{ request_id: r.body.ao.request_id, model: 'm-small', request_text: 'make a deck', pattern: 'direct', confidence: 0.8, probabilities: { direct: 0.8, plan: 0.2 }, laya_model: 'laya_test' }]);
  behaviour = async () => ({ status: 400, body: { error: 'no' } });
  const sawBefore = layaSaw.length;
  assert.equal((await chat(u.tok, { messages: [{ role: 'user', content: 'refused' }] })).status, 400);
  layaBehaviour = async () => { throw new Error('down'); };
  behaviour = async () => ({ status: 200, body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  assert.equal((await chat(u.tok, { messages: [{ role: 'user', content: 'laya down' }] })).status, 200, 'Laya failing never fails the request');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(layaSaw.length, sawBefore, 'a refused request is never sent to Laya');
  assert.equal((await rows()).length, 1);
  assert.equal((await app.query('SELECT count(*) FROM laya_shadow').catch((e) => e)).code, '42501', 'the app role can write but not read');
  layaBehaviour = async (t) => { layaSaw.push(t); return { pattern: 'direct', confidence: 0.8, probabilities: { direct: 0.8 }, model: 'laya_test' }; };
});

test('Laya shadow for the app: /v1/laya/predict keeps the request with the route Hermes took and hands the prediction back', { skip }, async () => {
  const u = await signedIn('layaapp');   // free plan, no credits: the app's own chat needs neither
  const rows = async () => (await owner.query('SELECT request_id, model, request_text, pattern, workspace, route, status FROM laya_shadow WHERE user_id = $1 ORDER BY id', [u.id])).rows;
  let sentWorkspace: string | undefined;
  layaBehaviour = async (t, w) => { layaSaw.push(t); sentWorkspace = w; return { pattern: 'tool_chain', confidence: 0.7, probabilities: { tool_chain: 0.7 }, model: 'laya_test' }; };
  assert.equal((await post('/v1/laya/predict', null, { text: 'x' })).status, 401);
  assert.equal((await post('/v1/laya/predict', u.tok, { text: '  ' })).status, 400);
  const r = await post('/v1/laya/predict', u.tok, { text: ' make a 10 slide deck ', workspace: 'files:3 | types:pptx | deps:0', route: 'inline', status: 'succeeded' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { pattern: 'tool_chain', confidence: 0.7, probabilities: { tool_chain: 0.7 }, model: 'laya_test' });
  assert.equal(sentWorkspace, 'files:3 | types:pptx | deps:0');
  assert.deepEqual(await rows(), [{ request_id: null, model: null, request_text: 'make a 10 slide deck', pattern: 'tool_chain', workspace: 'files:3 | types:pptx | deps:0', route: 'inline', status: 'succeeded' }]);
  layaBehaviour = async () => undefined;
  assert.equal((await post('/v1/laya/predict', u.tok, { text: 'busy' })).status, 503);
  layaBehaviour = async () => { throw new Error('down'); };
  assert.equal((await post('/v1/laya/predict', u.tok, { text: 'down' })).status, 502);
  assert.equal((await rows()).length, 1, 'nothing is kept without a prediction');
  layaBehaviour = async (t) => { layaSaw.push(t); return { pattern: 'direct', confidence: 0.8, probabilities: { direct: 0.8 }, model: 'laya_test' }; };
});

test('Live Laya: /v1/laya/outcome keeps each edit kept or undone', { skip }, async () => {
  const u = await signedIn('layaout');
  const rows = async () => (await owner.query('SELECT accepted, source, file, count, authors, session_id, response_id FROM laya_outcome WHERE user_id = $1 ORDER BY id', [u.id])).rows;
  assert.equal((await post('/v1/laya/outcome', null, { accepted: true })).status, 401);
  assert.equal((await post('/v1/laya/outcome', u.tok, { accepted: 'yes' })).status, 400);
  assert.equal((await post('/v1/laya/outcome', u.tok, { accepted: true, source: 'chat', file: 'deck.pptx', session_id: 's1', response_id: 'r1' })).status, 200);
  assert.equal((await post('/v1/laya/outcome', u.tok, { accepted: false, source: 'changes', count: 3, authors: ['assistant'] })).status, 200);
  assert.deepEqual(await rows(), [
    { accepted: true, source: 'chat', file: 'deck.pptx', count: null, authors: null, session_id: 's1', response_id: 'r1' },
    { accepted: false, source: 'changes', file: null, count: 3, authors: ['assistant'], session_id: null, response_id: null },
  ]);
  assert.equal((await app.query('SELECT count(*) FROM laya_outcome').catch((e) => e)).code, '42501', 'the app role can write but not read');
});

test('managed inference: what is sent upstream is bounded by what was reserved', { skip }, async () => {
  const u = await signedIn('bound'); await toBeta(u.id); await grantTo(u.id, 100_000);
  let seen: Record<string, unknown> = {};
  behaviour = async (_m, b) => { seen = b; return { status: 200, body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }; };
  await chat(u.tok, { max_tokens: 999_999 });
  assert.equal(seen.max_tokens, 16_384, 'the output limit is clamped');
  assert.equal(seen.stream, false);
  await chat(u.tok, { max_tokens: 999_999, max_completion_tokens: 5 });
  assert.equal(seen.max_tokens, 5, 'the newer field wins, and only one limit is forwarded');
  assert.equal(seen.max_completion_tokens, undefined);
  await chat(u.tok, { max_tokens: undefined });
  assert.equal(seen.max_tokens, 4096, 'no limit asked means the default, never unbounded');
});

test('managed inference: too few credits is refused before the model is called', { skip }, async () => {
  const u = await signedIn('poor'); await toBeta(u.id);
  const body = { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: false };
  const hold = worstCase(PRICING['m-small'], body);
  await grantTo(u.id, hold - 1);
  const before = upstreamCalls;
  const r = await chat(u.tok);
  assert.equal(r.status, 402);
  assert.equal(r.body.needed, hold);
  assert.equal(upstreamCalls, before);
  assert.equal(await total(u.tok), hold - 1);
});

test('managed inference: a failed, empty or silent upstream costs nothing', { skip }, async () => {
  const u = await signedIn('fail'); await toBeta(u.id); await grantTo(u.id, 5_000);
  const cases: Array<[string, Behaviour, number]> = [
    ['throws', async () => { throw new Error('boom'); }, 502],
    ['500', async () => ({ status: 500, body: { error: 'down' } }), 502],
    ['429', async () => ({ status: 429, body: {} }), 502],
    ['400', async () => ({ status: 400, body: { error: 'bad' } }), 400],
    ['no usage', async () => ({ status: 200, body: { choices: [] } }), 502],
  ];
  for (const [name, b, status] of cases) {
    behaviour = b;
    const r = await chat(u.tok);
    assert.equal(r.status, status, name);
    assert.equal(await total(u.tok), 5_000, `${name}: balance unchanged`);
    assert.equal((await http('/v1/credits/balance', u.tok)).body.reserved, 0, `${name}: nothing left held`);
  }
  assert.equal((await http('/v1/usage', u.tok)).body.totals.requests, 0);
});

test('managed inference: unknown model, streaming and empty messages are refused', { skip }, async () => {
  const u = await signedIn('badreq'); await toBeta(u.id); await grantTo(u.id, 5_000);
  const before = upstreamCalls;
  const unknown = await chat(u.tok, { model: 'gpt-secret' });
  assert.equal(unknown.status, 400); assert.deepEqual(unknown.body.models, ['m-small']);
  assert.equal((await chat(u.tok, { model: '__proto__' })).status, 400);
  assert.equal((await chat(u.tok, { stream: true })).status, 400);
  assert.equal((await chat(u.tok, { messages: [] })).status, 400);
  assert.equal(upstreamCalls, before);
  assert.equal(await total(u.tok), 5_000);
});

test('managed inference: a repeated idempotency key is charged and called once', { skip }, async () => {
  const u = await signedIn('idem'); await toBeta(u.id); await grantTo(u.id, 5_000);
  behaviour = async () => ({ status: 200, body: { usage: { prompt_tokens: 3, completion_tokens: 4 } } });
  const before = upstreamCalls;
  const key = `idem-${tag}-0001`;
  assert.equal((await chat(u.tok, {}, { 'idempotency-key': key })).status, 200);
  assert.equal((await chat(u.tok, {}, { 'idempotency-key': key })).status, 409);
  assert.equal(upstreamCalls, before + 1);
  assert.equal(await total(u.tok), 5_000 - (3 + 8));
});

test('managed inference: simultaneous calls cannot spend more than the balance', { skip }, async () => {
  const u = await signedIn('burst'); await toBeta(u.id);
  const hold = worstCase(PRICING['m-small'], { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: false });
  const start = hold * 3 + 5;
  await grantTo(u.id, start);
  behaviour = async () => { await new Promise((r) => setTimeout(r, 400)); return { status: 200, body: { usage: { prompt_tokens: 5, completion_tokens: 10 } } }; };
  const rs = await Promise.all(Array.from({ length: 10 }, () => chat(u.tok)));
  const ok = rs.filter((r) => r.status === 200).length, refused = rs.filter((r) => r.status === 402).length;
  assert.equal(ok, 3); assert.equal(refused, 7);
  const left = await total(u.tok);
  assert.equal(left, start - ok * (5 + 20));
  assert.ok(left >= 0);
});

test('plan limits: models, requests a minute, and runs at once come from the plan, not from the code', { skip }, async () => {
  const pid = `lim_${tag}`;
  await owner.query(`INSERT INTO plans(id, name, managed_inference, active, max_concurrent_runs, max_job_seconds, requests_per_minute, allowed_models) VALUES ($1,'Limits test',true,true,2,120,5,ARRAY['m-small'])`, [pid]);
  const u = await signedIn('limits'); await grantTo(u.id, 1_000_000);
  await owner.query(`INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET plan_id=$2`, [u.id, pid]);
  behaviour = async () => { await new Promise((r) => setTimeout(r, 300)); return { status: 200, body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }; };
  // two at once is the allowance: the third is told so, and is not charged
  const before3 = await total(u.tok);
  const rs = await Promise.all([chat(u.tok), chat(u.tok), chat(u.tok)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 429], JSON.stringify(rs.map((r) => r.body)));
  assert.match(rs.find((r) => r.status === 429)!.body.error, /2 runs at a time/);
  assert.equal(await total(u.tok), before3 - 2 * 3, 'only the two that ran were charged');
  // the hold lasts as long as the plan says a job may run
  behaviour = async () => { const t = (await owner.query(`SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM credit_reservations WHERE user_id = $1 AND status = 'open'`, [u.id])).rows[0]?.s; seen = t; return { status: 200, body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } }; };
  let seen: number | undefined;
  assert.equal((await chat(u.tok)).status, 200);
  assert.ok(seen !== undefined && Math.abs(seen - 120) <= 2, `hold lasted ${seen}s`);
  // a model outside the plan's list
  const pr = PRICING as Record<string, { in: number; out: number }>;
  pr['m-big'] = { in: 1, out: 1 };
  try {
    const r = await chat(u.tok, { model: 'm-big' });
    assert.equal(r.status, 403); assert.deepEqual(r.body.models, ['m-small']);
  } finally { delete pr['m-big']; }
  // five a minute: this was call 5 of the minute already (3 + 1 + the refused-by-model one is not counted before the check, so top up to the edge)
  const rest = [];
  for (let i = 0; i < 4; i++) rest.push(await chat(u.tok));
  assert.ok(rest.some((r) => r.status === 429 && /5 requests a minute/.test(r.body.error)), rest.map((r) => r.status).join(','));
  await owner.query('DELETE FROM subscriptions WHERE user_id = $1', [u.id]); await owner.query('DELETE FROM plans WHERE id = $1', [pid]);
});

test('API keys: shown once, work for inference only, can be revoked, belong to their user', { skip }, async () => {
  const a = await signedIn('keya'), b = await signedIn('keyb');
  await toBeta(a.id); await grantTo(a.id, 5_000);
  behaviour = async () => ({ status: 200, body: { usage: { prompt_tokens: 2, completion_tokens: 2 } } });
  const made = await post('/v1/api-keys', a.tok, { name: 'my script' });
  assert.equal(made.status, 201);
  assert.match(made.body.key, /^aok_/);
  const key = made.body.key as string;
  const listed = (await http('/v1/api-keys', a.tok)).body.keys;
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(key.slice(12)), false, 'the secret is never listed again');
  const stored = (await owner.query('SELECT key_hash FROM api_keys WHERE id=$1', [made.body.id])).rows[0].key_hash;
  assert.notEqual(stored, key); assert.match(stored, /^[a-f0-9]{64}$/);
  assert.equal((await chat(key)).status, 200);
  assert.equal(await total(a.tok), 5_000 - (2 + 4));
  for (const p of ['/v1/credits/balance', '/v1/me', '/v1/usage', '/v1/api-keys']) assert.equal((await http(p, key)).status, 403, p);
  assert.equal((await http(`/v1/api-keys/${made.body.id}`, b.tok, { method: 'DELETE' })).status, 404, 'not B\'s key');
  assert.equal((await chat(key)).status, 200, 'B could not revoke it');
  assert.equal((await http(`/v1/api-keys/${made.body.id}`, a.tok, { method: 'DELETE' })).status, 200);
  assert.equal((await chat(key)).status, 401);
});

test('API keys: at most ten live at once; a disabled account\'s keys stop working', { skip }, async () => {
  const u = await signedIn('keys10'); await toBeta(u.id); await grantTo(u.id, 5_000);
  let first = '';
  for (let i = 0; i < 10; i++) { const r = await post('/v1/api-keys', u.tok, { name: `k${i}` }); assert.equal(r.status, 201); first ||= r.body.key; }
  assert.equal((await post('/v1/api-keys', u.tok, { name: 'one too many' })).status, 409);
  behaviour = async () => ({ status: 200, body: { usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  assert.equal((await chat(first)).status, 200);
  assert.equal((await admin(`/admin/users/${u.id}/disable`, { method: 'POST' })).status, 200);
  assert.equal((await chat(first)).status, 403);
});

test('devices: listed, the current one marked, another user cannot sign yours out, revoking takes effect at once', { skip }, async () => {
  const sub = `u_dev_${tag}`;
  const ex = async (name: string) => (await post('/v1/auth/exchange', null, { clerk_token: mint(sub), device_name: name, platform: 'darwin' })).body;
  const d1 = await ex('laptop'), d2 = await ex('desktop');
  users.push(d1.user.id);
  const list = (await http('/v1/me/devices', d1.token)).body.devices;
  assert.deepEqual(list.map((d: { device_name: string; current: boolean }) => [d.device_name, d.current]).sort(), [['desktop', false], ['laptop', true]]);
  assert.equal(JSON.stringify(list).includes('token_hash'), false);
  const stranger = await signedIn('stranger');
  const other = list.find((d: { current: boolean }) => !d.current);
  assert.equal((await http(`/v1/me/devices/${other.id}`, stranger.tok, { method: 'DELETE' })).status, 404);
  assert.equal((await http('/v1/credits/balance', d2.token)).status, 200);          // warms the token cache
  assert.equal((await http(`/v1/me/devices/${other.id}`, d1.token, { method: 'DELETE' })).status, 200);
  assert.equal((await http('/v1/credits/balance', d2.token)).status, 401, 'revoked, not "within a minute"');
  assert.equal((await http('/v1/credits/balance', d1.token)).status, 200);
  assert.equal((await http(`/v1/me/devices/${other.id}`, d1.token, { method: 'DELETE' })).status, 404, 'already gone');
});

test('admin: credits are granted through the ledger with a reason, and cannot go below zero', { skip }, async () => {
  const u = await signedIn('support');
  const noReason = await admin(`/admin/users/${u.id}/credits`, { method: 'POST', body: JSON.stringify({ amount: 50 }) });
  assert.equal(noReason.status, 400);
  assert.equal((await admin(`/admin/users/${u.id}/credits`, { method: 'POST', body: JSON.stringify({ amount: -5, reason: 'oops' }) })).status, 400, 'a grant cannot be negative');
  const g = await admin(`/admin/users/${u.id}/credits`, { method: 'POST', body: JSON.stringify({ amount: 50, pool: 'promo', valid_days: 14, reason: 'launch goodwill' }) });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal((await admin(`/admin/users/${u.id}/credits`, { method: 'POST', body: JSON.stringify({ kind: 'adjust', amount: -80, pool: 'promo', reason: 'too much' }) })).status, 409);
  assert.equal((await admin(`/admin/users/${u.id}/credits`, { method: 'POST', body: JSON.stringify({ kind: 'adjust', amount: -20, pool: 'promo', reason: 'correction' }) })).status, 200);
  const view = (await admin(`/admin/users/${u.id}/credits`)).body;
  assert.deepEqual([view.promo, view.paid, view.plan_id], [30, 0, 'free']);
  assert.deepEqual(view.ledger.map((l: { kind: string; created_by: string }) => [l.kind, l.created_by]), [['adjust', 'ops'], ['grant', 'ops']]);
  assert.equal(await total(u.tok), 30, 'the user sees the same balance');
  assert.equal((await admin('/admin/users/usr_nobody/credits', { method: 'POST', body: JSON.stringify({ amount: 5, reason: 'nobody' }) })).status, 404);
  const audit = (await owner.query(`SELECT action FROM admin_audit WHERE target_user_id = $1 ORDER BY id`, [u.id])).rows.map((r) => r.action);
  assert.ok(audit.filter((a) => a === 'adjust_credits').length >= 3, 'every attempt is audited');
});

test('admin: plans can be listed and set, and a plan change takes effect for the user', { skip }, async () => {
  const u = await signedIn('plans');
  const plans = (await admin('/admin/plans')).body.plans;
  assert.deepEqual(plans.map((p: { id: string }) => p.id).filter((id: string) => ['beta', 'free', 'max20x', 'max5x', 'pro'].includes(id)).sort(), ['beta', 'free', 'max20x', 'max5x', 'pro'], 'the shipped plans (other tests may add their own)');
  assert.equal((await admin(`/admin/users/${u.id}/plan`, { method: 'POST', body: JSON.stringify({ plan_id: 'nope' }) })).status, 400);
  assert.equal((await admin(`/admin/users/${u.id}/plan`, { method: 'POST', body: JSON.stringify({ plan_id: 'beta' }) })).status, 200);
  assert.equal((await http('/v1/me/entitlements', u.tok)).body.managed_inference, true);
  await owner.query(`INSERT INTO entitlements(user_id, key, value) VALUES ($1,'managed_inference','false')`, [u.id]);
  assert.equal((await http('/v1/me/entitlements', u.tok)).body.managed_inference, false, 'a per-user override beats the plan');
});

test('admin routes need an admin; a signed-in user is not one', { skip }, async () => {
  const u = await signedIn('notadmin');
  for (const [m, p] of [['GET', '/admin/coupons'], ['POST', '/admin/coupons'], ['GET', '/admin/plans'], ['POST', `/admin/users/${u.id}/credits`]] as const) {
    assert.equal((await http(p, null, { method: m })).status, 401, `${m} ${p} without a token`);
    assert.equal((await http(p, u.tok, { method: m })).status, 403, `${m} ${p} as a user`);
  }
});

// ── streaming ───────────────────────────────────────────────────────────────────────────────────
const sse = (chunks: string[], o: { delayMs?: number; signal?: AbortSignal; onCancel?: () => void } = {}) => new ReadableStream<Uint8Array>({
  async start(c) {
    const enc = new TextEncoder();
    for (const ch of chunks) {
      if (o.signal?.aborted) { o.onCancel?.(); c.close(); return; }
      c.enqueue(enc.encode(ch));
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    }
    c.close();
  },
});
const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const usageChunk = (i: number, o: number) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } })}\n\n`;
const streamChat = async (tok: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, signal?: AbortSignal) =>
  fetch(`${base}/v1/inference/responses`, { method: 'POST', signal, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true, ...extra }) });

test('streaming: the answer is passed through and the charge is what the provider reported', { skip }, async () => {
  const u = await signedIn('stream'); await toBeta(u.id); await grantTo(u.id, 10_000);
  let seen: Record<string, unknown> = {};
  streamBehaviour = async (_m, b) => { seen = b; return { status: 200, body: sse([delta('Hel'), delta('lo'), usageChunk(9, 21), 'data: [DONE]\n\n']) }; };
  const r = await streamChat(u.tok);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.match(r.headers.get('x-ao-request-id') ?? '', /^req_/);
  const text = await r.text();
  assert.ok(text.includes('"Hel"') && text.includes('"lo"') && text.includes('[DONE]'), text);
  assert.equal(seen.stream, true);
  assert.equal(seen.stream_options, undefined, 'the server sets stream_options toward the provider, a caller cannot');
  assert.equal(seen.max_tokens, 100);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(await total(u.tok), 10_000 - (9 + 42));
  const use = (await http('/v1/usage', u.tok)).body;
  assert.deepEqual(use.totals, { cost: 51, tokens_in: 9, tokens_out: 21, requests: 1 });
  assert.equal((await http('/v1/credits/balance', u.tok)).body.reserved, 0);
});

test('streaming: a caller cannot choose their own stream_options or skip the output limit', { skip }, async () => {
  const u = await signedIn('streamopts'); await toBeta(u.id); await grantTo(u.id, 100_000);
  let seen: Record<string, unknown> = {};
  streamBehaviour = async (_m, b) => { seen = b; return { status: 200, body: sse([usageChunk(1, 1)]) }; };
  await (await streamChat(u.tok, { stream_options: { include_usage: false }, max_tokens: undefined })).text();
  assert.equal(seen.stream_options, undefined);
  assert.equal(seen.max_tokens, 4096);
});

test('streaming: with no usage report the charge is estimated from the text, and never exceeds the hold', { skip }, async () => {
  const u = await signedIn('nousage'); await toBeta(u.id); await grantTo(u.id, 10_000);
  const body = { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true };
  const hold = worstCase(PRICING['m-small'], body);
  streamBehaviour = async () => ({ status: 200, body: sse([delta('a'.repeat(300)), delta('b'.repeat(300)), 'data: [DONE]\n\n']) });
  assert.equal((await (await streamChat(u.tok)).text()).includes('[DONE]'), true);
  await new Promise((r) => setTimeout(r, 150));
  const charged = 10_000 - (await total(u.tok));
  const expected = Math.min(estimateInputTokens(body) * 1 + 200 * 2, hold);
  assert.equal(charged, expected, `charged ${charged}, expected ${expected}`);
  assert.ok(charged > 0 && charged <= hold);
});

test('streaming: a caller who disconnects stops the provider and pays only for what was sent', { skip }, async () => {
  const u = await signedIn('hangup'); await toBeta(u.id); await grantTo(u.id, 10_000);
  let aborted = false;
  streamBehaviour = async (_m, _b, signal) => ({ status: 200, body: sse([delta('x'.repeat(30)), ...Array.from({ length: 40 }, () => delta('y'.repeat(30)))], { delayMs: 40, signal, onCancel: () => { aborted = true; } }) });
  const ac = new AbortController();
  const r = await streamChat(u.tok, {}, {}, ac.signal);
  const reader = r.body!.getReader();
  await reader.read();                   // the first chunk arrives
  ac.abort();
  await reader.read().catch(() => undefined);
  for (let i = 0; i < 30 && !aborted; i++) await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(aborted, true, 'the provider call was cancelled');
  for (let i = 0; i < 30 && (await http('/v1/credits/balance', u.tok)).body.reserved !== 0; i++) await new Promise((r2) => setTimeout(r2, 50));
  const left = await total(u.tok), hold = worstCase(PRICING['m-small'], { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true });
  assert.equal((await http('/v1/credits/balance', u.tok)).body.reserved, 0, 'the hold was closed');
  assert.ok(10_000 - left < hold, `charged ${10_000 - left} of a possible ${hold}`);
});

test('streaming: a provider that fails before the stream starts costs nothing and answers with JSON', { skip }, async () => {
  const u = await signedIn('streamfail'); await toBeta(u.id); await grantTo(u.id, 5_000);
  for (const [name, b, status] of [['500', async () => ({ status: 500, body: null }), 502], ['400', async () => ({ status: 400, body: null }), 400], ['throws', async () => { throw new Error('down'); }, 502]] as Array<[string, StreamUpstream, number]>) {
    streamBehaviour = b;
    const r = await streamChat(u.tok);
    assert.equal(r.status, status, name);
    assert.match(r.headers.get('content-type') ?? '', /json/, name);
    assert.equal(await total(u.tok), 5_000, name);
    assert.equal((await http('/v1/credits/balance', u.tok)).body.reserved, 0, name);
  }
});

test('streaming: too few credits is refused as JSON before the provider is called', { skip }, async () => {
  const u = await signedIn('streampoor'); await toBeta(u.id); await grantTo(u.id, 3);
  const before = streamCalls;
  const r = await streamChat(u.tok);
  assert.equal(r.status, 402);
  assert.match(r.headers.get('content-type') ?? '', /json/);
  assert.equal(streamCalls, before);
});

test('streaming: simultaneous streams cannot spend more than the balance', { skip }, async () => {
  const u = await signedIn('streamburst'); await toBeta(u.id);
  const hold = worstCase(PRICING['m-small'], { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true });
  await grantTo(u.id, hold * 2 + 3);
  streamBehaviour = async () => ({ status: 200, body: sse([delta('ok'), usageChunk(4, 4)], { delayMs: 60 }) });
  const rs = await Promise.all(Array.from({ length: 6 }, () => streamChat(u.tok).then(async (r) => { await r.text(); return r.status; })));
  assert.equal(rs.filter((x) => x === 200).length, 2);
  assert.equal(rs.filter((x) => x === 402).length, 4);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await total(u.tok), hold * 2 + 3 - 2 * (4 + 8));
});

test('the OpenAI-style paths work: /chat/completions, /models, and API keys on both', { skip }, async () => {
  const u = await signedIn('compat'); await toBeta(u.id); await grantTo(u.id, 5_000);
  behaviour = async () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } } });
  const key = (await post('/v1/api-keys', u.tok, { name: 'compat' })).body.key as string;
  const c = await post('/v1/inference/chat/completions', key, { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.choices[0].message.content, 'hi');
  const models = await http('/v1/inference/models', key);
  assert.deepEqual(models.body.data.map((m: { id: string }) => m.id), ['m-small']);
  assert.equal((await http('/v1/inference/models', null)).status, 401);
  assert.equal((await http('/v1/inference/chat/completions', key, { method: 'GET' })).status, 404);
  assert.equal((await http('/v1/inference/other', key, { method: 'POST', body: '{}' })).status, 404);
  streamBehaviour = async () => ({ status: 200, body: sse([delta('s'), usageChunk(1, 1)]) });
  const sr = await fetch(`${base}/v1/inference/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, stream: true }) });
  assert.equal(sr.status, 200);
  assert.ok((await sr.text()).includes('"s"'));
});
