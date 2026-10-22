// Service status: probe each service, turn the answers into up / degraded / down, keep the history, and answer the public
// GET /v1/status with coarse facts only. The same code runs inside the API (internal checks: database, the services it can reach)
// and in services/prober (from outside the stack, so a dead gateway or tunnel is seen too).
import type pg from 'pg';

export type State = 'up' | 'degraded' | 'down';
export interface Target { id: string; label: string; sort?: number; check: () => Promise<void> }
export interface Reading { id: string; label: string; sort: number; state: State; latencyMs: number | null }

export const SLOW_MS = 2_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A target that answers with an acceptable status code (default: any 2xx) within the timeout. Redirects are not followed. */
export function httpTarget(o: { id: string; label: string; url: string; expect?: number[]; timeoutMs?: number; sort?: number; fetch?: typeof fetch }): Target {
  if (!ID_RE.test(o.id)) throw new Error(`bad service id ${JSON.stringify(o.id)}`);
  const u = new URL(o.url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('probe urls must be http(s)');
  const f = o.fetch ?? fetch;
  return { id: o.id, label: o.label, sort: o.sort, check: async () => {
    const r = await f(o.url, { redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 5_000), headers: { 'user-agent': 'ao-status-probe' } });
    await r.arrayBuffer().catch(() => undefined);
    if (!(o.expect ? o.expect.includes(r.status) : r.status >= 200 && r.status < 300)) throw new Error(`status ${r.status}`);
  } };
}

export function dbTarget(pool: Pick<pg.Pool, 'query'>, o: { id?: string; label?: string; sort?: number } = {}): Target {
  return { id: o.id ?? 'database', label: o.label ?? 'Database', sort: o.sort, check: async () => { await pool.query('SELECT 1'); } };
}

/** Reads AO_STATUS_PROBES: a JSON array of {id, label, url, expect?, timeoutMs?}. Invalid entries are reported and skipped. */
export function targetsFromEnv(raw: string | undefined, warn: (m: string) => void = () => undefined): Target[] {
  if (!raw) return [];
  let list: unknown;
  try { list = JSON.parse(raw); } catch { warn('AO_STATUS_PROBES is not JSON; no probes loaded'); return []; }
  if (!Array.isArray(list)) { warn('AO_STATUS_PROBES must be an array'); return []; }
  const out: Target[] = [];
  list.forEach((e: any, i) => {
    try {
      if (!e || typeof e.id !== 'string' || typeof e.label !== 'string' || typeof e.url !== 'string') throw new Error('needs id, label and url');
      out.push(httpTarget({ id: e.id, label: e.label.slice(0, 60), url: e.url, ...(Array.isArray(e.expect) ? { expect: e.expect.filter(Number.isInteger) } : {}), ...(Number.isInteger(e.timeoutMs) ? { timeoutMs: Math.min(e.timeoutMs, 15_000) } : {}), sort: 100 + i }));
    } catch (err) { warn(`AO_STATUS_PROBES[${i}] skipped: ${(err as Error).message}`); }
  });
  return out;
}

export async function probeOnce(t: Target, now: () => number = Date.now): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = now();
  try { await t.check(); return { ok: true, latencyMs: Math.max(0, now() - t0) }; }
  catch { return { ok: false, latencyMs: Math.max(0, now() - t0) }; }
}

/** One failed check is "degraded" (it may be a blip); down needs the previous reading to have been a failure too. A slow success is degraded. */
export function nextState(prev: State | undefined, r: { ok: boolean; latencyMs: number }): State {
  if (r.ok) return r.latencyMs > SLOW_MS ? 'degraded' : 'up';
  return prev === 'degraded' || prev === 'down' ? 'down' : 'degraded';
}

