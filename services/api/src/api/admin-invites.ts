// Add an administrator by email. A person already in the system is promoted now; anyone else gets an invite that is
// claimed the first time they sign in to the console with that verified email.
import type { AdminDeps } from './admin.ts';
import { setRole } from './admin.ts';
import { HttpError } from './errors.ts';
import { ADMIN_ROLES, isAdminRole } from './rbac.ts';

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}\.[^\s@<>"']{2,}$/;
const USER = /^[A-Za-z0-9_-]{1,80}$/;

export async function invite(deps: AdminDeps, adminId: string, b: Record<string, unknown>) {
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) throw new HttpError(400, 'Enter a valid email address.');
  if (!isAdminRole(b.admin_role)) throw new HttpError(400, `Choose an admin role: ${ADMIN_ROLES.join(', ')}.`);
  const [u] = (await deps.ro.query(`SELECT id, role, status FROM users WHERE lower(email) = $1 AND status <> 'deleted'`, [email])).rows;
  if (u) {
    if (u.role === 'admin') throw new HttpError(409, 'That person is already an administrator. Change their role from the table above.');
    await setRole(deps, adminId, u.id as string, { role: 'admin', admin_role: b.admin_role });
    return { status: 'granted' as const, user_id: u.id as string };
  }
  await deps.admin.query(`INSERT INTO admin_invites(email, admin_role, invited_by) VALUES ($1,$2,$3)
    ON CONFLICT (email) DO UPDATE SET admin_role = excluded.admin_role, invited_by = excluded.invited_by, created_at = now(), accepted_at = NULL, accepted_by = NULL`, [email, b.admin_role, adminId]);
  return { status: 'invited' as const, email };
}

export async function listInvites(deps: AdminDeps) {
  const rows = (await deps.ro.query(`SELECT email, admin_role, invited_by, created_at FROM admin_invites WHERE accepted_at IS NULL ORDER BY created_at DESC LIMIT 100`)).rows;
  return { invites: rows, roles: ADMIN_ROLES };
}

export async function revoke(deps: AdminDeps, b: Record<string, unknown>) {
  const email = String(b.email ?? '').trim().toLowerCase();
  const r = await deps.admin.query(`DELETE FROM admin_invites WHERE email = $1 AND accepted_at IS NULL`, [email]);
  if (!r.rowCount) throw new HttpError(404, 'No such open invite.');
  return { ok: true };
}

/** Called by the console when a signed-in person was turned away. Gives the invited role only to an active person whose email is verified. */
export async function claim(deps: AdminDeps, b: Record<string, unknown>) {
  const userId = String(b.user_id ?? '');
  if (!USER.test(userId)) throw new HttpError(400, 'Not a user id.');
  const [u] = (await deps.ro.query(`SELECT id, email, role, status, email_verified FROM users WHERE id = $1`, [userId])).rows;
  if (!u || u.status !== 'active' || !u.email || !u.email_verified || u.role === 'admin') return { claimed: false as const };
  // Claim first so two windows signing in at once use the invite once.
  const c = await deps.admin.query(`UPDATE admin_invites SET accepted_at = now(), accepted_by = $2 WHERE email = lower($1) AND accepted_at IS NULL RETURNING admin_role, invited_by`, [u.email, userId]);
  if (!c.rowCount) return { claimed: false as const };
  const { admin_role, invited_by } = c.rows[0] as { admin_role: string; invited_by: string };
  try { await setRole(deps, invited_by === userId ? 'system' : invited_by, userId, { role: 'admin', admin_role }); }
  catch (e) {
    await deps.admin.query(`UPDATE admin_invites SET accepted_at = NULL, accepted_by = NULL WHERE email = lower($1)`, [u.email]);
    throw e;
  }
  return { claimed: true as const, user_id: userId, admin_role };
}
