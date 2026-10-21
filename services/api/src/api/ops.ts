// Operations: feature flags, announcements and support tickets.
// Flags are evaluated on the server and the server enforces the ones that matter (a kill switch for managed inference), so the console is
// never the only control. Announcements and tickets are plain text the person or an admin chose to write; nothing is collected automatically.
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { AdminDeps } from './admin.ts';
import { HttpError } from './errors.ts';

const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
const text = (v: unknown, what: string, min: number, max: number): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${what} must be ${min}–${max} characters.`);
  return s;
};
const plans = (v: unknown): string[] | null => {
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(p))) throw new HttpError(400, 'plan_ids must be a list of plan ids.');
  return v as string[];
};

// ── flags ───────────────────────────────────────────────────────────────────────────────────────

export interface Flag { key: string; enabled: boolean; rollout_pct: number; plan_ids: string[] | null }

/** A person's slice of a rollout is fixed by their id and the flag key, so it does not flicker between requests or devices. */
export const bucket = (userId: string, key: string): number => createHash('sha256').update(`${userId}:${key}`).digest().readUInt32BE(0) % 100;
export const evaluate = (f: Flag, userId: string, planId: string): boolean =>
  f.enabled && (f.plan_ids === null || f.plan_ids.includes(planId)) && bucket(userId, f.key) < f.rollout_pct;

/** The flags as this person sees them. Used by the app (GET /v1/config/client) and by server-side enforcement. */
export async function flagsFor(c: pg.PoolClient, userId: string): Promise<{ plan: string; flags: Record<string, boolean>; raw: Flag[] }> {
  const plan = (await c.query(`SELECT coalesce((SELECT plan_id FROM subscriptions WHERE user_id = $1 AND status = 'active'), 'free') AS plan`, [userId])).rows[0].plan as string;
  const raw = (await c.query('SELECT key, enabled, rollout_pct, plan_ids FROM feature_flags ORDER BY key')).rows as Flag[];
  return { plan, flags: Object.fromEntries(raw.map((f) => [f.key, evaluate(f, userId, plan)])), raw };
}

/** `killswitch.managed_inference` switched on stops managed inference for everyone it applies to. */
export const killed = (raw: Flag[], key: string, userId: string, plan: string) => { const f = raw.find((x) => x.key === key); return !!f && evaluate(f, userId, plan); };

export const listFlags = async (deps: AdminDeps) => ({ flags: await rows(deps.ro, 'SELECT key, description, enabled, rollout_pct, plan_ids, updated_by, updated_at FROM feature_flags ORDER BY key') });

export async function saveFlag(deps: AdminDeps, adminId: string, b: Record<string, unknown>) {
  const key = String(b.key ?? '');
  if (!KEY.test(key)) throw new HttpError(400, 'A flag key is lower-case letters, digits, . _ or -, up to 60.');
  const pct = b.rollout_pct === undefined ? 100 : Number(b.rollout_pct);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'rollout_pct is a whole number from 0 to 100.');
  if (typeof b.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
  await deps.admin.query(`INSERT INTO feature_flags(key, description, enabled, rollout_pct, plan_ids, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled, rollout_pct = EXCLUDED.rollout_pct, plan_ids = EXCLUDED.plan_ids, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, typeof b.description === 'string' ? b.description.slice(0, 300) : '', b.enabled, pct, plans(b.plan_ids), adminId]);
  return { key };
}

export async function deleteFlag(deps: AdminDeps, key: string) {
  if (!KEY.test(key)) throw new HttpError(400, 'Not a flag key.');
  if (!(await deps.admin.query('DELETE FROM feature_flags WHERE key = $1', [key])).rowCount) throw new HttpError(404, 'No such flag.');
  return { ok: true };
}

// ── announcements ───────────────────────────────────────────────────────────────────────────────

