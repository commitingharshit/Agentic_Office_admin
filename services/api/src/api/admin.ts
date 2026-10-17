// The admin API: everything the Admin Console shows or does goes through here, never through
// raw SQL writes from a client. Reads use ao_readonly (sees every user, never event payloads);
// actions use ao_admin; every request — views included — is written to admin_audit first.
//
// Auth: a bearer token mapped to an admin id (AO_ADMIN_TOKENS). When Clerk is wired, the same
// `authenticate` seam verifies a Clerk session JWT and requires publicMetadata.role = "admin".
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import type { S3 } from './s3.ts';
import type { ClerkClaims } from '../auth/clerk.ts';

export interface AdminDeps {
  ro: pg.Pool;
  admin: pg.Pool;
  /** sha256(token) → admin id. */
  tokens: Map<string, string>;
  s3?: S3;
  clerkSecret?: string;
  /** Verifies a Clerk session token; with it, admins sign in with Clerk instead of a token. */
  verifyClerk?(token: string): Promise<ClerkClaims>;
  /** Row cap for the SQL view. */
  sqlRowLimit?: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

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

async function authenticate(req: IncomingMessage, deps: AdminDeps): Promise<string> {
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

async function audit(deps: AdminDeps, adminId: string, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  await deps.admin.query('INSERT INTO admin_audit(admin_user_id, action, target_user_id, detail) VALUES ($1,$2,$3,$4)', [adminId, action, target, JSON.stringify(detail)]);
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
  if (q.get('from')) add('created_at >= ?::date', q.get('from'));
  if (q.get('to')) add(`created_at < ?::date + 1`, q.get('to'));
  const sort = SORTS[q.get('sort') ?? 'created'] ?? 'created_at';
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const csv = q.get('format') === 'csv';
  const size = csv ? 10_000 : int(q.get('pageSize'), 25, 5, 200);
  const page = csv ? 0 : int(q.get('page'), 0, 0, 1_000_000);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM admin_user_overview ${w}`, args);
  const list = await rows(deps.ro, `SELECT id, email, display_name, role, status, providers, created_at, last_active_at, devices::int, workspaces::int, sessions::int, storage_bytes::bigint, memories::int
    FROM admin_user_overview ${w} ORDER BY ${sort} ${dir} NULLS LAST, id LIMIT ${size} OFFSET ${page * size}`, args);
  const users = list.map((u) => ({ ...u, storage_bytes: Number(u.storage_bytes) }));
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
    rows(deps.ro, `SELECT w.id, w.name, w.updated_at, (SELECT count(*) FROM sessions s WHERE s.workspace_id = w.id)::int AS sessions FROM workspaces w WHERE w.user_id = $1 ORDER BY w.updated_at DESC`, [id]),
    rows(deps.ro, `SELECT to_char(d, 'Mon DD') AS day, count(e.event_id)::int AS events
      FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
      LEFT JOIN session_events e ON e.user_id = $1 AND e.created_at >= d AND e.created_at < d + interval '1 day' GROUP BY d ORDER BY d`, [id]),
    rows(deps.ro, 'SELECT admin_user_id, action, detail, at FROM admin_audit WHERE target_user_id = $1 ORDER BY at DESC LIMIT 50', [id]),
    rows(deps.ro, 'SELECT device_id, stream, updated_at FROM sync_cursors WHERE user_id = $1 ORDER BY updated_at DESC', [id]),
  ]);
  return { user: { ...user, storage_bytes: Number(user.storage_bytes) }, identities, devices, workspaces, usage, audit: auditTrail, sync };
}

export async function exportUser(deps: AdminDeps, id: string) {
  const tables = ['users', 'oauth_accounts', 'devices', 'workspaces', 'sessions', 'agent_runs', 'document_revisions', 'memory_references', 'sync_cursors'];
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), note: 'Account metadata only. Documents, transcripts and memories are encrypted on the user\'s devices; blob keys are listed.' };
  for (const t of tables) out[t] = await rows(deps.ro, `SELECT * FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = $1`, [id]);
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
  if (q.get('action')) { args.push(q.get('action')); where.push(`action = $${args.length}`); }
  if (q.get('target')) { args.push(q.get('target')); where.push(`target_user_id = $${args.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ total }] = await rows(deps.ro, `SELECT count(*)::int AS total FROM admin_audit ${w}`, args);
  const list = await rows(deps.ro, `SELECT id::int, admin_user_id, action, target_user_id, detail, at FROM admin_audit ${w} ORDER BY at DESC, id DESC LIMIT ${size} OFFSET ${page * size}`, args);
  return { total, page, pageSize: size, entries: list };
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
      const adminId = await authenticate(req, deps);
      const parts = url.pathname.split('/').filter(Boolean).slice(1);   // after "admin"
      const m = req.method ?? 'GET';
      const [a, id, act] = parts;

      if (m === 'GET' && a === 'me') return send(200, { admin: adminId, clerk: !!deps.clerkSecret, clerkSignIn: !!deps.verifyClerk, blobs: !!deps.s3 });
      if (m === 'GET' && a === 'overview') { await audit(deps, adminId, 'view_overview', null); return send(200, await overview(deps)); }
      if (m === 'GET' && a === 'health') { await audit(deps, adminId, 'view_health', null); return send(200, await health(deps)); }
      if (m === 'GET' && a === 'audit') return send(200, await auditLog(deps, url.searchParams));
      if (m === 'GET' && a === 'users' && !id) {
        const list = await listUsers(deps, url.searchParams);
        await audit(deps, adminId, url.searchParams.get('format') === 'csv' ? 'export_users_csv' : 'list_users', null, { q: Object.fromEntries(url.searchParams), rows: list.users.length });
        return url.searchParams.get('format') === 'csv' ? send(200, toCsv(list.users), 'text/csv; charset=utf-8') : send(200, list);
      }
      if (m === 'GET' && a === 'users' && id && !act) { await audit(deps, adminId, 'view_user', id); return send(200, await userDetail(deps, id)); }
      if (m === 'GET' && a === 'users' && id && act === 'export') { await audit(deps, adminId, 'export', id); return send(200, await exportUser(deps, id)); }
      if (m === 'POST' && a === 'users' && id && (act === 'disable' || act === 'enable')) {
        await audit(deps, adminId, act, id); await setStatus(deps, id, act === 'disable' ? 'disabled' : 'active'); return send(200, { ok: true });
      }
      if (m === 'POST' && a === 'users' && id && act === 'sign-out') { await audit(deps, adminId, 'sign_out', id); return send(200, await signOut(deps, id)); }
      if (m === 'DELETE' && a === 'users' && id && !act) {
        const b = await body(req);
        await audit(deps, adminId, 'delete', id);
        const r = await deleteUser(deps, id, b.confirm);
        await audit(deps, adminId, 'delete_done', id, r);
        return send(200, r);
      }
      if (m === 'POST' && a === 'sql') {
        const b = await body(req);
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
