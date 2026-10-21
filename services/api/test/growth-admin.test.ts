// Growth in the admin API, through the real admin and sync handlers on Postgres: a campaign is built, published and served;
// roles are enforced on the server and every change is audited; releases move their feature flag; previews explain decisions;
// the guardrail pauses a campaign people keep dismissing.
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
const TOKEN = `growth-console-${tag}-0123456789abcdef`;
let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool;
const users: string[] = [];
const boss = `usr_gboss${tag}`, analyst = `usr_ganalyst${tag}`, engineer = `usr_geng${tag}`;
const flagKey = `t.release.${tag}`;

before(async () => {
  if (skip) return;
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  for (const [id, role] of [[boss, 'superadmin'], [analyst, 'analyst'], [engineer, 'engineer']]) {
    await owner.query(`INSERT INTO users(id, email, role, status) VALUES ($1,$2,'admin','active')`, [id, `${id}@example.test`]);
    await owner.query(`INSERT INTO admin_roles(user_id, role, granted_by) VALUES ($1,$2,'test')`, [id, role]);
    users.push(id);
  }
  await owner.query(`INSERT INTO feature_flags(key, description, enabled, rollout_pct) VALUES ($1, 'test release flag', false, 0)`, [flagKey]);
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), exchangeLimit: 10_000 });
  const admin = adminHandler({ ro, admin: adm, tokens: parseTokens(`console:${TOKEN}`) });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query(`DELETE FROM campaigns WHERE name LIKE $1`, [`%${tag}`]);
  await owner.query(`DELETE FROM releases WHERE title LIKE $1`, [`%${tag}`]);
  await owner.query(`DELETE FROM announcements WHERE title LIKE $1`, [`%${tag}%`]);
  await owner.query(`DELETE FROM feature_flags WHERE key = $1`, [flagKey]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  api.close(); jwks.close();
  await Promise.all([app.end(), ro.end(), adm.end(), owner.end()]);
});

