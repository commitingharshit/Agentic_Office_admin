// The admin console's read models and its newer actions: charts, sessions, sign-in sessions, usage, subscriptions, plans, runs, admins.
// Everything is a server-side query with search, sort and pagination; nothing is loaded wholesale into the browser.
// Privacy: no query here selects session_events.payload, session titles, workspace names, file names or prompts. Only ids, counts,
// timings, types and states leave the database.
import type pg from 'pg';
import { DEFAULT_CURRENCY } from './billing.ts';
import type { AdminDeps } from './admin.ts';
import { HttpError } from './errors.ts';
import { ADMIN_ROLES, isAdminRole, type AdminRole } from './rbac.ts';

const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;
const int = (v: string | null, d: number, lo: number, hi: number) => { const n = v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; };
const n = (v: unknown) => Number(v ?? 0);
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const paging = (q: URLSearchParams) => { const size = int(q.get('pageSize'), 25, 5, 200), page = int(q.get('page'), 0, 0, 1_000_000); return { size, page, offset: page * size }; };
const cleanId = (v: string | null | undefined, what: string) => { if (v && !ID.test(v)) throw new HttpError(400, `${what} is not a valid id.`); return v || undefined; };

/** The admin's role, or null when the account is not an active admin. An admin without a row is a superadmin (the pre-roles behaviour). */
export async function roleOf(deps: AdminDeps, userId: string): Promise<AdminRole | null> {
  const r = (await deps.ro.query(`SELECT u.role AS user_role, u.status, ar.role AS admin_role FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = $1`, [userId])).rows[0];
  if (!r || r.user_role !== 'admin' || r.status !== 'active') return null;
  return isAdminRole(r.admin_role) ? r.admin_role : 'superadmin';
}

// ── overview ────────────────────────────────────────────────────────────────────────────────────

/** One row per day: only what the server genuinely records. "Active" means a day with sync events or managed-inference use. */
export async function overviewSeries(deps: AdminDeps, q: URLSearchParams) {
  const days = int(q.get('days'), 14, 2, 90);
  const day = `d.day`, next = `d.day + interval '1 day'`;
  const list = await rows(deps.ro, `
    WITH d AS (SELECT generate_series(date_trunc('day', now()) - (($1::int - 1) * interval '1 day'), date_trunc('day', now()), interval '1 day') AS day)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM users u WHERE u.created_at >= ${day} AND u.created_at < ${next})::int AS signups,
      (SELECT count(DISTINCT x.user_id) FROM (
          SELECT e.user_id FROM session_events e WHERE e.created_at >= ${day} AND e.created_at < ${next}
          UNION SELECT g.user_id FROM usage_events g WHERE g.created_at >= ${day} AND g.created_at < ${next}) x)::int AS active_users,
      (SELECT count(*) FROM session_events e WHERE e.created_at >= ${day} AND e.created_at < ${next})::int AS sync_events,
      (SELECT count(*) FROM usage_events g WHERE g.created_at >= ${day} AND g.created_at < ${next})::int AS model_requests,
      (SELECT coalesce(sum(g.tokens_in + g.tokens_out), 0) FROM usage_events g WHERE g.created_at >= ${day} AND g.created_at < ${next})::bigint AS tokens,
      (SELECT coalesce(sum(l.amount), 0) FROM credit_ledger l WHERE l.kind = 'grant' AND l.created_at >= ${day} AND l.created_at < ${next})::bigint AS credits_granted,
      (SELECT coalesce(-sum(l.amount), 0) FROM credit_ledger l WHERE l.kind = 'settle' AND l.created_at >= ${day} AND l.created_at < ${next})::bigint AS credits_spent,
      (SELECT count(*) FROM admin_audit a WHERE a.at >= ${day} AND a.at < ${next} AND a.action !~ '^(view_|list_)')::int AS admin_actions
    FROM d ORDER BY d.day`, [days]);
  const series = list.map((r) => ({ ...r, tokens: n(r.tokens), credits_granted: n(r.credits_granted), credits_spent: n(r.credits_spent) }));
  const total = (k: string) => series.reduce((a, r) => a + n(r[k]), 0);
  return {
    days, series,
    totals: { signups: total('signups'), sync_events: total('sync_events'), model_requests: total('model_requests'), tokens: total('tokens'), credits_granted: total('credits_granted'), credits_spent: total('credits_spent'), admin_actions: total('admin_actions') },
    note: 'Active users counts people with synced events or managed-inference calls that day; it is not a login count.',
  };
}