export async function liveAnnouncements(c: pg.PoolClient, userId: string) {
  const plan = (await c.query(`SELECT coalesce((SELECT plan_id FROM subscriptions WHERE user_id = $1 AND status = 'active'), 'free') AS plan`, [userId])).rows[0].plan as string;
  const r = await c.query(`SELECT a.id, a.title, a.body, a.level, a.starts_at FROM announcements a
    WHERE a.active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now()) AND (a.plan_ids IS NULL OR $1 = ANY(a.plan_ids))
      AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id) ORDER BY a.starts_at DESC LIMIT 20`, [plan]);
  return { announcements: r.rows };
}
export async function markRead(c: pg.PoolClient, userId: string, id: string) {
  if (!ID.test(id)) throw new HttpError(400, 'Not an announcement id.');
  if (!(await c.query('SELECT 1 FROM announcements WHERE id = $1', [id])).rowCount) throw new HttpError(404, 'No such announcement.');
  await c.query('INSERT INTO announcement_reads(user_id, announcement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, id]);
  return { ok: true };
}

export async function listAnnouncements(deps: AdminDeps) {
  return { announcements: await rows(deps.ro, `SELECT a.id, a.title, a.body, a.level, a.starts_at, a.ends_at, a.plan_ids, a.active, a.created_by, a.created_at,
    (SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads,
    (SELECT count(*)::int FROM email_deliveries d WHERE d.announcement_id = a.id AND d.status = 'sent') AS emailed,
    (SELECT count(*)::int FROM email_deliveries d WHERE d.announcement_id = a.id AND d.status = 'failed') AS email_failed FROM announcements a ORDER BY a.created_at DESC LIMIT 100`) };
}
export async function createAnnouncement(deps: AdminDeps, adminId: string, b: Record<string, unknown>) {
  const id = newId('ann');
  const ends = b.ends_at ? new Date(String(b.ends_at)) : null;
  if (ends && Number.isNaN(ends.getTime())) throw new HttpError(400, 'ends_at is not a date.');
  await deps.admin.query(`INSERT INTO announcements(id, title, body, level, ends_at, plan_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, text(b.title, 'The title', 1, 160), text(b.body, 'The message', 1, 4000), b.level === 'warn' ? 'warn' : 'info', ends, plans(b.plan_ids), adminId]);
  return { id };
}
export async function setAnnouncementActive(deps: AdminDeps, id: string, active: unknown) {
  if (!ID.test(id)) throw new HttpError(400, 'Not an announcement id.');
  if (typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false.');
  if (!(await deps.admin.query('UPDATE announcements SET active = $2 WHERE id = $1', [id, active])).rowCount) throw new HttpError(404, 'No such announcement.');
  return { ok: true };
}

/** Which message channels are actually connected. Nothing is sent through a channel that says false. */
export const channelStatus = (deps: AdminDeps) => ({ in_app: { configured: true }, email: { configured: !!deps.mailer }, whatsapp: { configured: false } });

/** Email an announcement to every active person who has an address and has not been emailed it yet. Refuses with 409 when no provider
 *  is configured. Each person's result is recorded from the provider's own answer; one failure does not stop the rest. */
export async function emailAnnouncement(deps: AdminDeps, adminId: string, id: string) {
  if (!ID.test(id)) throw new HttpError(400, 'Not an announcement id.');
  if (!deps.mailer) throw new HttpError(409, 'Email is not configured on this server, so nothing was sent.');
  const [a] = await rows(deps.ro, 'SELECT title, body, active FROM announcements WHERE id = $1', [id]);
  if (!a) throw new HttpError(404, 'No such announcement.');
  if (!a.active) throw new HttpError(409, 'Switch the announcement on before emailing it.');
  const people = await rows(deps.ro, `SELECT u.id, u.email FROM users u WHERE u.status = 'active' AND u.email IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.announcement_id = $1 AND d.user_id = u.id AND d.status = 'sent') ORDER BY u.created_at LIMIT 500`, [id]);
  let sent = 0, failed = 0;
  // A person deleted while the send is under way has nothing to record against (the foreign key says so): skip them, never fail the whole send.
  const gone = (e: unknown) => (e as { code?: string }).code === '23503';
  for (const p of people) {
    try {
      const r = await deps.mailer({ to: p.email, subject: a.title, text: a.body });
      await deps.admin.query(`INSERT INTO email_deliveries(announcement_id, user_id, status, provider_id, created_by) VALUES ($1,$2,'sent',$3,$4)
        ON CONFLICT (announcement_id, user_id) DO UPDATE SET status = 'sent', provider_id = EXCLUDED.provider_id, error = NULL, created_at = now()`, [id, p.id, r.id, adminId]);
      sent++;
    } catch (e) {
      if (gone(e)) continue;
      await deps.admin.query(`INSERT INTO email_deliveries(announcement_id, user_id, status, error, created_by) VALUES ($1,$2,'failed',$3,$4)
        ON CONFLICT (announcement_id, user_id) DO UPDATE SET status = 'failed', error = EXCLUDED.error, created_at = now()`, [id, p.id, String((e as Error).message).slice(0, 200), adminId]).catch((e2) => { if (!gone(e2)) throw e2; });
      failed++;
    }
  }
  return { sent, failed, considered: people.length };
}

// ── support tickets ─────────────────────────────────────────────────────────────────────────────

export async function openTicket(c: pg.PoolClient, userId: string, b: Record<string, unknown>) {
  const id = newId('tkt');
  const open = (await c.query(`SELECT count(*)::int AS n FROM support_tickets WHERE status <> 'closed'`)).rows[0].n;
  if (open >= 10) throw new HttpError(429, 'You have 10 open tickets. Wait for a reply or close one first.');
  await c.query('INSERT INTO support_tickets(id, user_id, subject) VALUES ($1,$2,$3)', [id, userId, text(b.subject, 'The subject', 1, 200)]);
  await c.query(`INSERT INTO support_messages(ticket_id, user_id, author, body) VALUES ($1,$2,'user',$3)`, [id, userId, text(b.body, 'The message', 1, 4000)]);
  return { id };
}
export async function myTickets(c: pg.PoolClient) {
  const t = (await c.query('SELECT id, subject, status, created_at, updated_at FROM support_tickets ORDER BY updated_at DESC LIMIT 50')).rows;
  const m = (await c.query('SELECT ticket_id, author, body, created_at FROM support_messages ORDER BY id')).rows;
  return { tickets: t.map((x) => ({ ...x, messages: m.filter((y) => y.ticket_id === x.id).map(({ author, body, created_at }) => ({ author, body, created_at })) })) };
}
export async function userReply(c: pg.PoolClient, userId: string, ticketId: string, b: Record<string, unknown>) {
  if (!ID.test(ticketId)) throw new HttpError(400, 'Not a ticket id.');
  const t = (await c.query('SELECT status FROM support_tickets WHERE id = $1', [ticketId])).rows[0];
  if (!t) throw new HttpError(404, 'No such ticket.');
  if (t.status === 'closed') throw new HttpError(409, 'This ticket is closed. Open a new one.');
  await c.query(`INSERT INTO support_messages(ticket_id, user_id, author, body) VALUES ($1,$2,'user',$3)`, [ticketId, userId, text(b.body, 'The message', 1, 4000)]);
  await c.query(`UPDATE support_tickets SET status = 'open', updated_at = now() WHERE id = $1`, [ticketId]);
  return { ok: true };
}

export async function listTickets(deps: AdminDeps, q: URLSearchParams) {
  const status = q.get('status');
  const args: unknown[] = []; let w = '';
  if (status) { if (!['open', 'pending', 'closed'].includes(status)) throw new HttpError(400, 'Unknown status.'); args.push(status); w = 'WHERE t.status = $1'; }
  return { tickets: await rows(deps.ro, `SELECT t.id, t.user_id, u.email, t.subject, t.status, t.created_at, t.updated_at,
    (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS messages FROM support_tickets t JOIN users u ON u.id = t.user_id ${w} ORDER BY t.updated_at DESC LIMIT 200`, args) };
}
export async function ticketDetail(deps: AdminDeps, id: string) {
  if (!ID.test(id)) throw new HttpError(400, 'Not a ticket id.');
  const [t] = await rows(deps.ro, `SELECT t.id, t.user_id, u.email, t.subject, t.status, t.created_at, t.updated_at FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [id]);
  if (!t) throw new HttpError(404, 'No such ticket.');
  return { ticket: t, messages: await rows(deps.ro, 'SELECT id::int, author, admin_user_id, body, created_at FROM support_messages WHERE ticket_id = $1 ORDER BY id', [id]) };
}
export async function adminReply(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!ID.test(id)) throw new HttpError(400, 'Not a ticket id.');
  const t = (await rows(deps.ro, 'SELECT user_id, status FROM support_tickets WHERE id = $1', [id]))[0];
  if (!t) throw new HttpError(404, 'No such ticket.');
  await deps.admin.query(`INSERT INTO support_messages(ticket_id, user_id, author, admin_user_id, body) VALUES ($1,$2,'admin',$3,$4)`, [id, t.user_id, adminId, text(b.body, 'The reply', 1, 4000)]);
  await deps.admin.query(`UPDATE support_tickets SET status = 'pending', updated_at = now() WHERE id = $1`, [id]);
  return { ok: true };
}
export async function setTicketStatus(deps: AdminDeps, id: string, status: unknown) {
  if (!ID.test(id)) throw new HttpError(400, 'Not a ticket id.');
  if (typeof status !== 'string' || !['open', 'pending', 'closed'].includes(status)) throw new HttpError(400, 'Unknown status.');
  if (!(await deps.admin.query('UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1', [id, status])).rowCount) throw new HttpError(404, 'No such ticket.');
  return { ok: true };
}
