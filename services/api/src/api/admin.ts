// The admin API: everything the Admin Console shows or does goes through here, never through
// raw SQL writes from a client. Reads use ao_readonly (sees every user, never event payloads);
// actions use ao_admin; every request — views included — is written to admin_audit first.
//
// Auth: a bearer token mapped to an admin id (AO_ADMIN_TOKENS). When Clerk is wired, the same
// `authenticate` seam verifies a Clerk session JWT and requires publicMetadata.role = "admin".
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { S3 } from './s3.ts';
import type { ClerkClaims } from '../auth/clerk.ts';
import { HttpError } from './errors.ts';
import * as payAdmin from './payments/admin.ts';
import * as invites from './admin-invites.ts';
import { attention } from './attention.ts';
import * as access from './access-requests.ts';
import { DEFAULT_CURRENCY, PLAN_PRICE_JOIN, PLAN_SELECT as billingSelect } from './billing.ts';
import * as ops from './ops.ts';
import * as growthAdmin from '../growth/admin.ts';
import { keycloakView, mirrorKeycloak } from './keycloak-link.ts';
import { publicStatus } from '../status/probe.ts';
import * as consoleApi from './admin-console.ts';
import { can, permissionsOf, isAdminRole, type AdminRole, type Permission } from './rbac.ts';
import { deriveEntity } from './audit-entity.ts';

export interface AdminDeps {
  ro: pg.Pool;
  admin: pg.Pool;
  /** sha256(token) → admin id. */
  tokens: Map<string, string>;
  s3?: S3;
  clerkSecret?: string;
  /** Verifies a Clerk session token; with it, admins sign in with Clerk instead of a token. */
  verifyClerk?(token: string): Promise<ClerkClaims>;
  /** Keycloak's admin REST API (read sessions and events, sign out, disable); absent until Keycloak is configured. */
  keycloak?: import('./keycloak-admin.ts').KeycloakAdmin;
  /** The payment provider side (to ask it what it knows). Absent unless payments are switched on. */
  payments?: import('./payments/service.ts').PaymentsService;
  /** The help assistant (answers from the documentation only); absent until a provider key is configured. */
  help?: import('../help/service.ts').Help;
  /** Campaign email: the public base URL and keys the unsubscribe link and Resend's webhook need (src/growth/email.ts). */
  email?: import('../growth/email.ts').EmailConfig;
  /** Sends announcement emails; absent when no provider is configured. */
  mailer?: import('./mailer.ts').Mailer;
  /** Row cap for the SQL view. */
  sqlRowLimit?: number;
}

export { HttpError };

export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/** `name:token,name:token` → hash map (the raw tokens never stay in memory). */
export function parseTokens(spec: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0 || part.length - i - 1 < 24) throw new Error('AO_ADMIN_TOKENS entries must be name:token with a token of 24+ characters');
    m.set(tokenHash(part.slice(i + 1)), part.slice(0, i));
  }
  return m;
}

export async function authenticate(req: IncomingMessage, deps: AdminDeps): Promise<string> {
  const h = req.headers.authorization ?? '';
  const tok = /^Bearer\s+(.+)$/i.exec(h)?.[1];
  if (!tok) throw new HttpError(401, 'Sign in as an admin.');
  // A Clerk session token: admin when the token says role "admin" (public metadata) or our
  // users row does. Both are checked server-side; a client-side flag is never trusted.
  if (deps.verifyClerk && tok.split('.').length === 3) {
    let claims: ClerkClaims;
    try { claims = await deps.verifyClerk(tok); } catch (e) { throw new HttpError(401, (e as Error).message); }
    const row = (await deps.ro.query('SELECT role, status, email FROM users WHERE clerk_user_id = $1', [claims.sub])).rows[0];
    if (row?.status && row.status !== 'active') throw new HttpError(403, 'This account is disabled.');
    if (claims.role !== 'admin' && row?.role !== 'admin') throw new HttpError(403, 'This account is not an admin.');
    return String(claims.email ?? row?.email ?? claims.sub);
  }
  const want = Buffer.from(tokenHash(tok), 'hex');
  for (const [hash, id] of deps.tokens) {
    const have = Buffer.from(hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) return id;
  }
  throw new HttpError(403, 'This account is not an admin.');
}

async function auditRow(deps: AdminDeps, adminId: string, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  const e = deriveEntity(action, target, detail);
  await deps.admin.query('INSERT INTO admin_audit(admin_user_id, action, target_user_id, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)', [adminId, action, target, e?.type ?? null, e?.id ?? null, JSON.stringify(detail)]);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > 256_000) throw new HttpError(413, 'Request too large.'); chunks.push(c as Buffer); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Body is not JSON.'); }
}

const int = (v: string | null, d: number, lo: number, hi: number) => { const n = v == null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : d; };
const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;

// ───────────────────────────────────────────── reads

export async function overview(deps: AdminDeps) {
  const [totals] = await rows(deps.ro, `
    SELECT count(*) FILTER (WHERE status <> 'deleted')::int AS users,
           count(*) FILTER (WHERE status = 'disabled')::int AS disabled,
           count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS signups_today,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS signups_7d,
           count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS signups_30d,
           count(*) FILTER (WHERE last_active_at >= now() - interval '1 day')::int AS dau,
           count(*) FILTER (WHERE last_active_at >= now() - interval '7 days')::int AS wau
    FROM users`);
  const [usage] = await rows(deps.ro, `
    SELECT (SELECT count(*) FROM sessions WHERE updated_at >= now() - interval '1 hour')::int AS active_sessions,
           (SELECT coalesce(sum(bytes), 0) FROM document_revisions)::bigint AS storage_bytes,
           (SELECT count(*) FROM memory_references WHERE deleted_at IS NULL)::int AS memories,
           (SELECT count(*) FROM devices)::int AS devices`);
  const signups = await rows(deps.ro, `
    SELECT to_char(d, 'Mon DD') AS day, coalesce(s.signups, 0)::int AS signups
    FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
    LEFT JOIN admin_signups_daily s ON s.day = d::date ORDER BY d`);
  const active = await rows(deps.ro, `
    SELECT to_char(d, 'Mon DD') AS day, count(DISTINCT e.user_id)::int AS active_users
    FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
    LEFT JOIN session_events e ON e.created_at >= d AND e.created_at < d + interval '1 day'
    GROUP BY d ORDER BY d`);
  const providers = await rows(deps.ro, `
    SELECT provider, count(DISTINCT user_id)::int AS users FROM oauth_accounts
    WHERE purpose = 'sign_in' AND revoked_at IS NULL GROUP BY provider ORDER BY users DESC`);
  // Weekly cohorts: of the users who signed up in week W, the share with any event k weeks later.
  const cohorts = await rows(deps.ro, `
    WITH c AS (SELECT id, date_trunc('week', created_at) AS wk FROM users WHERE status <> 'deleted' AND created_at >= date_trunc('week', now()) - interval '7 weeks'),
         a AS (SELECT DISTINCT user_id, date_trunc('week', created_at) AS wk FROM session_events WHERE created_at >= date_trunc('week', now()) - interval '7 weeks')
    SELECT to_char(c.wk, 'YYYY-MM-DD') AS cohort, count(DISTINCT c.id)::int AS size,
           ${[0, 1, 2, 3].map((k) => `round(100.0 * count(DISTINCT a.user_id) FILTER (WHERE a.wk = c.wk + interval '${k} weeks') / greatest(count(DISTINCT c.id), 1))::int AS w${k}`).join(', ')}
    FROM c LEFT JOIN a ON a.user_id = c.id GROUP BY c.wk ORDER BY c.wk DESC`);
  return { totals: { ...totals, ...usage, storage_bytes: Number(usage.storage_bytes) }, signups, active, providers, cohorts, at: new Date().toISOString() };
}

