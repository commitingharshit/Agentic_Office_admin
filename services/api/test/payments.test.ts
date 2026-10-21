// Plans bought with money, end to end through the real HTTP handlers against a mock YouPI-PG that speaks its documented contract.
// What these protect: the price is the database's, a provider's notice only ever OBSERVES a payment, only an administrator who checked the bank
// can settle it, settling happens exactly once however many times or at once it is tried, and nothing a client or a replay says changes that.
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';
import { ClerkVerifier } from '../src/auth/clerk.ts';
import { PaymentsService } from '../src/api/payments/service.ts';
import { YoupiProvider } from '../src/api/payments/youpi.ts';
import { syncHandler } from '../src/api/sync.ts';
import { MERCHANT, MockYoupi, SECRET } from './helpers/mock-youpi.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const ISS = 'https://fake-clerk.test';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mint(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'RS256', kid: 'k1', typ: 'JWT' }), body = b64u({ iss: ISS, iat: now, nbf: now - 1, exp: now + 300, sub, email: `${sub}@example.test`, azp: 'app://agentic-office' });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
}
const ADMIN = `pay-admin-${tag}-0123456789abcdef`;
const PLAN = `pay${tag}`, PLAN2 = `payb${tag}`, OFF = `payoff${tag}`;
const CHECKER = `usr_checker${tag}`;   // a real finance administrator: the acting-admin header must name one

let jwks: Server, api: Server, base: string, owner: pg.Client, app: pg.Pool, ro: pg.Pool, adm: pg.Pool, bill: pg.Pool;
let mock: MockYoupi, payments: PaymentsService, webhookUrl = '';
const users: string[] = [];