/** The latest things that happened on the platform, newest first. */
export async function recentActivity(deps: AdminDeps, q: URLSearchParams) {
  const limit = int(q.get('limit'), 20, 5, 100);
  return { events: await rows(deps.ro, `
    SELECT * FROM (
      SELECT a.at, 'admin' AS kind, a.action AS label, a.admin_user_id AS actor, a.target_user_id AS target FROM admin_audit a WHERE a.action !~ '^(view_|list_)'
      UNION ALL SELECT u.created_at, 'signup', 'account created', u.id, u.id FROM users u
      UNION ALL SELECT l.created_at, 'credits', l.kind || ' ' || l.pool || ' ' || l.amount::text, l.created_by, l.user_id FROM credit_ledger l WHERE l.kind IN ('grant', 'refund', 'adjust')
      UNION ALL SELECT r.redeemed_at, 'coupon', 'coupon redeemed ' || r.coupon_code, r.user_id, r.user_id FROM coupon_redemptions r
    ) e ORDER BY e.at DESC LIMIT $1`, [limit]) };
}

// ── sessions ────────────────────────────────────────────────────────────────────────────────────

export async function listSessions(deps: AdminDeps, q: URLSearchParams) {
  const { size, page, offset } = paging(q);
  const where: string[] = [], args: unknown[] = [];
  const userId = cleanId(q.get('user_id'), 'user_id');
  if (userId) { args.push(userId); where.push(`s.user_id = $${args.length}`); }
  const text = q.get('q')?.trim();
  if (text) { args.push(`%${text.toLowerCase()}%`); where.push(`(lower(u.email) LIKE $${args.length} OR s.id ILIKE $${args.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sort = q.get('sort') === 'created' ? 's.created_at' : 's.updated_at';
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM sessions s JOIN users u ON u.id = s.user_id ${w}`, args);
  const list = await rows(deps.ro, `
    SELECT s.id, s.user_id, u.email, s.workspace_id, s.created_at, s.updated_at,
           (SELECT count(*) FROM session_events e WHERE e.session_id = s.id)::int AS events,
           (SELECT max(e.created_at) FROM session_events e WHERE e.session_id = s.id) AS last_event
    FROM sessions s JOIN users u ON u.id = s.user_id ${w} ORDER BY ${sort} ${dir}, s.id LIMIT ${size} OFFSET ${offset}`, args);
  return { total, page, pageSize: size, sessions: list };
}

export async function sessionDetail(deps: AdminDeps, id: string) {
  const [s] = await rows(deps.ro, `SELECT s.id, s.user_id, u.email, s.workspace_id, s.created_at, s.updated_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id]);
  if (!s) throw new HttpError(404, 'No such session.');
  const types = await rows(deps.ro, `SELECT type, count(*)::int AS events, min(created_at) AS first_at, max(created_at) AS last_at FROM session_events WHERE session_id = $1 GROUP BY type ORDER BY events DESC`, [id]);
  const [span] = await rows(deps.ro, `SELECT count(*)::int AS events, min(created_at) AS first_at, max(created_at) AS last_at, coalesce(max(sequence), 0)::bigint AS last_sequence FROM session_events WHERE session_id = $1`, [id]);
  const runs = await rows(deps.ro, `SELECT run_id, agent_id, state, started_at, ended_at, tokens_in::bigint, tokens_out::bigint FROM agent_runs WHERE session_id = $1 ORDER BY started_at DESC LIMIT 50`, [id]);
  return { session: s, summary: { ...span, last_sequence: n(span.last_sequence) }, types, runs,
    note: 'Event contents are encrypted on the person\'s devices; only types, counts and times are visible here.' };
}

// ── sign-in sessions and devices ────────────────────────────────────────────────────────────────

export async function authSessions(deps: AdminDeps, q: URLSearchParams) {
  const userId = cleanId(q.get('user_id'), 'user_id');
  const args: unknown[] = userId ? [userId] : [];
  const f = userId ? 'WHERE s.user_id = $1' : '';
  const browser = await rows(deps.ro, `SELECT s.id, s.user_id, u.email, s.ip_address, s.user_agent, s.created_at, s.expires_at FROM admin_browser_sessions s JOIN users u ON u.id = s.user_id ${f} ORDER BY s.created_at DESC LIMIT 100`, args);
  const devices = await rows(deps.ro, `SELECT t.id, t.user_id, u.email, t.device_name, t.platform, t.created_at, t.last_used_at, t.expires_at, t.revoked_at,
      (t.revoked_at IS NULL AND t.expires_at > now()) AS live FROM device_tokens t JOIN users u ON u.id = t.user_id ${userId ? 'WHERE t.user_id = $1' : ''} ORDER BY t.last_used_at DESC LIMIT 100`, args);
  return { browser, devices };
}

export async function revokeDeviceToken(deps: AdminDeps, userId: string, tokenId: string) {
  const r = await deps.admin.query(`UPDATE device_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [tokenId, userId]);
  if (!r.rowCount) throw new HttpError(404, 'No such live device sign-in for that person.');
  return { ok: true };
}

export async function revokeBrowserSessions(deps: AdminDeps, userId: string, sessionId?: string) {
  const r = sessionId
    ? await deps.admin.query(`DELETE FROM auth_sessions WHERE user_id = $1 AND id = $2`, [userId, sessionId])
    : await deps.admin.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
  return { ok: true, revoked: r.rowCount ?? 0 };
}

// ── usage, subscriptions, plans ─────────────────────────────────────────────────────────────────

/** Managed-inference usage only. Bring-your-own-key and local-model use never reaches the platform and is not counted here. */
export async function usageSummary(deps: AdminDeps, q: URLSearchParams) {
  const days = int(q.get('days'), 30, 1, 365);
  const by = q.get('by') === 'user' ? 'user' : q.get('by') === 'day' ? 'day' : 'model';
  const cols = `count(*)::int AS requests, coalesce(sum(g.tokens_in), 0)::bigint AS tokens_in, coalesce(sum(g.tokens_out), 0)::bigint AS tokens_out, coalesce(sum(g.cost), 0)::bigint AS cost`;
  const win = `g.created_at >= now() - ($1::int * interval '1 day')`;
  const grouped = by === 'user'
    ? await rows(deps.ro, `SELECT g.user_id AS key, u.email AS label, ${cols} FROM usage_events g JOIN users u ON u.id = g.user_id WHERE ${win} GROUP BY g.user_id, u.email ORDER BY cost DESC, requests DESC LIMIT 50`, [days])
    : by === 'day'
      ? await rows(deps.ro, `SELECT to_char(date_trunc('day', g.created_at), 'YYYY-MM-DD') AS key, NULL AS label, ${cols} FROM usage_events g WHERE ${win} GROUP BY 1 ORDER BY 1`, [days])
      : await rows(deps.ro, `SELECT coalesce(g.model, 'unknown') AS key, NULL AS label, ${cols} FROM usage_events g WHERE ${win} GROUP BY 1 ORDER BY cost DESC, requests DESC`, [days]);
  const [t] = await rows(deps.ro, `SELECT ${cols} FROM usage_events g WHERE ${win}`, [days]);
  const [money] = await rows(deps.ro, `SELECT
      coalesce(sum(amount) FILTER (WHERE kind = 'grant' AND created_at >= now() - ($1::int * interval '1 day')), 0)::bigint AS granted,
      coalesce(-sum(amount) FILTER (WHERE kind = 'settle' AND created_at >= now() - ($1::int * interval '1 day')), 0)::bigint AS spent,
      coalesce(sum(amount) FILTER (WHERE pool = 'promo'), 0)::bigint AS outstanding_promo,
      coalesce(sum(amount) FILTER (WHERE pool = 'paid'), 0)::bigint AS outstanding_paid
    FROM credit_ledger`, [days]);
  const fix = (r: Record<string, unknown>) => ({ ...r, tokens_in: n(r.tokens_in), tokens_out: n(r.tokens_out), cost: n(r.cost) });
  return { days, by, rows: grouped.map(fix), totals: fix(t),
    credits: { granted: n(money.granted), spent: n(money.spent), outstanding_promo: n(money.outstanding_promo), outstanding_paid: n(money.outstanding_paid) },
    note: 'Platform-paid (managed) inference only. Requests made with a person\'s own API key or a local model never pass through this server.' };
}

export async function listSubscriptions(deps: AdminDeps, q: URLSearchParams) {
  const { size, page, offset } = paging(q);
  const where: string[] = [], args: unknown[] = [];
  if (q.get('plan')) { args.push(q.get('plan')); where.push(`s.plan_id = $${args.length}`); }
  if (q.get('status')) { args.push(q.get('status')); where.push(`s.status = $${args.length}`); }
  const text = q.get('q')?.trim();
  if (text) { args.push(`%${text.toLowerCase()}%`); where.push(`lower(u.email) LIKE $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM subscriptions s JOIN users u ON u.id = s.user_id ${w}`, args);
  const list = await rows(deps.ro, `SELECT s.user_id, u.email, s.plan_id, s.status, s.started_at, s.ends_at, s.source FROM subscriptions s JOIN users u ON u.id = s.user_id ${w} ORDER BY s.started_at DESC LIMIT ${size} OFFSET ${offset}`, args);
  const [implicit] = await rows(deps.ro, `SELECT count(*)::int AS n FROM users u WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active')`);
  return { total, page, pageSize: size, subscriptions: list, on_default_plan: implicit.n };
}

const PLAN_ID = /^[a-z0-9_-]{1,40}$/;
const whole = (v: unknown, lo: number, hi: number, what: string): number => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} is a whole number from ${lo} to ${hi}.`); return n; };
/** What a plan costs and gives, validated once for create and update. `plan` holds columns of the plans table; `price` is a row of plan_prices (or null to remove it). */
function planFields(b: Record<string, unknown>) {
  const plan: Record<string, unknown> = {};
  let price: { currency: string; interval: string; amount: number } | null | undefined;
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (!n) throw new HttpError(400, 'A plan needs a name.'); plan.name = n; }
  if (b.description !== undefined) plan.description = String(b.description).slice(0, 300);
  if (b.monthly_credits !== undefined) plan.monthly_credits = whole(b.monthly_credits, 0, 1_000_000_000, 'monthly_credits');
  if (b.sort_order !== undefined) plan.sort_order = whole(b.sort_order, 0, 1000, 'sort_order');
  if (b.max_concurrent_runs !== undefined) plan.max_concurrent_runs = whole(b.max_concurrent_runs, 1, 100, 'max_concurrent_runs');
  if (b.max_job_seconds !== undefined) plan.max_job_seconds = whole(b.max_job_seconds, 10, 86400, 'max_job_seconds');
  if (b.requests_per_minute !== undefined) plan.requests_per_minute = whole(b.requests_per_minute, 1, 10000, 'requests_per_minute');
  if (b.allowed_models !== undefined) {
    if (b.allowed_models === null || (Array.isArray(b.allowed_models) && !b.allowed_models.length)) plan.allowed_models = null;
    else if (Array.isArray(b.allowed_models) && b.allowed_models.every((m) => typeof m === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(m))) plan.allowed_models = b.allowed_models;
    else throw new HttpError(400, 'allowed_models is a list of model ids, or empty for every model.');
  }
  for (const k of ['managed_inference', 'top_up_eligible', 'active'] as const) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') throw new HttpError(400, `${k} is true or false.`); plan[k] = b[k]; }
  if (b.features !== undefined) { if (!b.features || typeof b.features !== 'object' || Array.isArray(b.features)) throw new HttpError(400, 'features is an object.'); plan.features = JSON.stringify(b.features); }
  if (b.price_cents !== undefined || b.billing_interval !== undefined || b.currency !== undefined) {
    if (b.price_cents === null || b.price_cents === '') price = null;
    else if (b.price_cents !== undefined) {
      const currency = String(b.currency ?? DEFAULT_CURRENCY).toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) throw new HttpError(400, 'currency is a three-letter code such as inr.');
      const interval = b.billing_interval === undefined || b.billing_interval === null || b.billing_interval === '' ? 'month' : String(b.billing_interval);
      if (interval !== 'month' && interval !== 'year') throw new HttpError(400, 'billing_interval is month or year.');
      price = { currency, interval, amount: whole(b.price_cents, 0, 100_000_000_00, 'price_cents') };
    }
  }
  return { plan, price };
}

async function writePrice(c: pg.PoolClient, planId: string, price: { currency: string; interval: string; amount: number } | null | undefined) {
  if (price === undefined) return;
  if (price === null) { await c.query('DELETE FROM plan_prices WHERE plan_id = $1 AND currency = $2', [planId, DEFAULT_CURRENCY]); return; }
  await c.query('DELETE FROM plan_prices WHERE plan_id = $1 AND currency = $2 AND billing_interval <> $3', [planId, price.currency, price.interval]);   // one list price per currency
  await c.query(`INSERT INTO plan_prices(plan_id, currency, billing_interval, amount_minor) VALUES ($1,$2,$3,$4)
    ON CONFLICT (plan_id, currency, billing_interval) DO UPDATE SET amount_minor = excluded.amount_minor, active = true, updated_at = now()`, [planId, price.currency, price.interval, price.amount]);
}

export async function createPlan(deps: AdminDeps, b: Record<string, unknown>) {
  const id = String(b.id ?? '').trim();
  if (!PLAN_ID.test(id)) throw new HttpError(400, 'A plan id is 1-40 lower-case letters, digits, _ or -.');
  const { plan, price } = planFields(b);
  if (!plan.name) throw new HttpError(400, 'A plan needs a name.');
  if (plan.active === true && !price) throw new HttpError(409, 'Set a price (0 for a free plan) before switching the plan on.');
  if (plan.active === undefined) plan.active = !!price;   // a plan without a price starts as a draft
  const cols = ['id', ...Object.keys(plan)], vals = [id, ...Object.values(plan)];
  const c = await deps.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO plans(${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    await writePrice(c, id, price);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'That plan id already exists.');
    throw e;
  } finally { c.release(); }
  return { id, name: plan.name };
}

export async function updatePlan(deps: AdminDeps, id: string, b: Record<string, unknown>) {
  if (!PLAN_ID.test(id)) throw new HttpError(400, 'Not a plan id.');
  if (id === 'free' && b.active === false) throw new HttpError(409, 'The free plan is the default for everyone and cannot be switched off.');
  const { plan, price } = planFields(b);
  const keys = Object.keys(plan);
  if (!keys.length && price === undefined) throw new HttpError(400, 'Nothing to change.');
  const [cur] = await rows(deps.ro, `SELECT p.active, (SELECT count(*) FROM plan_prices x WHERE x.plan_id = p.id AND x.currency = $2 AND x.active)::int AS priced FROM plans p WHERE p.id = $1`, [id, DEFAULT_CURRENCY]);
  if (!cur) throw new HttpError(404, 'No such plan.');
  const pricedAfter = price === undefined ? cur.priced > 0 : price !== null;
  const activeAfter = plan.active === undefined ? cur.active : plan.active;
  if (activeAfter === true && !pricedAfter) throw new HttpError(409, 'Set a price (0 for a free plan) before switching the plan on.');
  const c = await deps.admin.connect();
  try {
    await c.query('BEGIN');
    if (keys.length) await c.query(`UPDATE plans SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(plan)]);
    await writePrice(c, id, price);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  return { ok: true };
}

