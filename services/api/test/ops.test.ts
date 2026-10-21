// Operations through the real HTTP handlers: feature flags (evaluated and enforced on the server), announcements, and support tickets.
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
const ADMIN_TOKEN = `ops-token-${tag}-0123456789abcdef`;
let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool;
const users: string[] = [];
let upstreamCalls = 0;
let adminDeps: Parameters<typeof adminHandler>[0];

before(async () => {
  if (skip) return;
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), pricing: { 'm-small': { in: 1000, out: 2000 } }, upstream: async () => { upstreamCalls++; return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } }; }, exchangeLimit: 10_000 });
  adminDeps = { ro, admin: adm, tokens: parseTokens(`ops:${ADMIN_TOKEN}`) };
  const admin = adminHandler(adminDeps);
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM feature_flags WHERE key LIKE $1', [`t.%.${tag}`]);
  await owner.query('DELETE FROM announcements WHERE title LIKE $1', [`%${tag}`]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await owner.query('DELETE FROM admin_audit WHERE detail::text LIKE $1', [`%${tag}%`]);
  api.close(); jwks.close();
  await Promise.all([app.end(), ro.end(), adm.end(), owner.end()]);
});

const http = async (path: string, token: string | null, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  return { status: r.status, body: (await r.json()) as any };
};
const send = (path: string, token: string | null, data: unknown, method = 'POST') => http(path, token, { method, body: JSON.stringify(data) });
async function signedIn(name: string) {
  const r = await send('/v1/auth/exchange', null, { clerk_token: mint(`o_${name}_${tag}`), device_name: `${name}-mac`, platform: 'darwin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id as string, tok: r.body.token as string };
}
let n = 0;
const run = (over: Record<string, unknown> = {}) => ({ run_id: `run_${tag}_${++n}_abcdefgh`, state: 'succeeded', started_at: new Date(Date.now() - 5000).toISOString(), ended_at: new Date().toISOString(), tokens_in: 100, tokens_out: 40, agent_id: 'executor', model: 'm-small', mode: 'managed', tool_calls: 2, ...over });
const admin = (path: string, init: RequestInit = {}) => http(path, ADMIN_TOKEN, init);
const aPost = (path: string, data: unknown) => admin(path, { method: 'POST', body: JSON.stringify(data) });
const flagKeys: string[] = [];
const flag = (suffix: string) => { const k = `t.${suffix}.${tag}`; flagKeys.push(k); return k; };
test('a flag is off until enabled, then follows plan and rollout; the same person always lands in the same slice', { skip }, async () => {
  const u = await signedIn('flag');
  const k = flag('feature');
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], undefined, 'an unknown flag is absent, so the app treats it as off');
  assert.equal((await aPost('/admin/flags', { key: k, enabled: false, rollout_pct: 100 })).status, 200);
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], false);
  await aPost('/admin/flags', { key: k, enabled: true, rollout_pct: 100 });
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], true);
  await aPost('/admin/flags', { key: k, enabled: true, rollout_pct: 0 });
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], false, '0% is nobody');
  await aPost('/admin/flags', { key: k, enabled: true, rollout_pct: 100, plan_ids: ['beta'] });
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], false, 'a free-plan person is outside a beta-only flag');
  await owner.query(`INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,'beta') ON CONFLICT (user_id) DO UPDATE SET plan_id='beta'`, [u.id]);
  assert.equal((await http('/v1/config/client', u.tok)).body.flags[k], true, 'on the beta plan');
  // a 50% rollout splits a population, and each person's answer is stable
  await aPost('/admin/flags', { key: k, enabled: true, rollout_pct: 50 });
  const { bucket } = await import('../src/api/ops.ts');
  const ids = Array.from({ length: 400 }, (_, i) => `usr_sample${i}`);
  const on = ids.filter((id) => bucket(id, k) < 50).length;
  assert.ok(on > 140 && on < 260, `about half of 400 land in the first 50 buckets (${on})`);
  assert.equal(bucket('usr_a', k), bucket('usr_a', k));
});