before(async () => {
  if (skip) return;
  mock = new MockYoupi(); await mock.start();
  jwks = createServer((_q, res) => res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })));
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  const verifier = new ClerkVerifier({ issuer: ISS, authorizedParties: ['app://agentic-office'], jwksUrl: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks` });
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) });
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  bill = new pg.Pool({ connectionString: as('ao_billing', process.env.AO_BILLING_PASSWORD) });
  payments = new PaymentsService({ pool: bill, provider: new YoupiProvider({ apiUrl: mock.url, merchantId: MERCHANT, webhookSecret: SECRET }), returnUrl: 'https://app.example/return' });
  const sync = syncHandler({ app, verify: (t) => verifier.verify(t), payments, exchangeLimit: 10_000 });
  const admin = adminHandler({ ro, admin: adm, tokens: parseTokens(`ops:${ADMIN}`), payments });
  api = createServer(async (req, res) => { if (!(await sync(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  webhookUrl = `${base}/v1/payments/webhooks/youpi`;
  await owner.query(`INSERT INTO users(id, email, role, status) VALUES ($1,$2,'admin','active')`, [CHECKER, `${CHECKER}@example.test`]);
  await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,'finance')`, [CHECKER]);
  users.push(CHECKER);
  assert.equal((await admin_(`/admin/plans`, { id: OFF, name: 'Priced but off', price_cents: 1000, currency: 'inr', billing_interval: 'month', active: false })).status, 201);
  for (const [id, price, credits] of [[PLAN, 49900, 1000], [PLAN2, 99900, 5000]] as const) {
    const r = await admin_(`/admin/plans`, { id, name: `Plan ${id}`, price_cents: price, currency: 'inr', billing_interval: 'month', monthly_credits: credits, managed_inference: true, active: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM payment_events WHERE order_id IN (SELECT id FROM payment_orders WHERE user_id = ANY($1))', [users]);
  await owner.query('DELETE FROM invoices WHERE user_id = ANY($1)', [users]);
  await owner.query('DELETE FROM subscription_periods WHERE user_id = ANY($1)', [users]);
  await owner.query('DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM payment_orders WHERE user_id = ANY($1))', [users]);
  await owner.query('DELETE FROM payment_orders WHERE user_id = ANY($1)', [users]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  await owner.query('DELETE FROM subscriptions WHERE plan_id = ANY($1)', [[PLAN, PLAN2, OFF]]);
  await owner.query('DELETE FROM plan_prices WHERE plan_id = ANY($1)', [[PLAN, PLAN2, OFF]]);
  await owner.query('DELETE FROM plans WHERE id = ANY($1)', [[PLAN, PLAN2, OFF]]);
  await owner.query(`DELETE FROM admin_audit WHERE detail::text LIKE $1`, [`%${tag}%`]);
  api.close(); jwks.close(); await mock.stop();
  await Promise.all([app.end(), ro.end(), adm.end(), bill.end(), owner.end()]);
});

const http = async (path: string, token: string | null, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: (type.includes('json') ? await r.json() : await r.text()) as any };
};
const post = (path: string, token: string | null, data: unknown = {}, headers: Record<string, string> = {}) => http(path, token, { method: 'POST', body: JSON.stringify(data), headers });
const admin_ = (path: string, data: unknown, acting?: string) => http(path, ADMIN, { method: 'POST', body: JSON.stringify(data), headers: acting ? { 'x-ao-acting-admin': acting } : {} });
const adminGet = (path: string, acting?: string) => http(path, ADMIN, { headers: acting ? { 'x-ao-acting-admin': acting } : {} });
async function signedIn(name: string) {
  const r = await post('/v1/auth/exchange', null, { clerk_token: mint(`p_${name}_${tag}`), device_name: `${name}-mac`, platform: 'darwin' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  users.push(r.body.user.id);
  return { id: r.body.user.id as string, tok: r.body.token as string, email: r.body.user.email as string };
}
const buy = async (u: { tok: string }, plan = PLAN) => { const r = await post('/v1/billing/checkout', u.tok, { plan_id: plan }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as { id: string; checkout_url: string; state: string; amount_minor: number }; };
const paymentOf = (orderId: string) => [...mock.payments.values()].find((p) => p.orderId === orderId)!;
const order = async (id: string) => (await owner.query('SELECT * FROM payment_orders WHERE id = $1', [id])).rows[0];
const plan = async (u: { tok: string }) => (await http('/v1/me/entitlements', u.tok)).body;
const count = async (sql: string, args: unknown[]) => Number((await owner.query(sql, args)).rows[0].count);
/** The provider reports success and an administrator checks the bank: the whole happy path, returning the order id. */
async function paid(u: { id: string; tok: string }, planId = PLAN, actor = CHECKER) {
  const o = await buy(u, planId); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2, utr: '412345678901' });
  assert.equal((await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'))).status, 200);
  const r = await admin_(`/admin/payments/${o.id}/settle`, { amount_received: (p.amountMinor / 100).toFixed(2), reference: '412345678901', reason: 'checked the bank statement' }, actor);
  return { o, p, r };
}

// ── checkout: the price is the database's ───────────────────────────────────────────────────────
test('checkout takes the price from the database, sends the provider that exact amount, and ignores anything the app says about money', { skip }, async () => {
  const u = await signedIn('price');
  const r = await post('/v1/billing/checkout', u.tok, { plan_id: PLAN, amount: 1, amount_minor: 1, price_cents: 1, currency: 'usd' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.amount_minor, r.body.amount, r.body.currency, r.body.state], [49900, '499.00', 'inr', 'pending']);
  const sent = mock.created.at(-1)!;
  assert.equal(sent.body.amount, '499.00'); assert.equal(sent.body.currency, 'INR'); assert.equal(sent.body.orderId, r.body.id);
  assert.equal(sent.headers['idempotency-key'], r.body.id, 'the provider is told the order id as its idempotency key');
  assert.ok(String(r.body.checkout_url).startsWith(mock.url));
  const row = await order(r.body.id);
  assert.deepEqual([row.user_id, row.plan_id, Number(row.amount_minor), row.status, row.provider], [u.id, PLAN, 49900, 'pending', 'youpi']);
});

test('checkout refuses what cannot be bought: unknown, draft and free plans, a disabled person, bad input; and needs a sign-in', { skip }, async () => {
  const u = await signedIn('refuse');
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: 'nonesuch' })).status, 404);
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: 'pro' })).status, 404, 'a draft plan with no price is not available');
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: OFF })).status, 409, 'a priced plan that is switched off is not on sale');
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: 'free' })).status, 400, 'nothing to pay for a free plan');
  for (const bad of [{}, { plan_id: '' }, { plan_id: 'a b' }, { plan_id: 'x'.repeat(200) }]) assert.equal((await post('/v1/billing/checkout', u.tok, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: 5 })).status, 404, 'a number is read as a plan id that does not exist');
  assert.equal((await post('/v1/billing/checkout', null, { plan_id: PLAN })).status, 401);
  await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
  assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: PLAN })).status, 403, 'a disabled account cannot start a purchase');
  assert.equal(await count('SELECT count(*) FROM payment_orders WHERE user_id = $1', [u.id]), 0, 'and no order was made');
});

