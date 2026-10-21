// Account money and access: balance, coupons, usage, entitlements, the devices a user is signed in
// on, and API keys. Every function takes a client already inside a request transaction with
// app.user_id set (sync.ts `asUser`), so row-level security scopes every read to that user, and the
// money itself only moves through the ao_* SQL functions (db/migrations/0007_billing.sql).
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export interface Mapped { status: number; message: string }

/** The ao_* functions signal refusals by message; this turns them into an HTTP answer. Anything else is not ours. */
export function mapBillingError(e: unknown): Mapped | undefined {
  const m = e instanceof Error ? e.message : '';
  switch (m) {
    case 'coupon_invalid':
    case 'coupon_exhausted': return { status: 400, message: 'This code is not valid.' };   // one answer, so codes cannot be probed
    case 'coupon_already_redeemed': return { status: 409, message: 'You have already used this code.' };
    case 'insufficient_credits': return { status: 402, message: 'Not enough credits.' };
    case 'bad_amount': return { status: 400, message: 'The amount is not valid.' };
    case 'reservation_not_found': return { status: 404, message: 'No such reservation.' };
    case 'reservation_closed': return { status: 409, message: 'That request is already finished.' };
    default: return undefined;
  }
}

const num = (v: unknown) => Number(v ?? 0);

export async function balance(c: pg.PoolClient) {
  const r = (await c.query('SELECT promo, paid, reserved FROM ao_credit_balance()')).rows[0];
  return { promo: num(r.promo), paid: num(r.paid), reserved: num(r.reserved), total: num(r.promo) + num(r.paid) };
}

export async function redeem(c: pg.PoolClient, code: unknown) {
  const text = String(code ?? '').trim();
  if (!text || text.length > 60) throw new Error('coupon_invalid');
  const g = (await c.query('SELECT amount, pool, plan_id FROM ao_redeem_coupon($1)', [text])).rows[0];
  return { granted: num(g.amount), pool: g.pool as string, plan: (g.plan_id as string | null) ?? null, balance: await balance(c) };
}

export async function usage(c: pg.PoolClient, limit: number) {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
  const events = (await c.query(`SELECT id, request_id, model, tokens_in, tokens_out, cost, created_at FROM usage_events ORDER BY id DESC LIMIT $1`, [n])).rows
    .map((r) => ({ ...r, id: num(r.id), tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out), cost: num(r.cost) }));
  const t = (await c.query(`SELECT coalesce(sum(cost), 0) AS cost, coalesce(sum(tokens_in), 0) AS tin, coalesce(sum(tokens_out), 0) AS tout, count(*) AS n FROM usage_events`)).rows[0];
  return { events, totals: { cost: num(t.cost), tokens_in: num(t.tin), tokens_out: num(t.tout), requests: num(t.n) } };
}

/** The plan the user is on (the free plan when there is none) with its features, plus any per-user overrides. */
export const DEFAULT_CURRENCY = (process.env.AO_DEFAULT_CURRENCY || 'inr').toLowerCase();

/** The plan columns every reader needs, with its list price: the active price in the default currency (monthly first), else the first one. */
export const PLAN_SELECT = `p.id, p.name, p.description, p.managed_inference, p.monthly_credits, p.max_concurrent_runs, p.max_job_seconds, p.requests_per_minute,
  p.allowed_models, p.top_up_eligible, p.sort_order, p.features, p.active, pp.amount_minor AS price_cents, pp.currency, pp.billing_interval`;
export const PLAN_PRICE_JOIN = `LEFT JOIN LATERAL (SELECT amount_minor, currency, billing_interval FROM plan_prices x WHERE x.plan_id = p.id AND x.active
  ORDER BY (x.currency = $1) DESC, (x.billing_interval = 'month') DESC LIMIT 1) pp ON true`;

