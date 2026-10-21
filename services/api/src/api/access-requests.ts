// "Let me in": a person who signed in but is not an administrator asks for admin access; an administrator decides.
import { randomBytes } from 'node:crypto';
import type { AdminDeps } from './admin.ts';
import { setRole } from './admin.ts';
import { HttpError } from './errors.ts';
import { ADMIN_ROLES, isAdminRole } from './rbac.ts';

const USER = /^[A-Za-z0-9_-]{1,80}$/;
const REQ = /^req_[A-Za-z0-9]{10,60}$/;
const ulid = () => `${Date.now().toString(36).padStart(10, '0')}${randomBytes(8).toString('hex')}`;
const text = (v: unknown, max: number): string | null => { if (v === undefined || v === null || v === '') return null; const s = String(v).trim(); if (s.length > max) throw new HttpError(400, `Keep it to ${max} characters.`); return s || null; };

/** Called by the console's sign-in for a person it just turned away. Asking again returns the same open request. */
export async function createRequest(deps: AdminDeps, b: Record<string, unknown>) {
  const userId = String(b.user_id ?? '');
  if (!USER.test(userId)) throw new HttpError(400, 'Not a user id.');
  const note = text(b.note, 300);
  const [u] = (await deps.ro.query('SELECT id, role, status FROM users WHERE id = $1', [userId])).rows;
  if (!u) throw new HttpError(404, 'No such user.');
  if (u.status !== 'active') throw new HttpError(409, 'This account is not active.');
  if (u.role === 'admin') throw new HttpError(409, 'This person is already an administrator.');
  const id = `req_${ulid()}`;
  const r = await deps.admin.query(`INSERT INTO access_requests(id, user_id, note) VALUES ($1,$2,$3) ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING RETURNING id`, [id, userId, note]);
  if (r.rowCount) return { id, status: 'pending', reused: false };
  const [open] = (await deps.ro.query(`SELECT id FROM access_requests WHERE user_id = $1 AND status = 'pending'`, [userId])).rows;
  return { id: open.id as string, status: 'pending', reused: true };
}

export async function listRequests(deps: AdminDeps, q: URLSearchParams) {
  const status = q.get('status') ?? 'pending';
  if (!['pending', 'approved', 'declined', 'all'].includes(status)) throw new HttpError(400, 'Unknown status.');
  const rows = (await deps.ro.query(`SELECT r.id, r.user_id, u.email, u.display_name, u.avatar_url, r.note, r.status, r.created_at, r.decided_by, r.decided_at, r.decided_role, r.decision_note, u.role AS user_role
    FROM access_requests r JOIN users u ON u.id = r.user_id WHERE ($1 = 'all' OR r.status = $1) ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT 200`, [status])).rows;
  const [c] = (await deps.ro.query(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending FROM access_requests`)).rows;
  return { requests: rows, pending: c.pending as number, roles: ADMIN_ROLES };
}

/** Approve: the person becomes an administrator with the chosen role, through the same guarded code as every role change. Decided once. */
export async function approve(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!REQ.test(id)) throw new HttpError(400, 'Not a request id.');
  if (!isAdminRole(b.admin_role)) throw new HttpError(400, `Choose an admin role: ${ADMIN_ROLES.join(', ')}.`);
  const note = text(b.note, 300);
  // Claim it first: only the one who flips pending to approved goes on to change a role, so two administrators approving at once cannot both write.
  const claim = await deps.admin.query(`UPDATE access_requests SET status = 'approved', decided_by = $2, decided_at = now(), decided_role = $3, decision_note = $4 WHERE id = $1 AND status = 'pending' RETURNING user_id`, [id, adminId, b.admin_role, note]);
  if (!claim.rowCount) {
    const [x] = (await deps.ro.query('SELECT status FROM access_requests WHERE id = $1', [id])).rows;
    throw x ? new HttpError(409, `This request was already ${x.status}.`) : new HttpError(404, 'No such request.');
  }
  const userId = claim.rows[0].user_id as string;
  try { await setRole(deps, adminId, userId, { role: 'admin', admin_role: b.admin_role }); }
  catch (e) {
    // The role could not be given (account no longer active, ...): put the request back so it can be handled, then say why.
    await deps.admin.query(`UPDATE access_requests SET status = 'pending', decided_by = NULL, decided_at = NULL, decided_role = NULL, decision_note = NULL WHERE id = $1`, [id]);
    throw e;
  }
  return { ok: true, user_id: userId, admin_role: b.admin_role as string };
}

export async function decline(deps: AdminDeps, adminId: string, id: string, b: Record<string, unknown>) {
  if (!REQ.test(id)) throw new HttpError(400, 'Not a request id.');
  const note = text(b.note, 300);
  const r = await deps.admin.query(`UPDATE access_requests SET status = 'declined', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'pending' RETURNING user_id`, [id, adminId, note]);
  if (!r.rowCount) { const [x] = (await deps.ro.query('SELECT status FROM access_requests WHERE id = $1', [id])).rows; throw x ? new HttpError(409, `This request was already ${x.status}.`) : new HttpError(404, 'No such request.'); }
  return { ok: true };
}