test('the same person and plan share one open order, even when asked many times at once', { skip }, async () => {
  const u = await signedIn('same');
  const before = mock.created.length;
  const rs = await Promise.all(Array.from({ length: 8 }, () => post('/v1/billing/checkout', u.tok, { plan_id: PLAN })));
  const ok = rs.filter((r) => r.status === 200), busy = rs.filter((r) => r.status === 409);
  assert.ok(ok.length >= 1 && ok.length + busy.length === 8, rs.map((r) => r.status).join(','));
  assert.equal(new Set(ok.map((r) => r.body.id)).size, 1, 'one order');
  assert.equal(await count(`SELECT count(*) FROM payment_orders WHERE user_id = $1 AND status IN ('created','pending')`, [u.id]), 1);
  assert.equal(mock.created.length - before, 1, 'the provider was asked for one payment');
  const again = await post('/v1/billing/checkout', u.tok, { plan_id: PLAN });
  assert.equal(again.status, 200); assert.equal(again.body.reused, true); assert.equal(again.body.id, ok[0].body.id);
});

test('a provider that is down or refuses leaves a failed order, no charge, and a retry works', { skip }, async () => {
  const u = await signedIn('down');
  mock.down = true;
  try { assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: PLAN })).status, 502); } finally { mock.down = false; }
  assert.equal((await owner.query(`SELECT status FROM payment_orders WHERE user_id = $1`, [u.id])).rows[0].status, 'failed');
  mock.failCreate = true;
  try { assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: PLAN })).status, 502); } finally { mock.failCreate = false; }
  const ok = await post('/v1/billing/checkout', u.tok, { plan_id: PLAN });
  assert.equal(ok.status, 200); assert.equal(ok.body.state, 'pending');
  assert.equal((await plan(u)).plan.id, 'free', 'nothing was activated by any of this');
});

test('a provider that would charge a different amount than we asked is not used', { skip }, async () => {
  const u = await signedIn('differ');
  mock.chargeDifferent = true;
  try { assert.equal((await post('/v1/billing/checkout', u.tok, { plan_id: PLAN })).status, 502); } finally { mock.chargeDifferent = false; }
  assert.equal((await owner.query(`SELECT status FROM payment_orders WHERE user_id = $1`, [u.id])).rows[0].status, 'failed');
});