const SORTS: Record<string, string> = { created: 'created_at', active: 'last_active_at', email: 'lower(email)', name: 'lower(display_name)', storage: 'storage_bytes', sessions: 'sessions', devices: 'devices' };

export async function listUsers(deps: AdminDeps, q: URLSearchParams) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  const text = q.get('q')?.trim();
  if (text) {
    args.push(`%${text.toLowerCase()}%`, text);
    where.push(`(lower(email) LIKE $${args.length - 1} OR lower(display_name) LIKE $${args.length - 1} OR id = $${args.length})`);
  }
  if (q.get('status')) add('status = ?', q.get('status'));
  else where.push(`status <> 'deleted'`);
  if (q.get('provider')) add(`providers LIKE ?`, `%${q.get('provider')}%`);
  if (q.get('role') === 'admin' || q.get('role') === 'user') add('role = ?', q.get('role'));
  if (q.get('plan')) add('c.plan_id = ?', q.get('plan'));
  if (q.get('from')) add('created_at >= ?::date', q.get('from'));
  if (q.get('to')) add(`created_at < ?::date + 1`, q.get('to'));
  const sort = SORTS[q.get('sort') ?? 'created'] ?? 'created_at';
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const csv = q.get('format') === 'csv';
  const size = csv ? 10_000 : int(q.get('pageSize'), 25, 5, 200);
  const page = csv ? 0 : int(q.get('page'), 0, 0, 1_000_000);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM admin_user_overview o LEFT JOIN admin_user_credits c ON c.user_id = o.id ${w}`, args);
  const list = await rows(deps.ro, `SELECT id, email, display_name, role, status, providers, created_at, last_active_at, devices::int, workspaces::int, sessions::int, storage_bytes::bigint, memories::int, c.plan_id, c.promo::bigint AS promo, c.paid::bigint AS paid
    FROM admin_user_overview o LEFT JOIN admin_user_credits c ON c.user_id = o.id ${w} ORDER BY ${sort} ${dir} NULLS LAST, id LIMIT ${size} OFFSET ${page * size}`, args);
  const users = list.map((u) => ({ ...u, storage_bytes: Number(u.storage_bytes), promo: Number(u.promo ?? 0), paid: Number(u.paid ?? 0) }));
  return { total, page, pageSize: size, users };
}

export function toCsv(users: Array<Record<string, unknown>>): string {
  const cols = ['id', 'email', 'display_name', 'role', 'status', 'providers', 'created_at', 'last_active_at', 'devices', 'workspaces', 'sessions', 'storage_bytes', 'memories'];
  const cell = (v: unknown) => { const s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...users.map((u) => cols.map((c) => cell(u[c])).join(','))].join('\n') + '\n';
}

export async function userDetail(deps: AdminDeps, id: string) {
  const [user] = await rows(deps.ro, 'SELECT * FROM admin_user_overview WHERE id = $1', [id]);
  if (!user) throw new HttpError(404, 'No such user.');
  const [identities, devices, workspaces, usage, auditTrail, sync] = await Promise.all([
    rows(deps.ro, 'SELECT provider, email, purpose, created_at, revoked_at FROM oauth_accounts WHERE user_id = $1 ORDER BY created_at', [id]),
    rows(deps.ro, 'SELECT id, name, platform, app_version, first_seen, last_seen FROM devices WHERE user_id = $1 ORDER BY last_seen DESC', [id]),
    rows(deps.ro, `SELECT w.id, w.updated_at, (SELECT count(*) FROM sessions s WHERE s.workspace_id = w.id)::int AS sessions FROM workspaces w WHERE w.user_id = $1 ORDER BY w.updated_at DESC`, [id]),
    rows(deps.ro, `SELECT to_char(d, 'Mon DD') AS day, count(e.event_id)::int AS events
      FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
      LEFT JOIN session_events e ON e.user_id = $1 AND e.created_at >= d AND e.created_at < d + interval '1 day' GROUP BY d ORDER BY d`, [id]),
    rows(deps.ro, 'SELECT admin_user_id, action, detail, at FROM admin_audit WHERE target_user_id = $1 ORDER BY at DESC LIMIT 50', [id]),
    rows(deps.ro, 'SELECT device_id, stream, updated_at FROM sync_cursors WHERE user_id = $1 ORDER BY updated_at DESC', [id]),
  ]);
  return { user: { ...user, storage_bytes: Number(user.storage_bytes) }, identities, devices, workspaces, usage, audit: auditTrail, sync };
}

// A person's memories with their text. memory_contents is readable only by ao_admin, so this reads through deps.admin, not deps.ro.
export async function userMemories(deps: AdminDeps, id: string) {
  const memories = await rows(deps.admin, `SELECT m.memory_id, m.workspace_id, m.kind, m.updated_at, m.deleted_at, c.content
    FROM memory_references m LEFT JOIN memory_contents c ON c.memory_id = m.memory_id
    WHERE m.user_id = $1 ORDER BY m.deleted_at IS NOT NULL, m.updated_at DESC LIMIT 500`, [id]);
  return { memories };
}

export async function exportUser(deps: AdminDeps, id: string) {
  const tables = ['users', 'oauth_accounts', 'devices', 'workspaces', 'sessions', 'agent_runs', 'document_revisions', 'memory_references', 'sync_cursors'];
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), note: 'Account metadata only. Documents, transcripts and memories are encrypted on the user\'s devices; blob keys are listed.' };
  // Account metadata only: the columns a person typed or that name their files (workspace names, session titles, memory URIs) stay out.
  const cols: Record<string, string> = {
    workspaces: 'id, user_id, created_at, updated_at',
    sessions: 'id, user_id, workspace_id, latest_checkpoint_id, created_at, updated_at',
    memory_references: 'memory_id, user_id, workspace_id, source_account_id, source_version, kind, blob_key, updated_at, deleted_at',
  };
  for (const t of tables) out[t] = await rows(deps.ro, `SELECT ${cols[t] ?? '*'} FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = $1`, [id]);
  out.session_events = await rows(deps.ro, 'SELECT event_id, session_id, sequence, type, created_at FROM session_events WHERE user_id = $1 ORDER BY session_id, sequence', [id]);
  if ((out.users as unknown[]).length === 0) throw new HttpError(404, 'No such user.');
  return out;
}

export async function health(deps: AdminDeps) {
  const [db] = await rows(deps.ro, `SELECT pg_database_size(current_database())::bigint AS bytes, current_setting('max_connections')::int AS max_connections,
    current_setting('archive_mode') AS archive_mode, version() AS version, pg_postmaster_start_time() AS started_at`);
  const connections = await rows(deps.ro, `SELECT coalesce(state, 'background') AS state, count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() OR datname IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  const tables = await rows(deps.ro, `SELECT relname AS table, pg_total_relation_size(relid)::bigint AS bytes, n_live_tup::bigint AS rows FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 12`);
  let slow: unknown[] = [];
  try {
    slow = await rows(deps.ro, `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 200) AS query, calls::bigint, round(mean_exec_time::numeric, 1) AS mean_ms, round(max_exec_time::numeric, 1) AS max_ms
      FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY mean_exec_time DESC LIMIT 10`);
  } catch { /* extension not preloaded */ }
  const tenants = await rows(deps.ro, `SELECT id, email, storage_bytes::bigint, sessions::int FROM admin_user_overview WHERE status <> 'deleted' ORDER BY storage_bytes DESC, sessions DESC LIMIT 10`);
  const [sync] = await rows(deps.ro, `SELECT max(updated_at) AS latest, count(*)::int AS cursors FROM sync_cursors`);
  const [events] = await rows(deps.ro, `SELECT count(*)::bigint AS total, percentile_disc(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM received_at - created_at)) AS p95_lag_s
    FROM session_events WHERE received_at >= now() - interval '1 day'`);
  let backup: Record<string, unknown> = { configured: false };
  if (deps.s3) {
    try {
      const latest = (await deps.s3.getText('ao-backups', 'pg/LATEST'))?.trim();
      const head = latest ? await deps.s3.head('ao-backups', `pg/${latest}`) : undefined;
      const base = (await deps.s3.getText('ao-backups', 'pg/base/LATEST'))?.trim();
      const baseHead = base ? await deps.s3.head('ao-backups', `pg/base/${base}.tar.gz`) : undefined;
      const drillText = await deps.s3.getText('ao-backups', 'pg/drills/LATEST.json');
      let drill: Record<string, unknown> | null = null;
      try { drill = drillText ? JSON.parse(drillText) : null; } catch { drill = { ok: false, detail: 'unreadable drill record' }; }
      backup = {
        configured: true, latest: latest ?? null, bytes: head?.bytes ?? null, at: head?.modified ?? null,
        age_hours: head ? +((Date.now() - Date.parse(head.modified)) / 3.6e6).toFixed(1) : null,
        base: base ? { name: base, bytes: baseHead?.bytes ?? null, at: baseHead?.modified ?? null } : null,
        drill,
      };
    } catch (e) { backup = { configured: true, error: (e as Error).message }; }
  }
  const [archiver] = await rows(deps.ro, `SELECT archived_count::int, last_archived_wal, last_archived_time, failed_count::int, last_failed_wal, last_failed_time FROM pg_stat_archiver`);
  // Devices' own numbers (last 24 h): the worst device's p95 per timing, and the largest queues.
  const deviceRows = await rows(deps.ro, `SELECT DISTINCT ON (user_id, device_id) device_id, metrics, reported_at FROM device_metrics
    WHERE reported_at >= now() - interval '1 day' ORDER BY user_id, device_id, reported_at DESC`);
  const worst = (name: string) => Math.max(0, ...deviceRows.map((r) => Number((r.metrics?.[name] as { p95?: number } | undefined)?.p95 ?? 0)));
  const gaugeMax = (name: string) => Math.max(0, ...deviceRows.map((r) => Number(r.metrics?.gauges?.[name] ?? 0)));
  const devices = {
    reporting: deviceRows.length,
    event_write_p95_ms: worst('event_write_ms'), checkpoint_p95_ms: worst('checkpoint_ms'), retrieval_p95_ms: worst('retrieval_ms'),
    extraction_lag_s: gaugeMax('extraction_lag_s'), outbox_pending: gaugeMax('outbox_pending'), wal_bytes: gaugeMax('wal_bytes'),
  };
  const num = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) && k !== 'query' ? Number(v) : v]));
  return {
    db: num(db), connections, tables: tables.map(num), slow: slow.map((r) => num(r as Record<string, unknown>)), tenants: tenants.map(num), backup,
    sync: { latest: sync.latest, cursors: sync.cursors, events_24h: Number(events.total), p95_lag_s: events.p95_lag_s == null ? null : Number(events.p95_lag_s) },
    wal: { mode: db.archive_mode, ...archiver },
    devices,
    not_reported: devices.reporting ? [] : ['device timings (no device has reported in the last day)'],
    at: new Date().toISOString(),
  };
}

