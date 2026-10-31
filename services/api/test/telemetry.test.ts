// Opt-in run telemetry through the real HTTP handlers: nothing is stored while sharing is off, only allow-listed fields are accepted
// (free text is refused, not stored), a re-sent run updates itself, one person cannot touch another's runs, and withdrawing can erase.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';
import { ClerkVerifier } from '../src/auth/clerk.ts';
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
const ADMIN_TOKEN = `tele-token-${tag}-0123456789abcdef`;
let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool;
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
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), exchangeLimit: 10_000 });
  const admin = adminHandler({ ro, admin: adm, tokens: parseTokens(`ops:${ADMIN_TOKEN}`) });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  api.close(); jwks.close();
  await Promise.all([app.end(), ro.end(), adm.end(), owner.end()]);
});

const http = async (path: string, token: string | null, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  return { status: r.status, body: (await r.json()) as any };
};
const send = (path: string, token: string | null, data: unknown, method = 'POST') => http(path, token, { method, body: JSON.stringify(data) });
async function signedIn(name: string) {
  const r = await send('/v1/auth/exchange', null, { clerk_token: mint(`t_${name}_${tag}`), device_name: `${name}-mac`, platform: 'darwin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id as string, tok: r.body.token as string };
}
let n = 0;
const run = (over: Record<string, unknown> = {}) => ({ run_id: `run_${tag}_${++n}_abcdefgh`, state: 'succeeded', started_at: new Date(Date.now() - 5000).toISOString(), ended_at: new Date().toISOString(), tokens_in: 100, tokens_out: 40, agent_id: 'executor', model: 'm-small', mode: 'managed', tool_calls: 2, ...over });
const count = async (id: string) => Number((await owner.query('SELECT count(*) FROM agent_runs WHERE user_id = $1', [id])).rows[0].count);

test('sharing is off by default and nothing is accepted until the person turns it on', { skip }, async () => {
  const u = await signedIn('off');
  assert.deepEqual((await http('/v1/me/usage-consent', u.tok)).body.shared, false);
  const r = await send('/v1/telemetry/runs', u.tok, { runs: [run()] });
  assert.equal(r.status, 403);
  assert.equal(await count(u.id), 0, 'nothing stored');
  assert.equal((await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT')).status, 200);
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [run()] })).status, 200);
  assert.equal(await count(u.id), 1);
});

test('free text and unknown fields are refused, and the whole batch is refused with them', { skip }, async () => {
  const u = await signedIn('text');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  for (const [name, bad] of [
    ['a title', run({ title: 'Quarterly report for ACME' })], ['a prompt', run({ prompt: 'make it shorter' })],
    ['a sentence as the model', run({ model: 'my secret project plan' })], ['a file path as the agent', run({ agent_id: '/Users/me/Documents/budget.xlsx' })],
    ['a step with a reason', run({ steps: [{ step_id: 's1', kind: 'tool', state: 'failed', reason: 'could not open budget.xlsx' }] })],
    ['a tool name with spaces', run({ steps: [{ step_id: 's1', kind: 'tool', state: 'succeeded', tool_name: 'open my file' }] })],
    ['critique text in a verdict', run({ verification: [{ verifier: 'docx-check', format: 'docx', verdict: 'fail', critique: 'the heading is wrong' }] })],
    ['an unknown state', run({ state: 'exploded' })], ['a negative count', run({ tokens_in: -1 })], ['a bad failure category', run({ failure_category: 'my printer broke' })],
  ] as const) {
    const before = await count(u.id);
    const r = await send('/v1/telemetry/runs', u.tok, { runs: [run(), bad] });
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(await count(u.id), before, `${name}: the good run in the same batch was not stored either`);
  }
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [run()], extra: 1 })).status, 400, 'unknown top-level field');
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [] })).status, 400);
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: Array.from({ length: 51 }, () => run()) })).status, 400, 'too many runs');
});

test('a full run with steps and verdicts is stored, and sending it again updates instead of duplicating', { skip }, async () => {
  const u = await signedIn('full');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  const r = run({ state: 'running', ended_at: null, steps: [{ step_id: 'plan-1', kind: 'plan', state: 'succeeded' }, { step_id: 'tool-1', parent_step_id: 'plan-1', kind: 'tool', state: 'failed', tool_name: 'docx.insert_table', retries: 1, failure_category: 'tool_error' }], verification: [{ verifier: 'docx-check', format: 'docx', verdict: 'partial', defect_count: 2 }] });
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [r] })).status, 200);
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [{ ...r, state: 'succeeded', tokens_out: 400, steps: r.steps, verification: [{ verifier: 'docx-check', format: 'docx', verdict: 'pass', defect_count: 0 }] }] })).status, 200);
  assert.equal(await count(u.id), 1);
  assert.equal(Number((await owner.query('SELECT count(*) FROM run_steps WHERE run_id = $1', [r.run_id])).rows[0].count), 2);
  const row = (await owner.query('SELECT state, tokens_out FROM agent_runs WHERE run_id = $1', [r.run_id])).rows[0];
  assert.deepEqual([row.state, Number(row.tokens_out)], ['succeeded', 400]);
  assert.equal((await owner.query('SELECT verdict FROM verification_results WHERE run_id = $1', [r.run_id])).rows[0].verdict, 'pass');
  // the admin console sees ids, states and counts for it
  const list = await http(`/admin/runs?user_id=${u.id}`, ADMIN_TOKEN);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.deepEqual(list.body.coverage.users_sharing >= 1, true);
});