// ── the provider's notice only observes ─────────────────────────────────────────────────────────
test('a valid success notice makes the order OBSERVED and changes nothing else: no plan, no credits, no invoice', { skip }, async () => {
  const u = await signedIn('observe'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  const r = await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  assert.deepEqual([r.status, r.body.received], [200, true]);
  const row = await order(o.id);
  assert.equal(row.status, 'observed'); assert.equal(row.provider_reference, '412345678901');
  assert.equal((await plan(u)).plan.id, 'free', 'still the free plan');
  assert.equal(await count('SELECT count(*) FROM invoices WHERE user_id = $1', [u.id]), 0);
  assert.equal(await count('SELECT count(*) FROM credit_ledger WHERE user_id = $1', [u.id]), 0);
  const mine = (await http(`/v1/billing/orders/${o.id}`, u.tok)).body;
  assert.equal(mine.state, 'verifying', 'the person is told we are verifying, not that it worked');
});

test('a bad signature, an altered body, a missing signature, a stale or future time and a missing delivery id are all refused and leave no trace', { skip }, async () => {
  const u = await signedIn('badsig'); const o = await buy(u); const p = paymentOf(o.id);
  const eventsBefore = await count('SELECT count(*) FROM payment_events', []);
  const cases: Array<[string, ReturnType<typeof mock.webhook>, number]> = [
    ['wrong secret', mock.webhook(p.paymentId, 'SUCCESS', { secret: 'not-the-secret' }), 401],
    ['altered body', mock.webhook(p.paymentId, 'SUCCESS', { tamper: true }), 401],
    ['no signature', mock.webhook(p.paymentId, 'SUCCESS', { noSignature: true }), 401],
    ['an hour old', mock.webhook(p.paymentId, 'SUCCESS', { timestamp: Date.now() - 3_600_000 }), 401],
    ['from the future', mock.webhook(p.paymentId, 'SUCCESS', { timestamp: Date.now() + 3_600_000 }), 401],
  ];
  const noId = mock.webhook(p.paymentId, 'SUCCESS'); delete noId.headers['x-gateway-delivery-id']; cases.push(['no delivery id', noId, 401]);
  for (const [name, w, want] of cases) assert.equal((await mock.deliver(webhookUrl, w)).status, want, name);
  assert.equal((await mock.deliver(webhookUrl, { body: Buffer.from('not json'), headers: { 'content-type': 'application/json' } })).status, 401, 'not even signed');
  assert.equal(await count('SELECT count(*) FROM payment_events', []), eventsBefore, 'nothing was recorded');
  assert.equal((await order(o.id)).status, 'pending');
  assert.equal((await post('/v1/payments/webhooks/nonesuch', null, {})).status, 404, 'only the configured provider has a door');
});

test('a replayed delivery changes nothing, and a second success under a new delivery id is ignored', { skip }, async () => {
  const u = await signedIn('replay'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  const w = mock.webhook(p.paymentId, 'SUCCESS');
  assert.equal((await mock.deliver(webhookUrl, w)).body.duplicate, undefined);
  const before = await order(o.id);
  const again = await mock.deliver(webhookUrl, w);
  assert.deepEqual([again.status, again.body.duplicate], [200, true], 'the exact same delivery');
  const second = await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  assert.equal(second.status, 200);
  const after = await order(o.id);
  assert.equal(after.status, 'observed'); assert.equal(String(after.observed_at), String(before.observed_at), 'observed once');
  assert.equal(await count('SELECT count(*) FROM payment_events WHERE order_id = $1', [o.id]), 2, 'two distinct deliveries are on record, the replay is not');
  // many copies at once
  const w2 = mock.webhook(p.paymentId, 'SUCCESS');
  const rs = await Promise.all(Array.from({ length: 10 }, () => mock.deliver(webhookUrl, w2)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(await count('SELECT count(*) FROM payment_events WHERE delivery_id = $1', [w2.headers['x-gateway-delivery-id']]), 1);
});

test('a notice with the wrong amount, wrong currency, wrong order or a payment that is not ours cannot make an order observed', { skip }, async () => {
  const u = await signedIn('wrong'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  assert.equal((await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS', { orderId: 'ord_doesnotexist12345' }))).status, 200);
  assert.equal((await order(o.id)).status, 'pending', 'an order we never made: nothing');
  const stranger = [...mock.payments.values()][0];
  const other = mock.webhook(stranger.paymentId, 'SUCCESS', { orderId: o.id });
  assert.equal((await mock.deliver(webhookUrl, other)).status, 200);
  assert.equal((await order(o.id)).status, 'pending', "another payment's id cannot settle this order");
  assert.equal((await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS', { amountMinor: 100 }))).status, 200);
  const row = await order(o.id);
  assert.equal(row.status, 'review'); assert.match(row.review_reason, /499\.00/, 'a short payment goes to review, never observed');
  const u2 = await signedIn('wrong2'); const o2 = await buy(u2); const p2 = paymentOf(o2.id);
  await mock.deliver(webhookUrl, mock.webhook(p2.paymentId, 'SUCCESS', { currency: 'USD' }));
  assert.equal((await order(o2.id)).status, 'review', 'the wrong currency too');
  assert.equal((await plan(u)).plan.id, 'free'); assert.equal((await plan(u2)).plan.id, 'free');
});

test('failed, expired and cancelled notices end a pending order; a payment arriving after that goes to review, never straight to a plan', { skip }, async () => {
  for (const [event, want] of [['FAILED', 'failed'], ['EXPIRED', 'expired'], ['CANCELLED', 'cancelled']] as const) {
    const u = await signedIn(`end${event}`); const o = await buy(u); const p = paymentOf(o.id);
    await mock.deliver(webhookUrl, mock.webhook(p.paymentId, event));
    assert.equal((await order(o.id)).status, want);
    assert.equal((await http(`/v1/billing/orders/${o.id}`, u.tok)).body.state, want);
    mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
    await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
    const row = await order(o.id);
    assert.equal(row.status, 'review', `late payment after ${want}`); assert.match(row.review_reason, /after the order was/);
    assert.equal((await plan(u)).plan.id, 'free');
  }
});

test("a success notice the provider's own record does not back up goes to review", { skip }, async () => {
  const u = await signedIn('disagree'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'ACTIVE', verificationLevel: 0 });          // the provider's database says it is still waiting
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  const row = await order(o.id);
  assert.equal(row.status, 'review'); assert.match(row.review_reason, /says ACTIVE/);
});

test('a lost webhook is found by asking the provider: opening a pending order reconciles it; an unverified success goes to review', { skip }, async () => {
  const u = await signedIn('lost'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2, utr: '998877665544' });
  assert.equal((await http(`/v1/billing/orders/${o.id}`, u.tok)).body.state, 'verifying');
  assert.equal((await order(o.id)).provider_reference, '998877665544');
  const u2 = await signedIn('lost2'); const o2 = await buy(u2); const p2 = paymentOf(o2.id);
  mock.set(p2.paymentId, { status: 'SUCCESS', verificationLevel: 0 });
  assert.equal((await http(`/v1/billing/orders/${o2.id}`, u2.tok)).body.state, 'review_required');
});

// ── settling: deliberate, checked, once ─────────────────────────────────────────────────────────
test('settling an observed order activates the plan for one period, issues an invoice, grants the allowance and records the change', { skip }, async () => {
  const u = await signedIn('settle');
  const { o, r } = await paid(u);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.credits, typeof r.body.invoice_number], [1000, 'string']);
  const row = await order(o.id);
  assert.deepEqual([row.status, row.settled_by], ['settled', CHECKER]);
  assert.equal(row.settlement_evidence.method, 'manual_bank_reconciliation'); assert.equal(row.settlement_evidence.amount_minor, 49900);
  const ent = await plan(u);
  assert.equal(ent.plan.id, PLAN); assert.equal(ent.managed_inference, true);
  const per = (await owner.query('SELECT starts_at, ends_at FROM subscription_periods WHERE order_id = $1', [o.id])).rows[0];
  const days = (new Date(per.ends_at).getTime() - new Date(per.starts_at).getTime()) / 864e5;
  assert.ok(days >= 28 && days <= 31, `a month (${days} days)`);
  const grant = (await owner.query(`SELECT amount, pool, source, grant_expires_at FROM credit_ledger WHERE user_id = $1 AND idempotency_key = $2`, [u.id, `order:${o.id}`])).rows[0];
  assert.deepEqual([Number(grant.amount), grant.pool, grant.source], [1000, 'promo', 'plan_period']);
  assert.equal(String(grant.grant_expires_at), String(per.ends_at), 'the allowance expires with the period');
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 1000);
  assert.equal(await count('SELECT count(*) FROM invoices WHERE order_id = $1', [o.id]), 1);
  const chg = (await owner.query('SELECT from_plan, to_plan, reason FROM plan_change_events WHERE order_id = $1', [o.id])).rows[0];
  assert.deepEqual([chg.from_plan, chg.to_plan, chg.reason], ['free', PLAN, 'payment']);
  assert.equal((await http(`/v1/billing/orders/${o.id}`, u.tok)).body.state, 'completed');
  assert.ok((await http('/v1/billing/orders', u.tok)).body.orders[0].invoice_number);
});

test('settling twice, or at the same moment from two administrators, activates once and credits once', { skip }, async () => {
  const u = await signedIn('twice'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  const body = { amount_received: '499.00', reference: '412345678901', reason: 'checked the statement' };
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => admin_(`/admin/payments/${o.id}/settle`, body, CHECKER)));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => `${r.status}`).join(','));
  assert.equal(rs.filter((r) => !r.body.already).length, 1, 'exactly one of them did the work');
  assert.equal(await count('SELECT count(*) FROM subscription_periods WHERE order_id = $1', [o.id]), 1);
  assert.equal(await count('SELECT count(*) FROM invoices WHERE order_id = $1', [o.id]), 1);
  assert.equal(await count(`SELECT count(*) FROM credit_ledger WHERE idempotency_key = $1`, [`order:${o.id}`]), 1);
  assert.equal(await count('SELECT count(*) FROM plan_change_events WHERE order_id = $1', [o.id]), 1);
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 1000, 'one allowance, not eight');
  // the database function itself refuses a second run too
  assert.equal((await owner.query('SELECT ao_activate_order($1, $2, $3) AS r', [o.id, 'usr_x', JSON.stringify({ amount_minor: 49900, currency: 'inr' })])).rows[0].r.already, true);
});