export async function auditLog(deps: AdminDeps, q: URLSearchParams) {
  const size = int(q.get('pageSize'), 50, 10, 200), page = int(q.get('page'), 0, 0, 1_000_000);
  const args: unknown[] = [];
  const where: string[] = [];
  const eq = (col: string, v: string | null) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
  eq('a.action', q.get('action'));
  eq('a.target_user_id', q.get('target'));
  eq('a.target_type', q.get('targetType'));
  eq('a.target_id', q.get('targetId'));
  eq('a.admin_user_id', q.get('admin'));
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(q.get('from')), to = day(q.get('to'));
  if (from) { args.push(from); where.push(`a.at >= $${args.length}::date`); }
  if (to) { args.push(to); where.push(`a.at < ($${args.length}::date + 1)`); }
  const text = q.get('q')?.trim().slice(0, 100);
  if (text) { args.push(`%${text.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(a.action ILIKE $${args.length} OR a.detail::text ILIKE $${args.length} OR a.target_id ILIKE $${args.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM admin_audit a ${w}`, args);
  // The administrator and a user target are shown by name and email, not only by id: users.id is what admin_user_id holds for a signed-in admin.
  const list = await rows(deps.ro, `SELECT a.id::int, a.admin_user_id, au.email AS admin_email, au.display_name AS admin_name, a.action, a.target_user_id, tu.email AS target_email,
      a.target_type, a.target_id, a.detail, a.at
    FROM admin_audit a LEFT JOIN users au ON au.id = a.admin_user_id LEFT JOIN users tu ON tu.id = a.target_user_id
    ${w} ORDER BY a.at DESC, a.id DESC LIMIT ${size} OFFSET ${page * size}`, args);
  const actions = (await rows(deps.ro, `SELECT DISTINCT action FROM admin_audit ORDER BY 1 LIMIT 300`)).map((r) => r.action as string);
  return { total, page, pageSize: size, entries: list, actions };
}

/** One read-only statement as ao_readonly (the role is read-only and has a 30 s timeout; this adds a row cap). */
export async function runSql(deps: AdminDeps, sql: string) {
  const limit = deps.sqlRowLimit ?? 5000;
  if (!sql.trim()) throw new HttpError(400, 'Write a query.');
  const c = await deps.ro.connect();
  const t0 = performance.now();
  try {
    await c.query('BEGIN READ ONLY');
    // The extended protocol parses exactly one statement, so "SELECT 1; DROP …" is refused.
    const r = await c.query({ text: sql, rowMode: 'array', queryMode: 'extended' } as pg.QueryConfig);
    const truncated = (r.rows?.length ?? 0) > limit;
    return { columns: (r.fields ?? []).map((f) => f.name), rows: (r.rows ?? []).slice(0, limit), rowCount: r.rows?.length ?? r.rowCount ?? 0, truncated, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

// ───────────────────────────────────────────── actions

async function setStatus(deps: AdminDeps, id: string, status: 'active' | 'disabled') {
  const r = await deps.admin.query(`UPDATE users SET status = $2 WHERE id = $1 AND status <> 'deleted' RETURNING id`, [id, status]);
  if (!r.rowCount) throw new HttpError(404, 'No such user.');
}

async function signOut(deps: AdminDeps, id: string) {
  const [u] = await rows(deps.ro, 'SELECT clerk_user_id FROM users WHERE id = $1', [id]);
  if (!u) throw new HttpError(404, 'No such user.');
  // The desktop app's device tokens end first: they are ours, and they outlive Clerk sessions.
  const devices = (await deps.admin.query('UPDATE device_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id])).rowCount ?? 0;
  if (!deps.clerkSecret) return { revoked: 0, devices, clerk: false, note: 'Clerk is not configured on the server yet, so only device sign-ins were ended.' };
  if (!u.clerk_user_id) return { revoked: 0, devices, clerk: true, note: 'This user has no Clerk account.' };
  const api = 'https://api.clerk.com/v1';
  const auth = { authorization: `Bearer ${deps.clerkSecret}` };
  const list = await fetch(`${api}/sessions?user_id=${encodeURIComponent(u.clerk_user_id)}&status=active`, { headers: auth });
  if (!list.ok) throw new HttpError(502, `Clerk refused the session list (${list.status}).`);
  const sessions = (await list.json()) as Array<{ id: string }>;
  for (const s of sessions) {
    const r = await fetch(`${api}/sessions/${s.id}/revoke`, { method: 'POST', headers: auth });
    if (!r.ok) throw new HttpError(502, `Clerk refused to revoke a session (${r.status}).`);
  }
  return { revoked: sessions.length, devices, clerk: true };
}

async function deleteUser(deps: AdminDeps, id: string, confirm: unknown) {
  const [u] = await rows(deps.ro, 'SELECT id, email FROM users WHERE id = $1', [id]);
  if (!u) throw new HttpError(404, 'No such user.');
  const expected = u.email || u.id;
  if (confirm !== expected) throw new HttpError(400, `Type ${expected} to confirm.`);
  // Blob keys first: the cascade removes the rows that name them.
  const blobs = (await rows(deps.ro, 'SELECT DISTINCT blob_key FROM document_revisions WHERE user_id = $1 UNION SELECT DISTINCT blob_key FROM memory_references WHERE user_id = $1 AND blob_key IS NOT NULL', [id])).map((r) => r.blob_key as string);
  let blobsDeleted = 0;
  if (deps.s3) {
    // Everything under the user's prefix, plus any key a row names elsewhere (if it exists).
    const keys = new Set((await deps.s3.list('ao-user-blobs', `${id}/`)).map((o) => o.key));
    for (const k of blobs.map((b) => b.replace(/^ao-user-blobs\//, ''))) if (!keys.has(k) && (await deps.s3.head('ao-user-blobs', k))) keys.add(k);
    for (const k of keys) { await deps.s3.delete('ao-user-blobs', k); blobsDeleted++; }
  }
  await deps.admin.query('DELETE FROM users WHERE id = $1', [id]);
  return { deleted: true, blobsDeleted, blobsPending: deps.s3 ? 0 : blobs.length };
}

// ───────────────────────────────────────────── plans, coupons, credits

const AMOUNT_MAX = 1_000_000_000;
const intIn = (v: unknown, what: string, min = 1, max = AMOUNT_MAX) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}.`);
  return n;
};
const dateOrNull = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${what} is not a date.`);
  return d;
};
const newCode = () => { const a = () => randomBytes(3).toString('hex').toUpperCase(); return `AO-${a()}-${a()}`; };

export async function listPlans(deps: AdminDeps) {
  const list = await rows(deps.ro, `SELECT ${billingSelect}, (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS subscribers FROM plans p ${PLAN_PRICE_JOIN} ORDER BY p.sort_order, p.id`, [DEFAULT_CURRENCY]);
  const prices = await rows(deps.ro, `SELECT plan_id, currency, billing_interval, amount_minor, active FROM plan_prices ORDER BY plan_id, currency, billing_interval`);
  return { plans: list.map((p) => ({ ...p, price_cents: p.price_cents == null ? null : Number(p.price_cents), monthly_credits: Number(p.monthly_credits), prices: prices.filter((x) => x.plan_id === p.id).map((x) => ({ ...x, amount_minor: Number(x.amount_minor) })) })) };
}

export async function listCoupons(deps: AdminDeps) {
  return { coupons: await rows(deps.ro, `SELECT code, amount::bigint::text AS amount, pool, max_redemptions, redeemed_count, starts_at, expires_at, grant_valid_days, plan_id, active, note, created_by, created_at
    FROM coupons ORDER BY created_at DESC LIMIT 500`) };
}

export async function createCoupon(deps: AdminDeps, adminId: string, b: Record<string, unknown>) {
  const code = String(b.code ?? '').trim().toUpperCase() || newCode();
  if (!/^[A-Z0-9_-]{4,40}$/.test(code)) throw new HttpError(400, 'A code is 4–40 letters, digits, _ or -.');
  const pool = b.pool === 'paid' ? 'paid' : 'promo';
  const amount = intIn(b.amount, 'amount');
  const max = b.max_redemptions === undefined || b.max_redemptions === null || b.max_redemptions === '' ? null : intIn(b.max_redemptions, 'max_redemptions', 1, 1_000_000);
  const days = b.grant_valid_days === undefined || b.grant_valid_days === null || b.grant_valid_days === '' ? null : intIn(b.grant_valid_days, 'grant_valid_days', 1, 3650);
  const starts = dateOrNull(b.starts_at, 'starts_at'), ends = dateOrNull(b.expires_at, 'expires_at');
  if (starts && ends && ends <= starts) throw new HttpError(400, 'expires_at must be after starts_at.');
  const plan = b.plan_id ? String(b.plan_id) : null;
  if (plan && !(await rows(deps.ro, 'SELECT 1 FROM plans WHERE id = $1 AND active', [plan])).length) throw new HttpError(400, 'No such plan.');
  try {
    await deps.admin.query(`INSERT INTO coupons(code, amount, pool, max_redemptions, starts_at, expires_at, grant_valid_days, plan_id, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [code, amount, pool, max, starts, ends, days, plan, b.note ? String(b.note).slice(0, 500) : null, adminId]);
  } catch (e) { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'That code already exists.'); throw e; }
  return { code, amount, pool, max_redemptions: max, plan_id: plan };
}

export async function setCouponActive(deps: AdminDeps, code: string, active: boolean) {
  const r = await deps.admin.query('UPDATE coupons SET active = $2 WHERE code = $1', [code.toUpperCase(), active]);
  if (!r.rowCount) throw new HttpError(404, 'No such coupon.');
  return { ok: true };
}

export async function userCredits(deps: AdminDeps, id: string) {
  const [bal] = await rows(deps.ro, 'SELECT promo::text, paid::text, plan_id FROM admin_user_credits WHERE user_id = $1', [id]);
  if (!bal) throw new HttpError(404, 'No such user.');
  const ledger = await rows(deps.ro, `SELECT id::text, kind, pool, amount::text, reason, coupon_code, grant_expires_at, created_by, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
  const usage = await rows(deps.ro, `SELECT coalesce(sum(cost), 0)::text AS cost, count(*)::int AS requests FROM usage_events WHERE user_id = $1`, [id]);
  return { promo: Number(bal.promo), paid: Number(bal.paid), plan_id: bal.plan_id, usage: { cost: Number(usage[0].cost), requests: usage[0].requests }, ledger };
}

/** Support grants and corrections go through the ledger like everything else: a reason is mandatory and the row names the admin. */
export async function adjustCredits(deps: AdminDeps, adminId: string, userId: string, b: Record<string, unknown>) {
  const kind = String(b.kind ?? 'grant');
  if (!['grant', 'refund', 'adjust'].includes(kind)) throw new HttpError(400, 'kind is grant, refund or adjust.');
  const reason = String(b.reason ?? '').trim();
  if (reason.length < 3) throw new HttpError(400, 'Say why (a reason of at least 3 characters).');
  const pool = b.pool === 'promo' ? 'promo' : 'paid';
  if (kind !== 'adjust' && Number(b.amount) < 0) throw new HttpError(400, 'Only an adjustment can be negative.');
  const magnitude = intIn(Math.abs(Number(b.amount)), 'amount');
  const amount = kind === 'adjust' && Number(b.amount) < 0 ? -magnitude : magnitude;
  const expires = kind === 'grant' && pool === 'promo' && b.valid_days ? new Date(Date.now() + intIn(b.valid_days, 'valid_days', 1, 3650) * 86_400_000) : null;
  if (amount < 0) {
    // A deduction may not take a pool below zero.
    const [bal] = await rows(deps.admin, 'SELECT coalesce(sum(amount), 0)::text AS n FROM credit_ledger WHERE user_id = $1 AND pool = $2', [userId, pool]);
    if (Number(bal.n) + amount < 0) throw new HttpError(409, `That would take the ${pool} balance below zero (it is ${bal.n}).`);
  }
  try {
    const r = await deps.admin.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, grant_expires_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [userId, kind, pool, amount, expires, reason.slice(0, 500), adminId]);
    return { ledger_id: r.rows[0].id, kind, pool, amount };
  } catch (e) { if ((e as { code?: string }).code === '23503') throw new HttpError(404, 'No such user.'); throw e; }
}

export async function setPlan(deps: AdminDeps, adminId: string, userId: string, b: Record<string, unknown>) {
  const plan = String(b.plan_id ?? '');
  if (!(await rows(deps.ro, 'SELECT 1 FROM plans WHERE id = $1 AND active', [plan])).length) throw new HttpError(400, 'No such plan.');
  try {
    await deps.admin.query(`INSERT INTO subscriptions(user_id, plan_id, source) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', source = excluded.source, started_at = now(), ends_at = NULL`, [userId, plan, `admin ${adminId}`]);
  } catch (e) { if ((e as { code?: string }).code === '23503') throw new HttpError(404, 'No such user.'); throw e; }
  return { ok: true, plan_id: plan };
}

/** Who may administer. Only an admin token can reach this; a person cannot change their own role, and the last admin cannot be demoted. */
export async function setRole(deps: AdminDeps, adminId: string, userId: string, b: Record<string, unknown>) {
  const role = String(b.role ?? '');
  if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'role is admin or user.');
  if (userId === adminId) throw new HttpError(409, 'You cannot change your own role.');
  if (b.admin_role !== undefined && !isAdminRole(b.admin_role)) throw new HttpError(400, 'Unknown admin_role.');
  const c = await deps.admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin-roles', 0))`);   // two demotions at once cannot both pass the check
    const target = (await c.query(`SELECT u.role, u.status, coalesce(ar.role, 'superadmin') AS admin_role FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [userId])).rows[0];
    if (!target) throw new HttpError(404, 'No such user.');
    if (role === 'admin' && target.status !== 'active') throw new HttpError(409, 'Only an active account can be an admin.');
    if (role === 'user' && target.role === 'admin' && target.admin_role === 'superadmin') {
      const others = (await c.query(`SELECT count(*)::int AS n FROM users u LEFT JOIN admin_roles ar ON ar.user_id = u.id WHERE u.role = 'admin' AND u.status = 'active' AND u.id <> $1 AND coalesce(ar.role, 'superadmin') = 'superadmin'`, [userId])).rows[0].n;
      if (others < 1) throw new HttpError(409, 'That is the last admin. Make someone else an admin first.');
    }
    await c.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
    if (role === 'admin') {
      await c.query(`INSERT INTO admin_roles(user_id, role, granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = now()`,
        [userId, isAdminRole(b.admin_role) ? b.admin_role : target.role === 'admin' ? target.admin_role : 'superadmin', adminId]);
    } else {
      await c.query('DELETE FROM admin_roles WHERE user_id = $1', [userId]);
    }
    await c.query('COMMIT');
    return { ok: true, role };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

// ───────────────────────────────────────────── router

type Json = Record<string, unknown> | unknown[];

export function adminHandler(deps: AdminDeps) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, payload: Json | string, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    try {
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (!url.pathname.startsWith('/admin/')) throw new HttpError(404, 'Not found.');
      const tokenAdmin = await authenticate(req, deps);
      // The web console signs admins in itself and authenticates to this API with a service token; it says who is acting,
      // so admin_audit names the person. Only a static (service) token may do that; a Clerk-authenticated admin is already a person.
      const acting = String(req.headers['x-ao-acting-admin'] ?? '');
      const viaToken = !(req.headers.authorization ?? '').match(/^Bearer\s+[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      if (acting && !(viaToken && /^usr_[a-z0-9]{1,40}$/.test(acting))) throw new HttpError(400, 'x-ao-acting-admin must be a user id, sent with a service token.');
      const adminId = acting || tokenAdmin;
      const via = acting ? tokenAdmin : undefined;
      const audit = (d: AdminDeps, a: string, action: string, target: string | null, detail: Record<string, unknown> = {}) => auditRow(d, a, action, target, via ? { ...detail, via } : detail);
      const parts = url.pathname.split('/').filter(Boolean).slice(1);   // after "admin"
      const m = req.method ?? 'GET';
      const [a, id, act] = parts;

      // Who is asking and what their role allows. The console hides buttons, but THIS is the authority.
      const adminRole: AdminRole | null = acting ? await consoleApi.roleOf(deps, acting) : 'superadmin';
      if (!adminRole) throw new HttpError(403, 'This account is not an active admin.');
      const need = async (p: Permission) => {
        if (can(adminRole, p)) return;
        await audit(deps, adminId, 'denied', null, { need: p, role: adminRole, method: m, path: url.pathname });
        throw new HttpError(403, `Your admin role (${adminRole}) cannot do this.`);
      };
      const q = url.searchParams;

      if (a === 'help') {
        await need('help.use');
        if (m === 'GET' && id === 'status') return send(200, deps.help ? await deps.help.status() : { configured: false });
        if (!deps.help) throw new HttpError(503, 'The help assistant is not configured on this server.');
        if (m === 'POST' && id === 'ask') {
          const b = (await body(req)) as { question?: unknown };
          const r = await deps.help.ask(adminId, adminRole, typeof b.question === 'string' ? b.question : '');
          if ('error' in r) throw new HttpError(r.status, r.error);
          return send(200, r);
        }
        if (m === 'POST' && id === 'feedback') {
          const b = (await body(req)) as { questionId?: unknown; helpful?: unknown };
          if (!Number.isInteger(b.questionId) || typeof b.helpful !== 'boolean') throw new HttpError(400, 'questionId and helpful are required.');
          return send(200, { ok: await deps.help.feedback(adminId, b.questionId as number, b.helpful) });
        }
      }
      if (m === 'GET' && a === 'me') return send(200, { admin: adminId, role: adminRole, permissions: permissionsOf(adminRole), clerk: !!deps.clerkSecret, clerkSignIn: !!deps.verifyClerk, blobs: !!deps.s3 });
      if (m === 'GET' && a === 'overview' && !id) { await need('overview.read'); await audit(deps, adminId, 'view_overview', null); return send(200, await overview(deps)); }
      if (m === 'GET' && a === 'overview' && id === 'series') { await need('overview.read'); return send(200, await consoleApi.overviewSeries(deps, q)); }
      if (m === 'GET' && a === 'attention') return send(200, await attention(deps, adminRole));
      if (m === 'GET' && a === 'activity') { await need('overview.read'); return send(200, await consoleApi.recentActivity(deps, q)); }
      if (m === 'GET' && a === 'status') {
        await need('infra.read');
        const st = await publicStatus(deps.ro);
        const lat = new Map((await deps.ro.query('SELECT service, latency_ms FROM service_status')).rows.map((r: { service: string; latency_ms: number | null }) => [r.service, r.latency_ms]));
        return send(200, { ...st, services: st.services.map((x) => ({ ...x, latencyMs: lat.get(x.id) ?? null })) });
      }
      if (m === 'GET' && a === 'health') { await need('overview.read'); await audit(deps, adminId, 'view_health', null); return send(200, await health(deps)); }
      if (m === 'GET' && a === 'audit') { await need('audit.read'); return send(200, await auditLog(deps, q)); }
      if (m === 'GET' && a === 'users' && !id) {
        await need('users.read');
        const list = await listUsers(deps, q);
        await audit(deps, adminId, q.get('format') === 'csv' ? 'export_users_csv' : 'list_users', null, { q: Object.fromEntries(q), rows: list.users.length });
        return q.get('format') === 'csv' ? send(200, toCsv(list.users), 'text/csv; charset=utf-8') : send(200, list);
      }
      if (m === 'GET' && a === 'users' && id && !act) { await need('users.read'); await audit(deps, adminId, 'view_user', id); return send(200, await userDetail(deps, id)); }
      if (m === 'GET' && a === 'users' && id && act === 'memories') { await need('users.read'); await audit(deps, adminId, 'view_memories', id); return send(200, await userMemories(deps, id)); }
      if (m === 'GET' && a === 'users' && id && act === 'export') { await need('users.export'); await audit(deps, adminId, 'export', id); return send(200, await exportUser(deps, id)); }
      if (m === 'POST' && a === 'users' && id && (act === 'disable' || act === 'enable')) {
        await need('users.write');
        await audit(deps, adminId, act, id); await setStatus(deps, id, act === 'disable' ? 'disabled' : 'active');
        // Keep Keycloak in step: a disabled person cannot sign in there either, and their sessions end. Best effort; our own checks already refuse them.
        return send(200, { ok: true, keycloak: await mirrorKeycloak(deps, id, { enabled: act !== 'disable', endSessions: act === 'disable' }) });
      }
      if (m === 'POST' && a === 'users' && id && act === 'sign-out') { await need('users.write'); await audit(deps, adminId, 'sign_out', id); return send(200, { ...(await signOut(deps, id)), keycloak: await mirrorKeycloak(deps, id, { endSessions: true }) }); }
      if (m === 'GET' && a === 'users' && id && act === 'sign-ins') { await need('sessions.read'); return send(200, await consoleApi.signInHistory(deps, id)); }
      if (m === 'GET' && a === 'users' && id && act === 'keycloak') { await need('sessions.read'); return send(200, await keycloakView(deps, id)); }
      if (m === 'POST' && a === 'users' && id && act === 'devices' && parts[3] && parts[4] === 'revoke') {
        await need('users.write'); await audit(deps, adminId, 'revoke_device', id, { token: parts[3] });
        return send(200, await consoleApi.revokeDeviceToken(deps, id, parts[3]));
      }
      if (m === 'POST' && a === 'users' && id && act === 'browser-sessions' && parts[3] === 'revoke') {
        const b = await body(req);
        await need('users.write'); await audit(deps, adminId, 'revoke_browser_sessions', id, { session: b.session_id ?? 'all' });
        return send(200, await consoleApi.revokeBrowserSessions(deps, id, typeof b.session_id === 'string' ? b.session_id : undefined));
      }
      if (m === 'DELETE' && a === 'users' && id && !act) {
        const b = await body(req);
        await need('users.delete');
        await audit(deps, adminId, 'delete', id);
        const r = await deleteUser(deps, id, b.confirm);
        await audit(deps, adminId, 'delete_done', id, r);
        return send(200, r);
      }
      // ── growth: campaigns, creatives, media, audiences, releases, funnel (src/growth/admin.ts; every change audited there)
      if (a === 'growth') {
        const g = { deps, adminId, need, audit: (action: string, target: string | null, detail: Record<string, unknown> = {}) => audit(deps, adminId, action, target, detail) };
        return send(200, (await growthAdmin.route(g, m, parts.slice(1), req, () => body(req), q)) as Json);
      }
      // ── operations: flags, announcements, support (src/api/ops.ts)
      if (m === 'GET' && a === 'flags') { await need('flags.read'); return send(200, await ops.listFlags(deps)); }
      if (m === 'POST' && a === 'flags' && !id) { const b = await body(req); await need('flags.write'); await audit(deps, adminId, 'save_flag', null, { key: b.key, enabled: b.enabled, rollout_pct: b.rollout_pct }); return send(200, await ops.saveFlag(deps, adminId, b)); }
      if (m === 'DELETE' && a === 'flags' && id) { await need('flags.write'); await audit(deps, adminId, 'delete_flag', null, { key: id }); return send(200, await ops.deleteFlag(deps, id)); }
      if (m === 'GET' && a === 'announcements') { await need('comms.read'); return send(200, { ...(await ops.listAnnouncements(deps)), channels: ops.channelStatus(deps) }); }
      if (m === 'POST' && a === 'announcements' && !id) { const b = await body(req); await need('comms.write'); await audit(deps, adminId, 'create_announcement', null, { title: b.title }); return send(201, await ops.createAnnouncement(deps, adminId, b)); }
      if (m === 'POST' && a === 'announcements' && id && act === 'email') { await need('comms.write'); await audit(deps, adminId, 'email_announcement', null, { id }); return send(200, await ops.emailAnnouncement(deps, adminId, id)); }
      if (m === 'POST' && a === 'announcements' && id) { const b = await body(req); await need('comms.write'); await audit(deps, adminId, 'set_announcement', null, { id, active: b.active }); return send(200, await ops.setAnnouncementActive(deps, id, b.active)); }
      if (m === 'GET' && a === 'tickets' && !id) { await need('support.read'); return send(200, await ops.listTickets(deps, q)); }
      if (m === 'GET' && a === 'tickets' && id) { await need('support.read'); return send(200, await ops.ticketDetail(deps, id)); }
      if (m === 'POST' && a === 'tickets' && id && act === 'reply') { const b = await body(req); await need('support.write'); await audit(deps, adminId, 'reply_ticket', null, { id }); return send(200, await ops.adminReply(deps, adminId, id, b)); }
      if (m === 'POST' && a === 'tickets' && id && act === 'status') { const b = await body(req); await need('support.write'); await audit(deps, adminId, 'set_ticket_status', null, { id, status: b.status }); return send(200, await ops.setTicketStatus(deps, id, b.status)); }
      // ── payments: see everything, reconcile, and take the deliberate steps (settle, reject, refund) with a reason, audited
      if (m === 'GET' && a === 'payments' && !id) { await need('payments.read'); return send(200, { ...(await payAdmin.listOrders(deps, q)), provider: deps.payments ? { id: deps.payments.provider.id, experimental: deps.payments.provider.experimental } : null }); }
      if (m === 'GET' && a === 'payments' && id && !act) { await need('payments.read'); return send(200, await payAdmin.orderDetail(deps, id)); }
      if (m === 'POST' && a === 'payments' && id && act === 'reconcile') {
        await need('payments.write'); await audit(deps, adminId, 'reconcile_payment', null, { order: id });
        if (!deps.payments) throw new HttpError(409, 'Payments are not switched on, so there is no provider to ask.');
        return send(200, await deps.payments.reconcile(id));
      }
      if (m === 'POST' && a === 'payments' && id && act === 'settle') {
        const b = await body(req); await need('payments.write');
        const r = await payAdmin.settleOrder(deps, adminId, id, b);
        const [o] = await rows(deps.ro, 'SELECT user_id, plan_id FROM payment_orders WHERE id = $1', [id]);
        await audit(deps, adminId, 'settle_payment', o?.user_id ?? null, { order: id, reason: b.reason, amount_received: b.amount_received, reference: b.reference ?? null });
        const kc = o ? await mirrorKeycloak(deps, o.user_id, { attributes: { ao_plan: o.plan_id } }) : undefined;
        return send(200, { ...r, keycloak: kc });
      }
      if (m === 'POST' && a === 'payments' && id && act === 'reject') {
        const b = await body(req); await need('payments.write'); await audit(deps, adminId, 'reject_payment', null, { order: id, reason: b.reason });
        return send(200, await payAdmin.rejectOrder(deps, adminId, id, b));
      }
      if (m === 'POST' && a === 'payments' && id && act === 'refund') {
        const b = await body(req); await need('payments.write'); await audit(deps, adminId, 'refund_payment', null, { order: id, reason: b.reason });
        const r = await payAdmin.refundOrder(deps, adminId, id, b);
        const [o] = await rows(deps.ro, 'SELECT user_id FROM payment_orders WHERE id = $1', [id]);
        const kc = o ? await mirrorKeycloak(deps, o.user_id, { attributes: { ao_plan: 'free' } }) : undefined;
        return send(200, { ...r, keycloak: kc });
      }
      if (m === 'GET' && a === 'plans') { await need('plans.read'); return send(200, await listPlans(deps)); }
      if (m === 'POST' && a === 'plans' && !id) {
        const b = await body(req); await need('plans.write'); await audit(deps, adminId, 'create_plan', null, { id: b.id });
        return send(201, await consoleApi.createPlan(deps, b));
      }
      if (m === 'POST' && a === 'plans' && id) {
        const b = await body(req); await need('plans.write'); await audit(deps, adminId, 'update_plan', null, { id, ...b });
        return send(200, await consoleApi.updatePlan(deps, id, b));
      }
      if (m === 'GET' && a === 'subscriptions') { await need('plans.read'); return send(200, await consoleApi.listSubscriptions(deps, q)); }
      if (m === 'GET' && a === 'usage' && id === 'summary') { await need('usage.read'); return send(200, await consoleApi.usageSummary(deps, q)); }
      if (m === 'GET' && a === 'coupons' && !id) { await need('coupons.read'); await audit(deps, adminId, 'list_coupons', null); return send(200, await listCoupons(deps)); }
      if (m === 'POST' && a === 'coupons' && !id) {
        const b = await body(req);
        await need('coupons.write');
        const made = await createCoupon(deps, adminId, b);
        await audit(deps, adminId, 'create_coupon', null, { code: made.code, amount: made.amount, pool: made.pool, max: made.max_redemptions, plan: made.plan_id });
        return send(201, made);
      }
      if (m === 'POST' && a === 'coupons' && id && (act === 'disable' || act === 'enable')) {
        await need('coupons.write');
        await audit(deps, adminId, `${act}_coupon`, null, { code: id }); return send(200, await setCouponActive(deps, id, act === 'enable'));
      }
      if (m === 'GET' && a === 'users' && id && act === 'credits') { await need('credits.read'); await audit(deps, adminId, 'view_credits', id); return send(200, await userCredits(deps, id)); }
      if (m === 'POST' && a === 'users' && id && act === 'credits') {
        const b = await body(req);
        await need('credits.write');
        await audit(deps, adminId, 'adjust_credits', id, { kind: b.kind ?? 'grant', pool: b.pool ?? 'paid', amount: b.amount, reason: String(b.reason ?? '').slice(0, 200) });
        return send(200, await adjustCredits(deps, adminId, id, b));
      }
      if (m === 'POST' && a === 'users' && id && act === 'role') {
        const b = await body(req);
        await need('roles.write');
        await audit(deps, adminId, 'set_role', id, { role: b.role, admin_role: b.admin_role });
        const done = await setRole(deps, adminId, id, b);
        return send(200, { ...done, keycloak: await mirrorKeycloak(deps, id, { attributes: { ao_role: String(b.role) } }) });
      }
      if (m === 'POST' && a === 'users' && id && act === 'admin-role') {
        const b = await body(req);
        await need('roles.write');
        await audit(deps, adminId, 'set_admin_role', id, { admin_role: b.admin_role });
        return send(200, await consoleApi.setAdminRole(deps, adminId, id, b));
      }
      // ── access requests: a signed-in person asks to be let in; a person with roles.write decides
      if (m === 'POST' && a === 'access-requests' && !id) { const b = await body(req); await audit(deps, adminId, 'access_request', typeof b.user_id === 'string' ? b.user_id : null, { note: typeof b.note === 'string' ? b.note.slice(0, 80) : null }); return send(200, await access.createRequest(deps, b)); }
      if (m === 'GET' && a === 'access-requests' && !id) { await need('roles.read'); return send(200, await access.listRequests(deps, q)); }
      if (m === 'POST' && a === 'access-requests' && id && (act === 'approve' || act === 'decline')) {
        const b = await body(req); await need('roles.write');
        if (!/^usr_[A-Za-z0-9_-]+$/.test(adminId)) throw new HttpError(400, 'Decide as a person, not as the service token.');
        await audit(deps, adminId, act === 'approve' ? 'approve_access' : 'decline_access', null, { request: id, admin_role: b.admin_role ?? null });
        if (act === 'decline') return send(200, await access.decline(deps, adminId, id, b));
        const done = await access.approve(deps, adminId, id, b);
        return send(200, { ...done, keycloak: await mirrorKeycloak(deps, done.user_id, { attributes: { ao_role: 'admin' } }) });
      }
      // ── add an administrator by email (waits as an invite until that person first signs in with the verified address)
      if (m === 'POST' && a === 'admin-invites' && !id && !act) {
        const b = await body(req); await need('roles.write');
        await audit(deps, adminId, 'invite_admin', null, { email: String(b.email ?? '').slice(0, 120), admin_role: b.admin_role });
        const done = await invites.invite(deps, adminId, b);
        return send(200, done.status === 'granted' ? { ...done, keycloak: await mirrorKeycloak(deps, done.user_id, { attributes: { ao_role: 'admin' } }) } : done);
      }
      if (m === 'GET' && a === 'admin-invites' && !id) { await need('roles.read'); return send(200, await invites.listInvites(deps)); }
      if (m === 'POST' && a === 'admin-invites' && id === 'revoke') { const b = await body(req); await need('roles.write'); await audit(deps, adminId, 'revoke_admin_invite', null, { email: String(b.email ?? '').slice(0, 120) }); return send(200, await invites.revoke(deps, b)); }
      if (m === 'POST' && a === 'admin-invites' && id === 'claim') {
        const b = await body(req);
        const r = await invites.claim(deps, b);
        if (r.claimed) await audit(deps, adminId, 'claim_admin_invite', r.user_id, { admin_role: r.admin_role });
        return send(200, r.claimed ? { ...r, keycloak: await mirrorKeycloak(deps, r.user_id, { attributes: { ao_role: 'admin' } }) } : r);
      }
      if (m === 'GET' && a === 'admins') { await need('roles.read'); return send(200, await consoleApi.listAdmins(deps)); }
      if (m === 'POST' && a === 'users' && id && act === 'plan') {
        const b = await body(req);
        await need('plans.write');
        await audit(deps, adminId, 'set_plan', id, { plan_id: b.plan_id });
        const done = await setPlan(deps, adminId, id, b);
        return send(200, { ...done, keycloak: await mirrorKeycloak(deps, id, { attributes: { ao_plan: String(b.plan_id) } }) });
      }
      if (m === 'GET' && a === 'sessions' && !id) { await need('sessions.read'); return send(200, await consoleApi.listSessions(deps, q)); }
      if (m === 'GET' && a === 'sessions' && id) { await need('sessions.read'); return send(200, await consoleApi.sessionDetail(deps, id)); }
      if (m === 'GET' && a === 'auth-sessions') { await need('sessions.read'); return send(200, await consoleApi.authSessions(deps, q)); }
      if (m === 'GET' && a === 'reliability') { await need('runs.read'); return send(200, await consoleApi.reliability(deps, q)); }
      if (m === 'GET' && a === 'analytics') { await need('analytics.read'); return send(200, await consoleApi.analytics(deps, q)); }
      if (m === 'GET' && a === 'runs' && !id) { await need('runs.read'); return send(200, await consoleApi.listRuns(deps, q)); }
      if (m === 'GET' && a === 'runs' && id) { await need('runs.read'); return send(200, await consoleApi.runDetail(deps, id)); }
      if (m === 'POST' && a === 'sql') {
        const b = await body(req);
        await need('sql.read');
        const sql = String(b.sql ?? '');
        await audit(deps, adminId, 'sql', null, { sql: sql.slice(0, 4000) });
        return send(200, await runSql(deps, sql));
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(status, { error: status === 500 ? 'Server error.' : (e as Error).message });
    }
  };
}