test('flag input is validated, deletion works, and every change is audited', { skip }, async () => {
  const k = flag('valid');
  for (const bad of [{ key: 'Has Spaces', enabled: true }, { key: k, enabled: 'yes' }, { key: k, enabled: true, rollout_pct: 150 }, { key: k, enabled: true, rollout_pct: 1.5 }, { key: k, enabled: true, plan_ids: ['Not A Plan!'] }])
    assert.equal((await aPost('/admin/flags', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await aPost('/admin/flags', { key: k, enabled: true })).status, 200);
  assert.ok((await admin('/admin/flags')).body.flags.some((f: any) => f.key === k));
  assert.equal((await admin(`/admin/flags/${k}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin(`/admin/flags/${k}`, { method: 'DELETE' })).status, 404);
  const count = async (action: string) => (await owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = $1 AND detail::text LIKE $2`, [action, `%${k}%`])).rows[0].n;
  assert.equal(await count('delete_flag'), 2, 'both delete attempts are recorded, the refused one too');
  assert.ok(await count('save_flag') >= 1, 'saves are recorded before they act');
});

test('the managed-inference kill switch is enforced by the server before any model call', { skip }, async () => {
  const u = await signedIn('kill');
  // The switch is global, and other test files run at the same time against this database: aim it at a plan only this test uses.
  const plan = `kill_${tag}`;
  await owner.query(`INSERT INTO plans(id, name, managed_inference) VALUES ($1,'Kill test',true)`, [plan]);
  await owner.query(`INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET plan_id=$2`, [u.id, plan]);
  await owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason) VALUES ($1,'grant','paid',100000,'test')`, [u.id]);
  const ask = () => send('/v1/inference/responses', u.tok, { model: 'm-small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal((await ask()).status, 200, 'works before the switch');
  const calls = upstreamCalls;
  await aPost('/admin/flags', { key: 'killswitch.managed_inference', enabled: true, rollout_pct: 100, plan_ids: [plan] });
  try {
    const r = await ask();
    assert.equal(r.status, 503); assert.match(r.body.error, /paused/);
    assert.equal(upstreamCalls, calls, 'the model was not called');
  } finally { await admin('/admin/flags/killswitch.managed_inference', { method: 'DELETE' }); }
  assert.equal((await ask()).status, 200, 'and works again when the switch is removed');
  await owner.query('DELETE FROM subscriptions WHERE user_id = $1', [u.id]); await owner.query('DELETE FROM plans WHERE id = $1', [plan]);
});

test('announcements reach the right people once, can be read, expire, and can be switched off', { skip }, async () => {
  const u = await signedIn('ann1'), other = await signedIn('ann2');
  const t = `Maintenance ${tag}`;
  const made = await aPost('/admin/announcements', { title: t, body: 'Short downtime tonight.', level: 'warn' });
  assert.equal(made.status, 201);
  const seen = async (tok: string) => (await http('/v1/announcements', tok)).body.announcements.filter((a: any) => a.title === t);
  assert.equal((await seen(u.tok)).length, 1); assert.equal((await seen(other.tok)).length, 1);
  assert.equal((await send(`/v1/announcements/${made.body.id}/read`, u.tok, {})).status, 200);
  assert.equal((await seen(u.tok)).length, 0, 'read once, gone for them');
  assert.equal((await seen(other.tok)).length, 1, 'still there for the other person');
  const beta = await aPost('/admin/announcements', { title: `Beta ${tag}`, body: 'For beta only.', plan_ids: ['beta'] });
  assert.equal((await http('/v1/announcements', other.tok)).body.announcements.some((a: any) => a.title === `Beta ${tag}`), false, 'plan-targeted');
  await aPost(`/admin/announcements/${made.body.id}`, { active: false });
  assert.equal((await seen(other.tok)).length, 0, 'switched off');
  await owner.query(`UPDATE announcements SET ends_at = now() - interval '1 minute' WHERE id = $1`, [beta.body.id]);
  await owner.query(`UPDATE subscriptions SET plan_id = 'beta' WHERE user_id = $1`, [other.id]).catch(() => undefined);
  assert.equal((await http('/v1/announcements', other.tok)).body.announcements.some((a: any) => a.title === `Beta ${tag}`), false, 'expired');
  for (const bad of [{ title: '', body: 'x' }, { title: 'x', body: '' }, { title: 'x'.repeat(161), body: 'x' }, { title: 'x', body: 'y', plan_ids: 'beta' }, { title: 'x', body: 'y', ends_at: 'someday' }])
    assert.equal((await aPost('/admin/announcements', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await send('/v1/announcements/ann_nope/read', u.tok, {})).status, 404);
  const ch = (await admin('/admin/announcements')).body.channels;
  assert.deepEqual([ch.in_app.configured, ch.email.configured, ch.whatsapp.configured], [true, false, false], 'with no mailer, email reports not configured');
});

test('support tickets: a person sees only their own, admins reply and close, closed tickets stay closed', { skip }, async () => {
  const a = await signedIn('tka'), b = await signedIn('tkb');
  const made = await send('/v1/support/tickets', a.tok, { subject: 'Cannot sync', body: 'It says offline.' });
  assert.equal(made.status, 201);
  const id = made.body.id;
  assert.deepEqual((await http('/v1/support/tickets', a.tok)).body.tickets.map((t: any) => [t.id, t.messages.length]), [[id, 1]]);
  assert.deepEqual((await http('/v1/support/tickets', b.tok)).body.tickets, [], "another person sees none of it");
  assert.equal((await send(`/v1/support/tickets/${id}`, b.tok, { body: 'hijack' })).status, 404, "and cannot write into it");
  const detail = await admin(`/admin/tickets/${id}`);
  assert.equal(detail.status, 200); assert.equal(detail.body.messages.length, 1);
  assert.equal((await aPost(`/admin/tickets/${id}/reply`, { body: 'Please update the app.' })).status, 200);
  const mine = (await http('/v1/support/tickets', a.tok)).body.tickets[0];
  assert.deepEqual([mine.status, mine.messages.map((m: any) => m.author)], ['pending', ['user', 'admin']]);
  assert.equal((await send(`/v1/support/tickets/${id}`, a.tok, { body: 'Done, still offline.' })).status, 200);
  assert.equal((await http('/v1/support/tickets', a.tok)).body.tickets[0].status, 'open', 'a reply reopens it');
  assert.equal((await aPost(`/admin/tickets/${id}/status`, { status: 'closed' })).status, 200);
  assert.equal((await send(`/v1/support/tickets/${id}`, a.tok, { body: 'one more' })).status, 409);
  assert.ok((await admin('/admin/tickets?status=closed')).body.tickets.some((t: any) => t.id === id));
  assert.equal((await admin('/admin/tickets?status=bogus')).status, 400);
  for (const bad of [{ subject: '', body: 'x' }, { subject: 'x', body: '' }, { subject: 'x'.repeat(201), body: 'x' }]) assert.equal((await send('/v1/support/tickets', a.tok, bad)).status, 400);
  for (let i = 0; i < 10; i++) assert.equal((await send('/v1/support/tickets', b.tok, { subject: `t${i}`, body: 'x' })).status, 201);
  assert.equal((await send('/v1/support/tickets', b.tok, { subject: 'one too many', body: 'x' })).status, 429);
});

test('operations routes need a sign-in', { skip }, async () => {
  for (const [m, p] of [['GET', '/v1/config/client'], ['GET', '/v1/announcements'], ['GET', '/v1/support/tickets'], ['POST', '/v1/support/tickets']] as const)
    assert.equal((await http(p, null, { method: m })).status, 401, `${m} ${p}`);
  assert.equal((await http('/v1/config/client', 'aok_forged')).status, 401);
});

test('announcement email: refused with no provider; with one, sent once per person from the provider answer, failures recorded, nothing doubled', { skip }, async () => {
  const a = await signedIn('em1'), b = await signedIn('em2');
  const made = await aPost('/admin/announcements', { title: `Email ${tag}`, body: 'Hello from us.' });
  const id = made.body.id;
  adminDeps.mailer = undefined;
  const none = await aPost(`/admin/announcements/${id}/email`, {});
  assert.equal(none.status, 409); assert.match(none.body.error, /not configured/);
  assert.equal(Number((await owner.query('SELECT count(*) FROM email_deliveries WHERE announcement_id = $1', [id])).rows[0].count), 0, 'nothing recorded, nothing sent');

  const outbox: Array<{ to: string; subject: string; text: string }> = [];
  const mine = [`o_em1_${tag}@example.test`, `o_em2_${tag}@example.test`];
  adminDeps.mailer = async (m) => {
    if (m.to === mine[1]) throw new Error('The email provider refused it (422: bad address).');
    outbox.push(m); return { id: `prov_${outbox.length}` };
  };
  assert.equal((await owner.query('SELECT 1 FROM users WHERE id = ANY($1) AND email = ANY($2)', [[a.id, b.id], mine])).rowCount, 2, 'the test people have the addresses we expect');
  try {
    const first = await aPost(`/admin/announcements/${id}/email`, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(outbox.some((m) => m.to === mine[0] && m.subject === `Email ${tag}` && m.text === 'Hello from us.'));
    const rows = (await owner.query('SELECT user_id, status, provider_id, error FROM email_deliveries WHERE announcement_id = $1', [id])).rows;
    const ra = rows.find((r) => r.user_id === a.id), rb = rows.find((r) => r.user_id === b.id);
    assert.deepEqual([ra.status, !!ra.provider_id], ['sent', true], 'sent rows carry the provider id');
    assert.deepEqual([rb.status, rb.provider_id], ['failed', null]); assert.match(rb.error, /422/);
    assert.equal(first.body.failed >= 1, true);
    // sending again skips the people who already got it and retries only the failed one
    const before = outbox.length;
    adminDeps.mailer = async (m) => { outbox.push(m); return { id: `prov2_${outbox.length}` }; };
    const again = await aPost(`/admin/announcements/${id}/email`, {});
    assert.equal(again.status, 200);
    assert.equal(outbox.slice(before).some((m) => m.to === mine[0]), false, 'not emailed twice');
    assert.equal(outbox.slice(before).some((m) => m.to === mine[1]), true, 'the failed one is retried');
    assert.equal((await owner.query('SELECT status FROM email_deliveries WHERE announcement_id = $1 AND user_id = $2', [id, b.id])).rows[0].status, 'sent');
    // a switched-off announcement is not emailed
    await aPost(`/admin/announcements/${id}`, { active: false });
    assert.equal((await aPost(`/admin/announcements/${id}/email`, {})).status, 409);
    const list = (await admin('/admin/announcements')).body;
    assert.equal(list.channels.email.configured, true);
    assert.ok(list.announcements.find((x: any) => x.id === id).emailed >= 2);
  } finally { adminDeps.mailer = undefined; }
});