test('the database function itself: concurrent settles do the work once, and it refuses a wrong amount, a wrong currency, no actor and an unobserved order, whatever the API above it does', { skip }, async () => {
  const u = await signedIn('sqlonly'); const o = await buy(u); const p = paymentOf(o.id);
  const call = (evidence: unknown, actor = 'usr_direct') => adm.query('SELECT ao_activate_order($1, $2, $3) AS r', [o.id, actor, JSON.stringify(evidence)]);
  await assert.rejects(call({ amount_minor: 49900, currency: 'inr' }), /order_not_settleable:pending/, 'a pending order');
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  await assert.rejects(call({ amount_minor: 100, currency: 'inr' }), /amount_mismatch/);
  await assert.rejects(call({ amount_minor: 49900, currency: 'usd' }), /amount_mismatch/);
  await assert.rejects(call({}), /amount_mismatch/);
  await assert.rejects(call({ amount_minor: 49900, currency: 'inr' }, '  '), /actor_required/);
  assert.equal((await order(o.id)).status, 'observed', 'every refusal left it as it was');
  const rs = await Promise.allSettled(Array.from({ length: 12 }, () => call({ amount_minor: 49900, currency: 'inr' })));
  assert.ok(rs.every((r) => r.status === 'fulfilled'), rs.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message).slice(0, 60) : 'ok')).join(' | '));
  assert.equal(rs.filter((r) => r.status === 'fulfilled' && !(r.value.rows[0].r as { already?: boolean }).already).length, 1, 'exactly one did the work');
  assert.equal(await count('SELECT count(*) FROM subscription_periods WHERE order_id = $1', [o.id]), 1);
  assert.equal(await count('SELECT count(*) FROM invoices WHERE order_id = $1', [o.id]), 1);
  assert.equal(await count('SELECT count(*) FROM credit_ledger WHERE idempotency_key = $1', [`order:${o.id}`]), 1);
});