/** Probes every target once (in parallel, one failure never stops the others) and records the readings. */
export async function sweep(admin: Pick<pg.Pool, 'query'>, targets: Target[], now: () => number = Date.now): Promise<Reading[]> {
  const prev = new Map((await admin.query('SELECT service, state FROM service_status')).rows.map((r: { service: string; state: State }) => [r.service, r.state]));
  const readings = await Promise.all(targets.map(async (t, i): Promise<Reading> => {
    const r = await probeOnce(t, now);
    // A failed check keeps the previous "last failed" streak: it needs the previous stored state, but a failure's own state is derived from it.
    return { id: t.id, label: t.label, sort: t.sort ?? 100 + i, state: nextState(prev.get(t.id), r), latencyMs: r.ok ? r.latencyMs : null };
  }));
  for (const r of readings) {
    await admin.query(
      `INSERT INTO service_status(service, label, state, latency_ms, sort) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (service) DO UPDATE SET label = EXCLUDED.label, latency_ms = EXCLUDED.latency_ms, checked_at = now(), sort = EXCLUDED.sort,
         since = CASE WHEN service_status.state = EXCLUDED.state THEN service_status.since ELSE now() END, state = EXCLUDED.state`,
      [r.id, r.label, r.state, r.latencyMs, r.sort]);
    await admin.query('INSERT INTO status_checks(service, state, latency_ms) VALUES ($1,$2,$3)', [r.id, r.state, r.latencyMs]);
  }
  await admin.query(`DELETE FROM status_checks WHERE checked_at < now() - interval '90 days'`);
  return readings;
}

export interface PublicStatus {
  generatedAt: string;
  overall: State;
  services: Array<{ id: string; label: string; state: State; checkedAt: string; since: string; uptime90d: number | null; days: Array<number | null> }>;
}

/** A reading older than this is not trusted: the prober itself may be what is down. */
export const STALE_MS = 3 * 60_000;

export async function publicStatus(ro: Pick<pg.Pool, 'query'>, now: () => number = Date.now): Promise<PublicStatus> {
  const cur = (await ro.query('SELECT service, label, state, checked_at, since FROM service_status ORDER BY sort, service')).rows as Array<{ service: string; label: string; state: State; checked_at: Date; since: Date }>;
  const hist = (await ro.query(
    `SELECT service, to_char(checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n, count(*) FILTER (WHERE state = 'up')::int AS up
       FROM status_checks WHERE checked_at >= now() - interval '90 days' GROUP BY 1, 2`)).rows as Array<{ service: string; day: string; n: number; up: number }>;
  const today = Math.floor(now() / 86_400_000);
  const services = cur.map((c) => {
    const mine = hist.filter((h) => h.service === c.service);
    const days: Array<number | null> = Array.from({ length: 90 }, () => null);
    let n = 0, up = 0;
    for (const h of mine) {
      const idx = 89 - (today - Math.floor(Date.parse(`${h.day}T00:00:00Z`) / 86_400_000));
      if (idx >= 0 && idx < 90) days[idx] = Math.round((h.up / h.n) * 1000) / 10;
      n += h.n; up += h.up;
    }
    // A stale reading is shown as down: nobody has confirmed the service lately.
    const stale = now() - new Date(c.checked_at).getTime() > STALE_MS;
    return { id: c.service, label: c.label, state: stale ? 'down' as State : c.state, checkedAt: new Date(c.checked_at).toISOString(), since: new Date(c.since).toISOString(), uptime90d: n ? Math.round((up / n) * 10000) / 100 : null, days };
  });
  const overall: State = services.some((s) => s.state === 'down') ? 'down' : services.some((s) => s.state === 'degraded') ? 'degraded' : 'up';
  return { generatedAt: new Date(now()).toISOString(), overall: services.length ? overall : 'down', services };
}

/** GET /v1/status, unauthenticated and cacheable for 15 s. Answers true when it handled the request. */
export function statusHandler(ro: Pick<pg.Pool, 'query'>) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/v1/status') return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' }); res.end('{"error":"GET only"}'); return true; }
    try {
      const body = JSON.stringify(await publicStatus(ro));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=15', 'access-control-allow-origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"error":"status unavailable"}');
    }
    return true;
  };
}