const planOut = (p: Record<string, any>) => ({
  id: p.id as string, name: p.name as string, description: (p.description ?? '') as string,
  price_cents: p.price_cents == null ? null : Number(p.price_cents), currency: (p.currency ?? DEFAULT_CURRENCY) as string, billing_interval: (p.billing_interval ?? null) as string | null,
  monthly_credits: Number(p.monthly_credits ?? 0), managed_inference: !!p.managed_inference,
  max_concurrent_runs: Number(p.max_concurrent_runs ?? 1), max_job_seconds: Number(p.max_job_seconds ?? 600), requests_per_minute: Number(p.requests_per_minute ?? 20),
  allowed_models: (p.allowed_models ?? null) as string[] | null, top_up_eligible: !!p.top_up_eligible,
});

/** The plans a person can choose from: only active ones, with what they cost and give. A plan with no price says so (price_cents is null). */
export async function listPlans(c: pg.PoolClient) {
  return (await c.query(`SELECT ${PLAN_SELECT} FROM plans p ${PLAN_PRICE_JOIN} WHERE p.active ORDER BY p.sort_order, p.id`, [DEFAULT_CURRENCY])).rows.map(planOut);
}

export async function entitlements(c: pg.PoolClient) {
  const plan = (await c.query(`SELECT ${PLAN_SELECT} FROM plans p ${PLAN_PRICE_JOIN}
    WHERE p.id = coalesce((SELECT plan_id FROM subscriptions WHERE status = 'active' AND (ends_at IS NULL OR ends_at > now())), 'free')`, [DEFAULT_CURRENCY])).rows[0]
    ?? { id: 'free', name: 'Free', description: '', price_cents: 0, currency: DEFAULT_CURRENCY, billing_interval: null, monthly_credits: 0, managed_inference: false, features: {} };
  const over = (await c.query(`SELECT key, value FROM entitlements WHERE expires_at IS NULL OR expires_at > now()`)).rows;
  const features: Record<string, unknown> = { ...(plan.features ?? {}) };
  for (const o of over) features[o.key] = o.value;
  const managed = typeof features.managed_inference === 'boolean' ? features.managed_inference : !!plan.managed_inference;
  const out = planOut(plan);
  return { plan: out, managed_inference: managed, limits: { max_concurrent_runs: out.max_concurrent_runs, max_job_seconds: out.max_job_seconds, requests_per_minute: out.requests_per_minute, allowed_models: out.allowed_models, top_up_eligible: out.top_up_eligible }, features };
}

export async function listDevices(c: pg.PoolClient, currentTokenHash: string | null) {
  const rows = (await c.query(`SELECT id, device_name, platform, created_at, last_used_at, expires_at, token_hash FROM device_tokens
    WHERE revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`)).rows;
  return rows.map(({ token_hash, ...d }) => ({ ...d, current: token_hash === currentTokenHash }));
}

/** Signs a device out. Only the caller's own tokens are visible, so another user's id is simply not found. */
export async function revokeDevice(c: pg.PoolClient, id: string): Promise<boolean> {
  const r = await c.query(`UPDATE device_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}

export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');
const MAX_KEYS = 10;

/** The key is shown once; only its hash is kept. */
export async function createApiKey(c: pg.PoolClient, uid: string, name: unknown, newId: () => string) {
  const label = String(name ?? '').trim().slice(0, 80) || 'Untitled key';
  const live = num((await c.query('SELECT count(*) AS n FROM api_keys WHERE revoked_at IS NULL')).rows[0].n);
  if (live >= MAX_KEYS) return null;
  const key = `aok_${randomBytes(32).toString('base64url')}`;
  const id = `key_${newId()}`;
  await c.query(`INSERT INTO api_keys(id, user_id, name, key_hash, prefix) VALUES ($1,$2,$3,$4,$5)`, [id, uid, label, hashKey(key), key.slice(0, 12)]);
  return { id, name: label, key, prefix: key.slice(0, 12) };
}
export async function listApiKeys(c: pg.PoolClient) {
  return (await c.query('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC')).rows;
}
export async function revokeApiKey(c: pg.PoolClient, id: string): Promise<boolean> {
  return ((await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])).rowCount ?? 0) > 0;
}