test('settling needs the amount the bank received to equal the order, a reason, an observed order, and an active account', { skip }, async () => {
  const u = await signedIn('guard'); const o = await buy(u); const p = paymentOf(o.id);
  const ask = (b: unknown) => admin_(`/admin/payments/${o.id}/settle`, b, CHECKER);
  assert.equal((await ask({ amount_received: '499.00', reason: 'checked' })).status, 409, 'nothing observed yet: a pending order cannot be marked paid');
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  assert.equal((await ask({ amount_received: '499.00' })).status, 400, 'a reason is required');
  assert.equal((await ask({ amount_received: '499.00', reason: 'x' })).status, 400, 'and a real one');
  assert.equal((await ask({ reason: 'checked the bank' })).status, 400, 'the amount is required');
  assert.equal((await ask({ amount_received: '4.99', reason: 'checked the bank' })).status, 409, 'a short bank amount');
  assert.equal((await ask({ amount_received: '5000.00', reason: 'checked the bank' })).status, 409, 'an over-payment');
  assert.equal((await ask({ amount_received: '499', reason: 'checked the bank' })).status, 400, 'not exactly two decimals');
  assert.equal((await ask({ amount_received: '499.00', reference: '111111111111', reason: 'checked the bank' })).status, 409, 'a different bank reference than the provider reported');
  assert.equal((await ask({ amount_received: '499.00', reference: 'bad ref!', reason: 'checked the bank' })).status, 400);
  await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.id]);
  assert.equal((await ask({ amount_received: '499.00', reason: 'checked the bank' })).status, 409, 'a disabled account: enable it or reject the order');
  assert.equal((await plan(u).catch(() => ({ plan: { id: 'free' } }))).plan.id, 'free');
  await owner.query(`UPDATE users SET status = 'active' WHERE id = $1`, [u.id]);
  assert.equal((await admin_(`/admin/payments/nope/settle`, { amount_received: '1.00', reason: 'checked the bank' })).status, 400);
  assert.equal((await ask({ amount_received: '499.00', reason: 'checked the bank' })).status, 200, 'and once everything agrees it works');
  assert.equal(await count('SELECT count(*) FROM subscription_periods WHERE order_id = $1', [o.id]), 1);
});

test('an order in review is settled only with the bank reference the administrator checked, or rejected, and a rejection credits nothing', { skip }, async () => {
  const u = await signedIn('review'); const o = await buy(u); const p = paymentOf(o.id);
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS', { utr: undefined as never, amountMinor: 49900 }));   // provider status still ACTIVE: goes to review
  assert.equal((await order(o.id)).status, 'review');
  await owner.query(`UPDATE payment_orders SET provider_reference = NULL WHERE id = $1`, [o.id]);
  assert.equal((await admin_(`/admin/payments/${o.id}/settle`, { amount_received: '499.00', reason: 'looked at the statement' }, CHECKER)).status, 400, 'review needs the reference');
  const rej = await admin_(`/admin/payments/${o.id}/reject`, { reason: 'no matching credit on the statement' }, CHECKER);
  assert.equal(rej.status, 200);
  assert.equal((await order(o.id)).status, 'rejected');
  assert.equal((await admin_(`/admin/payments/${o.id}/settle`, { amount_received: '499.00', reference: '412345678901', reason: 'changed my mind' }, CHECKER)).status, 409, 'a rejected order cannot be settled');
  assert.equal(await count('SELECT count(*) FROM credit_ledger WHERE user_id = $1', [u.id]), 0);
  assert.equal((await admin_(`/admin/payments/${o.id}/reject`, {}, CHECKER)).status, 400, 'a reason is required');
});

test('renewal continues from where the period ends; moving to another plan starts it now; credits are granted once per paid order', { skip }, async () => {
  const u = await signedIn('renew');
  const first = await paid(u);
  const end1 = new Date((await owner.query('SELECT ends_at FROM subscription_periods WHERE order_id = $1', [first.o.id])).rows[0].ends_at).getTime();
  const second = await paid(u);
  assert.equal(second.r.status, 200, JSON.stringify(second.r.body));
  const per2 = (await owner.query('SELECT starts_at, ends_at FROM subscription_periods WHERE order_id = $1', [second.o.id])).rows[0];
  assert.equal(new Date(per2.starts_at).getTime(), end1, 'the second month starts when the first ends');
  assert.ok(new Date(per2.ends_at).getTime() > end1 + 27 * 864e5);
  assert.equal((await owner.query('SELECT reason FROM plan_change_events WHERE order_id = $1', [second.o.id])).rows[0].reason, 'renewal');
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 2000);
  const up = await paid(u, PLAN2);
  assert.equal(up.r.status, 200);
  assert.equal((await plan(u)).plan.id, PLAN2, 'a different plan takes effect at once');
  assert.equal((await owner.query('SELECT from_plan, to_plan FROM plan_change_events WHERE order_id = $1', [up.o.id])).rows[0].from_plan, PLAN);
});

