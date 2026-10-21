// Promotions through the real HTTP handlers and Postgres (row-level security as ao_app): eligibility, events, frequency,
// dismissal, consent, ad-free entitlement, the person's own choices, and signed media links.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { ClerkVerifier } from '../src/auth/clerk.ts';
import { syncHandler } from '../src/api/sync.ts';
import { mediaLink } from '../src/growth/engine.ts';

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
const KEY = Buffer.alloc(32, 3);
let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool;
const users: string[] = [];
const campaigns: string[] = [];

before(async () => {
  if (skip) return;
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), exchangeLimit: 10_000, mediaKey: KEY });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) { res.writeHead(404); res.end('{}'); } });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM campaigns WHERE id = ANY($1)', [campaigns]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  api.close(); jwks.close();
  await Promise.all([app.end(), owner.end()]);
});

const http = async (path: string, token: string | null, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const send = (path: string, token: string | null, data: unknown, method = 'POST') => http(path, token, { method, body: JSON.stringify(data) });
async function signedIn(name: string) {
  const r = await send('/v1/auth/exchange', null, { clerk_token: mint(`g_${name}_${tag}`), device_name: `${name}-mac`, platform: 'darwin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id as string, tok: r.body.token as string };
}
// Every campaign here is targeted at the test's own people, so test files running side by side never see each other's campaigns.
async function campaign(name: string, people: string[], over: { tier?: string; priority?: number; max?: number; gap?: number; placement?: string; plans?: string[] } = {}) {
  const id = `c_${name}_${tag}`; campaigns.push(id);
  await owner.query(`INSERT INTO campaigns(id, name, status, tier, priority, starts_at, max_impressions, min_gap_seconds) VALUES ($1,$2,'live',$3,$4, now() - interval '1 hour', $5, $6)`,
    [id, name, over.tier ?? 'promo', over.priority ?? 0, over.max ?? 3, over.gap ?? 0]);
  await owner.query('INSERT INTO campaign_targets(campaign_id, plan_ids, user_ids) VALUES ($1, $2, $3)', [id, over.plans ?? null, people]);
  await owner.query(`INSERT INTO creatives(id, campaign_id, placement_id, kind, headline, card, status) VALUES ($1,$2,$3,'card',$4,$5,'ready')`,
    [`cr_${id}`, id, over.placement ?? 'chat_empty', name, JSON.stringify({ v: 1, layout: 'stack', blocks: [{ type: 'heading', text: name }] })]);
  return id;
}
let ev = 0;
const event = (c: string, type: string, placement = 'chat_empty') => ({ event_id: `e_${tag}_${++ev}_abcd`, campaign_id: c, creative_id: `cr_${c}`, placement, type });
const eligible = (tok: string, placement = 'chat_empty') => http(`/v1/promotions/eligible?placement=${placement}&contract=1&platform=darwin`, tok);

test('the eligible promotion comes back with its validated card; it needs sign-in and a known placement', { skip }, async () => {
  const u = await signedIn('basic');
  const c = await campaign('basic', [u.id], { priority: 90 });
  assert.equal((await http('/v1/promotions/eligible?placement=chat_empty', null)).status, 401);
  assert.equal((await eligible(u.tok, 'popup')).status, 400);
  const r = await eligible(u.tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.item.campaign_id, c);
  assert.equal(r.body.item.card.disclosure, 'Featured');
  assert.equal(r.body.item.card.blocks[0].text, 'basic');
});

test('events are counted once per event id; impressions drive the frequency cap and a dismissal ends it', { skip }, async () => {
  const u = await signedIn('freq');
  const c = await campaign('freq', [u.id], { priority: 95, max: 2 });
  const e1 = event(c, 'impression');
  assert.deepEqual((await send('/v1/promotions/events', u.tok, { events: [e1, e1] })).body, { accepted: 1, duplicate: 1, linked: false });
  assert.equal((await eligible(u.tok)).body.item?.campaign_id, c, 'one impression of two');
  await send('/v1/promotions/events', u.tok, { events: [event(c, 'impression')] });
  assert.notEqual((await eligible(u.tok)).body.item?.campaign_id, c, 'cap reached');
  const d = await campaign('dismiss', [u.id], { priority: 99 });
  assert.equal((await eligible(u.tok)).body.item?.campaign_id, d);
  await send('/v1/promotions/events', u.tok, { events: [event(d, 'dismiss')] });
  assert.notEqual((await eligible(u.tok)).body.item?.campaign_id, d, 'dismissed is never shown again');
});

test('an event cannot name a creative from another campaign or placement', { skip }, async () => {
  const u = await signedIn('forge');
  const c = await campaign('forge', [u.id]);
  const bad = { ...event(c, 'click'), placement: 'bottom_strip' };
  assert.equal((await send('/v1/promotions/events', u.tok, { events: [bad] })).status, 400);
  assert.equal((await send('/v1/promotions/events', u.tok, { events: [{ ...event(c, 'click'), type: 'purchase' }] })).status, 400);
});

test('events are linked to the person only when they share usage', { skip }, async () => {
  const u = await signedIn('consent');
  const c = await campaign('consent', [u.id]);
  await send('/v1/promotions/events', u.tok, { events: [event(c, 'view')] });
  await owner.query('INSERT INTO usage_consent(user_id, shared) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET shared = true', [u.id]);
  assert.equal((await send('/v1/promotions/events', u.tok, { events: [event(c, 'click')] })).body.linked, true);
  const rows = (await owner.query('SELECT type, user_id FROM promo_events WHERE campaign_id = $1 ORDER BY id', [c])).rows;
  assert.deepEqual(rows.map((r) => [r.type, r.user_id]), [['view', null], ['click', u.id]]);
});

test('an ad-free plan or entitlement and the person\'s own switch remove promotions but not release notes', { skip }, async () => {
  const u = await signedIn('adfree');
  const p = await campaign('adfree-promo', [u.id], { priority: 98, placement: 'bottom_strip' });
  assert.equal((await eligible(u.tok, 'bottom_strip')).body.item?.campaign_id, p);
  await owner.query(`INSERT INTO entitlements(user_id, key, value, source) VALUES ($1, 'ad_free', 'true', 'test')`, [u.id]);
  assert.notEqual((await eligible(u.tok, 'bottom_strip')).body.item?.campaign_id, p);
  const rel = await campaign('adfree-release', [u.id], { tier: 'release', placement: 'bottom_strip' });
  assert.equal((await eligible(u.tok, 'bottom_strip')).body.item?.campaign_id, rel);
  const v = await signedIn('optout');
  const vp = await campaign('optout-promo', [v.id], { priority: 98, placement: 'bottom_strip' });
  assert.equal((await eligible(v.tok, 'bottom_strip')).body.item?.campaign_id, vp);
  assert.equal((await send('/v1/promotions/prefs', v.tok, { in_app: false }, 'PUT')).body.in_app, false);
  const got = (await eligible(v.tok, 'bottom_strip')).body.item;
  assert.ok(!got || got.tier !== 'promo', 'no promotion for someone who switched them off');
});

test('prefs: marketing email is off by default; switching it off records when', { skip }, async () => {
  const u = await signedIn('prefs');
  assert.deepEqual((await http('/v1/promotions/prefs', u.tok)).body, { in_app: true, email_marketing: false, unsubscribed_at: null });
  assert.equal((await send('/v1/promotions/prefs', u.tok, { email_marketing: true }, 'PUT')).body.email_marketing, true);
  const off = (await send('/v1/promotions/prefs', u.tok, { email_marketing: false }, 'PUT')).body;
  assert.equal(off.email_marketing, false);
  assert.ok(off.unsubscribed_at);
  assert.equal((await send('/v1/promotions/prefs', u.tok, { in_app: 'no' }, 'PUT')).status, 400);
});

test('media links: a forged or expired link is refused before storage is touched', { skip }, async () => {
  const good = mediaLink(KEY, 1);
  assert.equal((await http(good.replace(/s=[^&]+/, 's=forged'), null)).status, 403);
  assert.equal((await http(mediaLink(Buffer.alloc(32, 9), 1), null)).status, 403);
  assert.equal((await http(good, null)).status, 503, 'valid signature, no storage configured in this test');
});