const call = async (path: string, init: RequestInit & { acting?: string; token?: string | null } = {}) => {
  const { acting, token, ...rest } = init;
  const auth = token === null ? {} : { authorization: `Bearer ${token ?? TOKEN}` };
  const r = await fetch(base + path, { ...rest, headers: { ...auth, 'content-type': 'application/json', ...(acting ? { 'x-ao-acting-admin': acting } : {}) } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const post = (path: string, data: unknown, acting = boss, method = 'POST') => call(path, { method, body: JSON.stringify(data), acting });
async function person(name: string) {
  const r = await call('/v1/auth/exchange', { method: 'POST', token: null, body: JSON.stringify({ clerk_token: mint(`ga_${name}_${tag}`), device_name: `${name}-mac`, platform: 'darwin' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id as string, tok: r.body.token as string };
}
const card = (h: string) => ({ v: 1, layout: 'stack', blocks: [{ type: 'heading', text: h }, { type: 'text', text: 'Explore the toolkit.' }], actions: [{ label: 'Explore', action: { command: 'open_marketplace_item', arg: 'lbo-toolkit' } }] });

test('a campaign is built, published, put live and then served to the app; going live without a ready creative is refused', { skip }, async () => {
  const c = await post('/admin/growth/campaigns', { name: `Toolkit ${tag}`, priority: 100, max_impressions: 5, min_gap_seconds: 0 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.campaign.id as string;
  assert.equal((await post(`/admin/growth/campaigns/${id}/status`, { status: 'live' })).status, 409);
  assert.equal((await post(`/admin/growth/campaigns/${id}/creatives`, { placement: 'chat_empty', kind: 'card', card: { v: 1, layout: 'stack', blocks: [{ type: 'html', html: 'x' }] } })).status, 400, 'an invalid card is refused on save');
  assert.equal((await post(`/admin/growth/campaigns/${id}/creatives`, { placement: 'bottom_strip', kind: 'clip', headline: 'x' })).status, 400, 'no clips on the bottom strip');
  const cr = await post(`/admin/growth/campaigns/${id}/creatives`, { placement: 'chat_empty', kind: 'card', card: card(`Build an LBO ${tag}`) });
  assert.equal(cr.status, 200, JSON.stringify(cr.body));
  assert.equal((await post(`/admin/growth/creatives/${cr.body.creative.id}/publish`, {})).body.status, 'ready');
  assert.equal((await post(`/admin/growth/campaigns/${id}/status`, { status: 'live' })).body.status, 'live');
  const u = await person('served');
  // Only this test's person: test files run side by side on one database.
  await post(`/admin/growth/campaigns/${id}/targets`, { user_ids: [u.id] }, boss, 'PUT');
  const got = await call('/v1/promotions/eligible?placement=chat_empty&contract=1', { token: u.tok });
  assert.equal(got.body.item?.campaign_id, id, JSON.stringify(got.body));
  assert.equal(got.body.item.card.actions[0].action.command, 'open_marketplace_item');
  const why = await post('/admin/growth/preview', { user_id: u.id, placement: 'chat_empty' });
  assert.equal(why.body.decision.campaign, id);
  await post(`/admin/growth/campaigns/${id}/targets`, { plan_ids: ['pro'], user_ids: [u.id] }, boss, 'PUT');
  const now = await post('/admin/growth/preview', { user_id: u.id, placement: 'chat_empty' });
  assert.notEqual(now.body.decision.campaign, id);
  assert.equal(now.body.decision.reasons?.[id], 'plan free not targeted');
});

test('roles are enforced on the server and the refusal is audited; every change is audited', { skip }, async () => {
  assert.equal((await call('/admin/growth/campaigns', { acting: analyst })).status, 200, 'an analyst can read');
  const w = await post('/admin/growth/campaigns', { name: `Nope ${tag}` }, analyst);
  assert.equal(w.status, 403);
  assert.equal((await post('/admin/growth/campaigns', { name: `Nope2 ${tag}` }, engineer)).status, 403, 'engineers ship releases, not campaigns');
  const denied = await owner.query(`SELECT 1 FROM admin_audit WHERE admin_user_id = $1 AND action = 'denied' AND detail->>'need' = 'growth.write'`, [analyst]);
  assert.ok(denied.rowCount);
  const made = await owner.query(`SELECT 1 FROM admin_audit WHERE admin_user_id = $1 AND action = 'create_campaign'`, [boss]);
  assert.ok(made.rowCount);
});

test('a release moves its feature flag in stages, records each, and its announcement reaches the inbox as a release note', { skip }, async () => {
  const r = await post('/admin/growth/releases', { version: '1.5.0', channel: 'beta', title: `Planner ${tag}`, notes_md: 'A new planner.', flag_key: flagKey }, engineer);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.release.id as string;
  await post(`/admin/growth/releases/${id}/stage`, { stage_pct: 5, note: 'beta cohort' }, engineer);
  let f = (await owner.query('SELECT enabled, rollout_pct FROM feature_flags WHERE key = $1', [flagKey])).rows[0];
  assert.deepEqual(f, { enabled: true, rollout_pct: 5 });
  await post(`/admin/growth/releases/${id}/stage`, { stage_pct: 0, note: 'crash spike' }, engineer);
  f = (await owner.query('SELECT enabled, rollout_pct FROM feature_flags WHERE key = $1', [flagKey])).rows[0];
  assert.deepEqual(f, { enabled: false, rollout_pct: 0 });
  const list = (await call('/admin/growth/releases', { acting: analyst })).body.releases.find((x: { id: string }) => x.id === id);
  assert.equal(list.status, 'paused');
  assert.deepEqual(list.rollouts.map((x: { stage_pct: number }) => x.stage_pct), [5, 0]);
  const a = await post(`/admin/growth/releases/${id}/announce`, {}, engineer);
  const u = await person('inbox');
  const inbox = (await call('/v1/announcements', { token: u.tok })).body;
  const items = Array.isArray(inbox) ? inbox : inbox.announcements;
  assert.ok(items.some((x: { id: string }) => x.id === a.body.announcement), JSON.stringify(inbox).slice(0, 300));
});

test('the guardrail pauses a live promotion that people keep dismissing, and says why', { skip }, async () => {
  const c = await post('/admin/growth/campaigns', { name: `Annoying ${tag}`, min_gap_seconds: 0 });
  const id = c.body.campaign.id;
  const cr = await post(`/admin/growth/campaigns/${id}/creatives`, { placement: 'inbox', kind: 'card', card: card(`Annoying ${tag}`) });
  await post(`/admin/growth/creatives/${cr.body.creative.id}/publish`, {});
  await post(`/admin/growth/campaigns/${id}/targets`, { user_ids: [boss] }, boss, 'PUT');
  await post(`/admin/growth/campaigns/${id}/status`, { status: 'live' });
  for (let i = 0; i < 60; i++) await owner.query(`INSERT INTO promo_events(event_id, campaign_id, creative_id, placement, type) VALUES ($1,$2,$3,'inbox',$4)`,
    [`g_${tag}_${i}_imp`, id, cr.body.creative.id, 'impression']);
  for (let i = 0; i < 30; i++) await owner.query(`INSERT INTO promo_events(event_id, campaign_id, creative_id, placement, type) VALUES ($1,$2,$3,'inbox','dismiss')`, [`g_${tag}_${i}_dis`, id, cr.body.creative.id]);
  const ov = (await call('/admin/growth/overview', { acting: analyst })).body.campaigns.find((x: { id: string }) => x.id === id);
  assert.equal(ov.impressions, 60); assert.equal(ov.dismiss_rate, 0.5); assert.equal(ov.breaching, true);
  const s = await post('/admin/growth/guardrails/sweep', {});
  assert.ok(s.body.paused.includes(id));
  const k = (await owner.query('SELECT status, paused_reason FROM campaigns WHERE id = $1', [id])).rows[0];
  assert.deepEqual(k, { status: 'paused', paused_reason: 'guardrail: dismiss rate' });
});

test('audience size counts who a target reaches and who promotions cannot reach', { skip }, async () => {
  const r = await post('/admin/growth/audience', { plan_ids: ['free'] }, analyst);
  assert.equal(r.status, 200);
  assert.ok(r.body.matched >= r.body.reachable_promo && r.body.reachable_promo >= 0);
});