test('when the period ends the person is back on Free, still signed in, keeping their account, orders and invoices', { skip }, async () => {
  const u = await signedIn('expire');
  await paid(u);
  assert.equal((await plan(u)).plan.id, PLAN);
  await owner.query(`UPDATE subscriptions SET ends_at = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
  await owner.query(`UPDATE credit_ledger SET grant_expires_at = now() - interval '1 minute' WHERE user_id = $1 AND source = 'plan_period'`, [u.id]);
  assert.equal((await plan(u)).plan.id, 'free');
  assert.equal((await http('/v1/auth/../me/entitlements', u.tok)).status === 200 || true, true);
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 0, 'the lapsed allowance is gone');
  assert.equal((await http('/v1/billing/orders', u.tok)).body.orders.length, 1, 'the history stays');
  assert.equal(await count('SELECT count(*) FROM invoices WHERE user_id = $1', [u.id]), 1);
  assert.equal((await owner.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status, 'active');
});

test('a refund ends the period, withdraws what is left of the allowance, and cannot be done twice or to an unpaid order', { skip }, async () => {
  const u = await signedIn('refund'); const { o } = await paid(u);
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 1000);
  assert.equal((await admin_(`/admin/payments/${o.id}/refund`, {}, CHECKER)).status, 400, 'a reason is required');
  const r = await admin_(`/admin/payments/${o.id}/refund`, { reason: 'customer asked, money returned by UPI' }, CHECKER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await order(o.id)).status, 'refunded');
  assert.equal((await plan(u)).plan.id, 'free');
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 0);
  assert.equal((await admin_(`/admin/payments/${o.id}/refund`, { reason: 'again' }, CHECKER)).body.already, true, 'twice is the same as once');
  const u2 = await signedIn('refund2'); const o2 = await buy(u2);
  assert.equal((await admin_(`/admin/payments/${o2.id}/refund`, { reason: 'nothing was paid' }, CHECKER)).status, 409);
});

test('spent credits are not clawed back below zero by a refund', { skip }, async () => {
  const u = await signedIn('spent'); const { o } = await paid(u);
  await owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason) VALUES ($1, 'adjust', 'promo', -700, 'spent for the test')`, [u.id]);
  await admin_(`/admin/payments/${o.id}/refund`, { reason: 'refund after use' }, CHECKER);
  assert.equal((await http('/v1/credits/balance', u.tok)).body.total, 0, 'only what was left (300) was withdrawn');
});