test("one person cannot overwrite another's run by reusing its id", { skip }, async () => {
  const a = await signedIn('ownera'), b = await signedIn('ownerb');
  for (const u of [a, b]) await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  const r = run({ tokens_in: 7 });
  assert.equal((await send('/v1/telemetry/runs', a.tok, { runs: [r] })).status, 200);
  const hijack = await send('/v1/telemetry/runs', b.tok, { runs: [{ ...r, tokens_in: 999999, state: 'failed' }] });
  assert.notEqual(hijack.status, 200, 'refused');
  const row = (await owner.query('SELECT user_id, state, tokens_in FROM agent_runs WHERE run_id = $1', [r.run_id])).rows[0];
  assert.deepEqual([row.user_id, row.state, Number(row.tokens_in)], [a.id, 'succeeded', 7]);
});

test('turning sharing off stops intake; turning it off with delete_existing erases what was shared', { skip }, async () => {
  const u = await signedIn('withdraw');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  await send('/v1/telemetry/runs', u.tok, { runs: [run({ steps: [{ step_id: 's1', kind: 'tool', state: 'succeeded' }] }), run()] });
  assert.equal(await count(u.id), 2);
  assert.equal((await send('/v1/me/usage-consent', u.tok, { shared: false }, 'PUT')).body.deleted_runs, 0);
  assert.equal((await send('/v1/telemetry/runs', u.tok, { runs: [run()] })).status, 403);
  assert.equal(await count(u.id), 2, 'turning it off alone keeps the history');
  const gone = await send('/v1/me/usage-consent', u.tok, { shared: false, delete_existing: true }, 'PUT');
  assert.equal(gone.body.deleted_runs, 2);
  assert.equal(await count(u.id), 0);
  assert.equal(Number((await owner.query('SELECT count(*) FROM run_steps WHERE user_id = $1', [u.id])).rows[0].count), 0, 'steps went with their runs');
  assert.equal((await send('/v1/me/usage-consent', u.tok, { shared: 'yes' }, 'PUT')).status, 400);
  assert.equal((await send('/v1/me/usage-consent', u.tok, { shared: true, title: 'x' }, 'PUT')).status, 400);
});

test('telemetry routes need a sign-in, and an API key cannot call them', { skip }, async () => {
  assert.equal((await send('/v1/telemetry/runs', null, { runs: [run()] })).status, 401);
  assert.equal((await http('/v1/me/usage-consent', null)).status, 401);
  assert.equal((await send('/v1/telemetry/runs', 'aok_forged', { runs: [run()] })).status, 401);
});

test("a record built by Hermes' own sanitizer (a fixture generated from the Python code) is accepted by this server", { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/hermes-run.json', import.meta.url), 'utf8'));
  const u = await signedIn('contract');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  const r = await send('/v1/telemetry/runs', u.tok, { runs: [{ ...fx, run_id: `run_${tag}_contract_x` }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await count(u.id), 1);
});

// The API gate asks this before letting a trace through to the telemetry relay (services/gateway/api-gate.conf, /relay/v1/traces).
const allowed = async (token: string | null) => {
  const r = await fetch(base + '/v1/me/telemetry-allowed', { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, text: await r.text() };
};

test('telemetry-allowed answers 204 while sharing', { skip }, async () => {
  const u = await signedIn('allow');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  assert.deepEqual(await allowed(u.tok), { status: 204, text: '' });
});

test('telemetry-allowed answers 403 after sharing is turned off', { skip }, async () => {
  const u = await signedIn('allowoff');
  await send('/v1/me/usage-consent', u.tok, { shared: true }, 'PUT');
  await send('/v1/me/usage-consent', u.tok, { shared: false }, 'PUT');
  const r = await allowed(u.tok);
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.text).error, /sharing is off/i);
});

test('telemetry-allowed answers 403 with no consent row', { skip }, async () => {
  const u = await signedIn('allownone');
  assert.equal((await allowed(u.tok)).status, 403);
});

test('telemetry-allowed answers 401 without a token', { skip }, async () => {
  assert.equal((await allowed(null)).status, 401);
});