// ── agent runs (filled by the opt-in telemetry in a later slice; empty until people share usage) ─

export async function listRuns(deps: AdminDeps, q: URLSearchParams) {
  const { size, page, offset } = paging(q);
  const where: string[] = [], args: unknown[] = [];
  const userId = cleanId(q.get('user_id'), 'user_id');
  if (userId) { args.push(userId); where.push(`r.user_id = $${args.length}`); }
  if (q.get('state')) { args.push(q.get('state')); where.push(`r.state = $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM agent_runs r ${w}`, args);
  const list = await rows(deps.ro, `SELECT r.run_id, r.user_id, u.email, r.session_id, r.parent_run_id, r.agent_id, r.state, r.started_at, r.ended_at, r.tokens_in::bigint, r.tokens_out::bigint, r.model, r.mode, r.tool_calls, r.failure_category
      FROM agent_runs r JOIN users u ON u.id = r.user_id ${w} ORDER BY r.started_at DESC LIMIT ${size} OFFSET ${offset}`, args);
  const [shared] = await rows(deps.ro, `SELECT count(DISTINCT r.user_id)::int AS users_with_runs, (SELECT count(*)::int FROM usage_consent WHERE shared) AS users_sharing, (SELECT count(*)::int FROM users WHERE status = 'active') AS active_users FROM agent_runs r`);
  return { total, page, pageSize: size, runs: list.map((r) => ({ ...r, tokens_in: n(r.tokens_in), tokens_out: n(r.tokens_out) })), coverage: shared };
}

export async function runDetail(deps: AdminDeps, id: string) {
  const [r] = await rows(deps.ro, `SELECT r.run_id, r.user_id, u.email, r.session_id, r.parent_run_id, r.agent_id, r.state, r.started_at, r.ended_at, r.tokens_in::bigint, r.tokens_out::bigint FROM agent_runs r JOIN users u ON u.id = r.user_id WHERE r.run_id = $1`, [id]);
  if (!r) throw new HttpError(404, 'No such run.');
  const children = await rows(deps.ro, `SELECT run_id, agent_id, state, started_at, ended_at, tokens_in::bigint, tokens_out::bigint FROM agent_runs WHERE parent_run_id = $1 ORDER BY started_at`, [id]);
  return { run: { ...r, tokens_in: n(r.tokens_in), tokens_out: n(r.tokens_out) }, children: children.map((c) => ({ ...c, tokens_in: n(c.tokens_in), tokens_out: n(c.tokens_out) })) };
}

// ── admins ──────────────────────────────────────────────────────────────────────────────────────

export async function listAdmins(deps: AdminDeps) {
  return { roles: ADMIN_ROLES, admins: await rows(deps.ro, `SELECT u.id, u.email, u.display_name, u.status, u.last_active_at, coalesce(ar.role, 'superadmin') AS admin_role, ar.granted_by, ar.granted_at
      FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.role = 'admin' ORDER BY u.created_at`) };
}

/** Change which kind of admin someone is. The last superadmin cannot be changed away, and nobody changes their own role. */
export async function setAdminRole(deps: AdminDeps, actorId: string, userId: string, b: Record<string, unknown>) {
  if (!isAdminRole(b.admin_role)) throw new HttpError(400, `admin_role is one of ${ADMIN_ROLES.join(', ')}.`);
  if (userId === actorId) throw new HttpError(409, 'You cannot change your own role.');
  const c = await deps.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin-roles', 0))`);
    const target = (await c.query(`SELECT u.role, u.status, coalesce(ar.role, 'superadmin') AS admin_role FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [userId])).rows[0];
    if (!target) throw new HttpError(404, 'No such user.');
    if (target.role !== 'admin') throw new HttpError(409, 'Make them an admin first.');
    if (target.admin_role === 'superadmin' && b.admin_role !== 'superadmin') {
      const others = (await c.query(`SELECT count(*)::int AS n FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.role = 'admin' AND u.status = 'active' AND u.id <> $1 AND coalesce(ar.role, 'superadmin') = 'superadmin'`, [userId])).rows[0].n;
      if (others < 1) throw new HttpError(409, 'That is the last superadmin. Make someone else a superadmin first.');
    }
    await c.query(`INSERT INTO admin_roles(user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`, [userId, b.admin_role, actorId]);
    await c.query('COMMIT');
    return { ok: true, admin_role: b.admin_role };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// ── reliability and product analytics (from run telemetry that people chose to share) ──────────

/** Who contributes data. Every figure below is computed from this group only, and the console says so beside the number. */
async function coverage(deps: AdminDeps, days: number) {
  const [c] = await rows(deps.ro, `SELECT
      (SELECT count(*)::int FROM usage_consent WHERE shared) AS users_sharing,
      (SELECT count(DISTINCT user_id)::int FROM agent_runs WHERE started_at >= now() - ($1::int * interval '1 day')) AS users_with_runs,
      (SELECT count(*)::int FROM users WHERE status = 'active') AS active_users`, [days]);
  return c as { users_sharing: number; users_with_runs: number; active_users: number };
}

export async function reliability(deps: AdminDeps, q: URLSearchParams) {
  const days = int(q.get('days'), 14, 1, 365);
  const win = `r.started_at >= now() - ($1::int * interval '1 day')`;
  const [t] = await rows(deps.ro, `SELECT count(*)::int AS runs,
      count(*) FILTER (WHERE state = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE state = 'failed')::int AS failed,
      count(*) FILTER (WHERE state = 'cancelled')::int AS cancelled, count(*) FILTER (WHERE state = 'running')::int AS running,
      round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL))::numeric, 3)::float8 AS p50_s,
      round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) FILTER (WHERE r.ended_at IS NOT NULL))::numeric, 3)::float8 AS p95_s
    FROM agent_runs r WHERE ${win}`, [days]);
  const finished = n(t.succeeded) + n(t.failed);
  const failures = await rows(deps.ro, `SELECT coalesce(r.failure_category, 'unknown') AS category, count(*)::int AS runs FROM agent_runs r WHERE ${win} AND r.state = 'failed' GROUP BY 1 ORDER BY 2 DESC`, [days]);
  const tools = await rows(deps.ro, `SELECT s.tool_name AS name, count(*)::int AS steps, count(*) FILTER (WHERE s.state = 'failed')::int AS failed, coalesce(sum(s.retries), 0)::int AS retries
    FROM run_steps s JOIN agent_runs r ON r.run_id = s.run_id WHERE ${win} AND s.kind = 'tool' AND s.tool_name IS NOT NULL GROUP BY 1 ORDER BY failed DESC, steps DESC LIMIT 20`, [days]);
  const models = await rows(deps.ro, `SELECT coalesce(r.model, 'unknown') AS name, count(*)::int AS runs, count(*) FILTER (WHERE r.state = 'failed')::int AS failed FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY runs DESC LIMIT 20`, [days]);
  const versions = await rows(deps.ro, `SELECT coalesce(r.client_version, 'unknown') AS version, count(*)::int AS runs, count(DISTINCT r.user_id)::int AS users FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY runs DESC LIMIT 10`, [days]);
  const verification = await rows(deps.ro, `SELECT v.format, v.verdict, count(*)::int AS n FROM verification_results v JOIN agent_runs r ON r.run_id = v.run_id WHERE ${win} GROUP BY 1, 2 ORDER BY 1, 2`, [days]);
  const daily = await rows(deps.ro, `SELECT to_char(date_trunc('day', r.started_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs, count(*) FILTER (WHERE r.state = 'failed')::int AS failed FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY 1`, [days]);
  return {
    days, coverage: await coverage(deps, days),
    totals: { runs: n(t.runs), succeeded: n(t.succeeded), failed: n(t.failed), cancelled: n(t.cancelled), running: n(t.running), finished,
      success_rate: finished ? n(t.succeeded) / finished : null, p50_s: t.p50_s == null ? null : n(t.p50_s), p95_s: t.p95_s == null ? null : n(t.p95_s) },
    failures, tools, models, versions, verification, daily,
    note: 'Success rate is succeeded / (succeeded + failed) among runs from people who share usage; cancelled and still-running runs are left out. It is not a measure of everyone.',
  };
}

export async function analytics(deps: AdminDeps, q: URLSearchParams) {
  const days = int(q.get('days'), 30, 1, 365);
  const win = `r.started_at >= now() - ($1::int * interval '1 day')`;
  const cov = await coverage(deps, days);
  const [act] = await rows(deps.ro, `SELECT count(DISTINCT r.user_id)::int AS ran, count(DISTINCT r.user_id) FILTER (WHERE r.state = 'succeeded')::int AS succeeded FROM agent_runs r WHERE ${win}`, [days]);
  const byMode = await rows(deps.ro, `SELECT coalesce(r.mode, 'unknown') AS mode, count(*)::int AS runs, count(DISTINCT r.user_id)::int AS users FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY runs DESC`, [days]);
  const byFormat = await rows(deps.ro, `SELECT v.format, count(DISTINCT v.run_id)::int AS runs, count(DISTINCT v.user_id)::int AS users FROM verification_results v JOIN agent_runs r ON r.run_id = v.run_id WHERE ${win} GROUP BY 1 ORDER BY runs DESC`, [days]);
  const byAgent = await rows(deps.ro, `SELECT coalesce(r.agent_id, 'unknown') AS agent, count(*)::int AS runs FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY runs DESC LIMIT 15`, [days]);
  const daily = await rows(deps.ro, `SELECT to_char(date_trunc('day', r.started_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs, count(DISTINCT r.user_id)::int AS users FROM agent_runs r WHERE ${win} GROUP BY 1 ORDER BY 1`, [days]);
  return {
    days, coverage: cov,
    activation: { sharing: cov.users_sharing, ran_a_run: n(act.ran), had_a_success: n(act.succeeded) },
    by_mode: byMode, by_format: byFormat, by_agent: byAgent, daily,
    note: 'Every figure comes only from people who turned on usage sharing (off by default). Read each count against "people sharing", not against all users.',
  };
}

/** A person's sign-in history as the server recorded it: when, through what, which app and machine, from which address. */
export async function signInHistory(deps: AdminDeps, userId: string) {
  if (!ID.test(userId)) throw new HttpError(400, 'Not a user id.');
  const list = await rows(deps.ro, `SELECT provider, client, device_name, platform, ip, created_at FROM sign_in_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
  return { sign_ins: list };
}