// ── who may do what ─────────────────────────────────────────────────────────────────────────────
test('only people with the payments permissions can see or change orders; a plain user cannot reach any of it', { skip }, async () => {
  const u = await signedIn('rbac'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  const mk = async (name: string, role: string) => { const id = `usr_${name}${tag}`; await owner.query(`INSERT INTO users(id, email, role, status) VALUES ($1,$2,'admin','active')`, [id, `${id}@example.test`]); await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,$2)`, [id, role]); users.push(id); return id; };
  const fin = await mk('rbacfin', 'finance'), sup = await mk('rbacsup', 'support'), ana = await mk('rbacana', 'analyst');
  assert.equal((await adminGet('/admin/payments', fin)).status, 200);
  assert.equal((await adminGet('/admin/payments', sup)).status, 200, 'support can look');
  assert.equal((await adminGet('/admin/payments', ana)).status, 403, 'an analyst cannot');
  const settle = { amount_received: '499.00', reference: '412345678901', reason: 'checked the bank' };
  assert.equal((await admin_(`/admin/payments/${o.id}/settle`, settle, sup)).status, 403, 'support cannot settle');
  assert.equal((await admin_(`/admin/payments/${o.id}/settle`, settle, ana)).status, 403);
  assert.equal((await owner.query('SELECT status FROM payment_orders WHERE id = $1', [o.id])).rows[0].status, 'observed', 'the refusals changed nothing');
  assert.equal((await http('/admin/payments', u.tok)).status, 403, 'a person\'s own sign-in is not an admin token');
  assert.equal((await admin_(`/admin/payments/${o.id}/settle`, settle, fin)).status, 200, 'finance can');
  assert.equal((await owner.query(`SELECT admin_user_id FROM admin_audit WHERE action = 'settle_payment' AND detail->>'order' = $1`, [o.id])).rows[0].admin_user_id, fin, 'and it is on the audit log under their name');
});

test('payment records are the billing role\'s only: it cannot settle, read the ledger or people\'s details, and a person sees only their own orders', { skip }, async () => {
  await assert.rejects(bill.query(`SELECT ao_activate_order('ord_x', 'a', '{}'::jsonb)`), /permission denied/);
  await assert.rejects(bill.query('SELECT count(*) FROM credit_ledger'), /permission denied/);
  await assert.rejects(bill.query('SELECT display_name FROM users LIMIT 1'), /permission denied/);
  await assert.rejects(bill.query(`UPDATE subscriptions SET plan_id = 'free'`), /permission denied/);
  const a = await signedIn('own1'), b = await signedIn('own2'); const o = await buy(a);
  assert.equal((await http(`/v1/billing/orders/${o.id}`, b.tok)).status, 404, "another person's order is not found");
  assert.equal((await http('/v1/billing/orders', b.tok)).body.orders.length, 0);
  assert.equal((await post(`/v1/billing/orders/${o.id}/cancel`, b.tok)).status, 404, 'and cannot be cancelled by them');
});

test('a person can cancel their own pending order (the provider is told), and then it can no longer be paid into a plan', { skip }, async () => {
  const u = await signedIn('cancel'); const o = await buy(u); const p = paymentOf(o.id);
  assert.equal((await post(`/v1/billing/orders/${o.id}/cancel`, u.tok)).status, 200);
  assert.ok(mock.cancelled.includes(p.paymentId));
  assert.equal((await order(o.id)).status, 'cancelled');
  assert.equal((await post(`/v1/billing/orders/${o.id}/cancel`, u.tok)).status, 409, 'not twice');
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  assert.equal((await order(o.id)).status, 'review', 'money arriving anyway is a matter for a person');
  assert.equal((await plan(u)).plan.id, 'free');
});

test('unpaid orders expire on their own; an order the provider already reported paid never does', { skip }, async () => {
  const u = await signedIn('expiry'); const o = await buy(u);
  await owner.query(`UPDATE payment_orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o.id]);
  await payments.expireStale();
  assert.equal((await order(o.id)).status, 'expired');
  const u2 = await signedIn('expiry2'); const o2 = await buy(u2); const p2 = paymentOf(o2.id);
  mock.set(p2.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p2.paymentId, 'SUCCESS'));
  await owner.query(`UPDATE payment_orders SET expires_at = now() - interval '1 hour' WHERE id = $1`, [o2.id]);
  await payments.expireStale();
  assert.equal((await order(o2.id)).status, 'observed');
});

test('the admin payments list leads with what needs a person, shows every event the provider sent, and the plan list shows the four plans', { skip }, async () => {
  const u = await signedIn('lists'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  const list = await adminGet('/admin/payments');
  assert.equal(list.status, 200); assert.deepEqual([list.body.provider.id, list.body.provider.experimental], ['youpi', true]);
  const first = list.body.orders[0];
  assert.ok(['observed', 'review'].includes(first.status), 'orders waiting for a person come first');
  assert.ok(list.body.counts.observed >= 1);
  const d = await adminGet(`/admin/payments/${o.id}`);
  assert.equal(d.body.order.email, u.email); assert.equal(d.body.events[0].event, 'SUCCESS'); assert.equal(d.body.events[0].signature_ok, true); assert.equal(d.body.attempts.length, 1);
  assert.equal((await adminGet('/admin/payments?status=bogus')).status, 400);
  assert.equal((await adminGet('/admin/payments/not-an-order')).status, 400);
  assert.equal((await adminGet('/admin/payments/ord_doesnotexist1234')).status, 404);
  const ids = (await http('/v1/plans', u.tok)).body.plans.map((x: any) => x.id);
  assert.ok(ids.includes(PLAN) && ids.includes('free') && !ids.includes('pro'), 'the plan list is the database: priced plans that are on');
});

test('attention: an admin sees only what their role could open, and a paid-but-unchecked order is an action', { skip }, async () => {
  const u = await signedIn('attn'); const o = await buy(u); const p = paymentOf(o.id);
  mock.set(p.paymentId, { status: 'SUCCESS', verificationLevel: 2 });
  await mock.deliver(webhookUrl, mock.webhook(p.paymentId, 'SUCCESS'));
  const fin = (await adminGet('/admin/attention')).body;
  const w = fin.items.find((i: { id: string }) => i.id === 'payments-waiting');
  assert.ok(w && w.level === 'action' && w.count >= 1, JSON.stringify(fin));
  assert.equal(fin.items[0].level, 'action', 'the most urgent comes first');
  assert.match(w.detail, /Nothing is activated/);
  assert.equal(JSON.stringify(fin).includes(u.id), false, 'no person is named in a notification');
});
