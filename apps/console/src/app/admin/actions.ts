'use server';
// Every admin action: check who is asking (again, on the server), call the admin API as them, and come back to the page
// with the outcome in the address so a refresh does not repeat it. Forms never carry an identity; the session does.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { adminApi, AdminApiError } from '../../lib/admin-api';
import { requireAdmin } from '../../lib/session';

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (to: string, key: 'msg' | 'err', text: string): never => redirect(`${to}${to.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`);

/** What to add to a confirmation when Keycloak was also asked to act: nothing if it is not in use, a plain warning if it could not be reached. */
const kcNote = (r: { keycloak?: { linked?: boolean; ok?: boolean } } | undefined): string =>
  r?.keycloak?.linked && r.keycloak.ok === false ? ' Keycloak could not be updated; the account is still handled here, so try again from the Keycloak section.' : r?.keycloak?.linked && r.keycloak.ok ? ' Keycloak was updated too.' : '';

async function act(back: string, ok: string | (() => string), fn: (acting: string) => Promise<unknown>): Promise<never> {
  const admin = await requireAdmin(back);
  try { await fn(admin.id); } catch (e) { return done(back, 'err', e instanceof AdminApiError ? e.message : 'That did not work.'); }
  revalidatePath('/admin', 'layout');
  return done(back, 'msg', typeof ok === 'function' ? ok() : ok);
}

export async function grantCredits(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}`;
  await act(back, 'Credits recorded.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/credits`, {
    acting, method: 'POST',
    body: { kind: field(f, 'kind') || 'grant', pool: field(f, 'pool') || 'paid', amount: Number(field(f, 'amount')), reason: field(f, 'reason'), valid_days: field(f, 'valid_days') ? Number(field(f, 'valid_days')) : undefined },
  }));
}
export async function setPlan(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}`;
  await act(back, 'Plan changed.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/plan`, { acting, method: 'POST', body: { plan_id: field(f, 'plan_id') } }));
}
export async function setRole(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}`;
  await act(back, 'Role changed.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/role`, { acting, method: 'POST', body: { role: field(f, 'role') } }));
}
export async function setStatus(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}`, to = field(f, 'to') === 'disable' ? 'disable' : 'enable';
  const base = to === 'disable' ? 'Account disabled.' : 'Account enabled.';
  let note = '';
  await act(back, () => base + note, async (acting) => { note = kcNote(await adminApi(`/admin/users/${encodeURIComponent(id)}/${to}`, { acting, method: 'POST' })); });
}
export async function signOutEverywhere(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}`;
  let note = '';
  await act(back, () => `Signed out of every device.${note}`, async (acting) => { note = kcNote(await adminApi(`/admin/users/${encodeURIComponent(id)}/sign-out`, { acting, method: 'POST' })); });
}
export async function createCoupon(f: FormData) {
  const num = (k: string) => (field(f, k) ? Number(field(f, k)) : undefined);
  await act('/admin/coupons', 'Coupon created.', (acting) => adminApi('/admin/coupons', {
    acting, method: 'POST',
    body: { code: field(f, 'code') || undefined, amount: num('amount'), pool: field(f, 'pool') || 'promo', max_redemptions: num('max_redemptions'), grant_valid_days: num('grant_valid_days'),
            plan_id: field(f, 'plan_id') || undefined, expires_at: field(f, 'expires_at') || undefined, note: field(f, 'note') || undefined },
  }));
}
export async function toggleCoupon(f: FormData) {
  const code = field(f, 'code'), to = field(f, 'to') === 'disable' ? 'disable' : 'enable';
  await act('/admin/coupons', `Coupon ${to}d.`, (acting) => adminApi(`/admin/coupons/${encodeURIComponent(code)}/${to}`, { acting, method: 'POST' }));
}

export async function revokeDevice(f: FormData) {
  const id = field(f, 'id'), token = field(f, 'token'), back = `/admin/users/${id}?tab=auth`;
  await act(back, 'Device signed out.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/devices/${encodeURIComponent(token)}/revoke`, { acting, method: 'POST' }));
}
export async function revokeBrowserSessions(f: FormData) {
  const id = field(f, 'id'), back = `/admin/users/${id}?tab=auth`;
  await act(back, 'Browser sessions ended.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/browser-sessions/revoke`, { acting, method: 'POST', body: field(f, 'session') ? { session_id: field(f, 'session') } : {} }));
}
export async function setAdminRole(f: FormData) {
  const id = field(f, 'id'), back = field(f, 'back') || `/admin/users/${id}`;
  await act(back, 'Admin role changed.', (acting) => adminApi(`/admin/users/${encodeURIComponent(id)}/admin-role`, { acting, method: 'POST', body: { admin_role: field(f, 'admin_role') } }));
}
/** Plan fields from the form: price is typed in dollars (or whole units) and sent as cents; an empty price means "no price set". */
function planBody(f: FormData, withId: boolean) {
  const priceText = field(f, 'price');
  const body: Record<string, unknown> = {
    name: field(f, 'name'), description: field(f, 'description'),
    price_cents: priceText === '' ? null : Math.round(Number(priceText) * 100),
    currency: field(f, 'currency') || 'inr', billing_interval: field(f, 'billing_interval') || null,
    monthly_credits: Number(field(f, 'monthly_credits') || 0), managed_inference: field(f, 'managed_inference') === 'on',
    top_up_eligible: field(f, 'top_up_eligible') === 'on',
    // Blank means "leave as it is" on a field the plan already has; the API refuses out-of-range values.
    ...(field(f, 'max_concurrent_runs') ? { max_concurrent_runs: Number(field(f, 'max_concurrent_runs')) } : {}),
    ...(field(f, 'max_job_seconds') ? { max_job_seconds: Number(field(f, 'max_job_seconds')) } : {}),
    ...(field(f, 'requests_per_minute') ? { requests_per_minute: Number(field(f, 'requests_per_minute')) } : {}),
    allowed_models: field(f, 'allowed_models') ? field(f, 'allowed_models').split(',').map((m) => m.trim()).filter(Boolean) : null,
    ...(field(f, 'sort_order') ? { sort_order: Number(field(f, 'sort_order')) } : {}),
  };
  if (!withId) body.active = field(f, 'active') === 'on';
  else body.id = field(f, 'id');
  return body;
}
export async function createPlan(f: FormData) {
  await act('/admin/billing', 'Plan created. It stays off until it has a price and you switch it on.', (acting) => adminApi('/admin/plans', { acting, method: 'POST', body: planBody(f, true) }));
}
export async function updatePlan(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/billing', 'Plan updated.', (acting) => adminApi(`/admin/plans/${encodeURIComponent(id)}`, { acting, method: 'POST', body: planBody(f, false) }));
}
export async function saveFlag(f: FormData) {
  const plans = field(f, 'plan_ids').split(',').map((p) => p.trim()).filter(Boolean);
  await act('/admin/flags', 'Flag saved.', (acting) => adminApi('/admin/flags', { acting, method: 'POST', body: { key: field(f, 'key'), description: field(f, 'description'), enabled: field(f, 'enabled') === 'on' || field(f, 'enabled') === 'true', rollout_pct: Number(field(f, 'rollout_pct') || 100), plan_ids: plans } }));
}
export async function deleteFlag(f: FormData) {
  const key = field(f, 'key');
  await act('/admin/flags', 'Flag deleted.', (acting) => adminApi(`/admin/flags/${encodeURIComponent(key)}`, { acting, method: 'DELETE' }));
}
export async function createAnnouncement(f: FormData) {
  const plans = field(f, 'plan_ids').split(',').map((p) => p.trim()).filter(Boolean);
  await act('/admin/communications', 'Announcement published.', (acting) => adminApi('/admin/announcements', { acting, method: 'POST', body: { title: field(f, 'title'), body: field(f, 'body'), level: field(f, 'level'), plan_ids: plans, ...(field(f, 'ends_at') ? { ends_at: field(f, 'ends_at') } : {}) } }));
}
export async function setAnnouncement(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/communications', field(f, 'active') === 'true' ? 'Announcement switched on.' : 'Announcement switched off.', (acting) => adminApi(`/admin/announcements/${encodeURIComponent(id)}`, { acting, method: 'POST', body: { active: field(f, 'active') === 'true' } }));
}
export async function replyTicket(f: FormData) {
  const id = field(f, 'id');
  await act(`/admin/support/${id}`, 'Reply sent.', (acting) => adminApi(`/admin/tickets/${encodeURIComponent(id)}/reply`, { acting, method: 'POST', body: { body: field(f, 'body') } }));
}
export async function setTicketStatus(f: FormData) {
  const id = field(f, 'id');
  await act(`/admin/support/${id}`, 'Ticket updated.', (acting) => adminApi(`/admin/tickets/${encodeURIComponent(id)}/status`, { acting, method: 'POST', body: { status: field(f, 'status') } }));
}

export async function emailAnnouncement(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/communications', 'Email sent. Per-person results are recorded.', async (acting) => {
    const r = await adminApi<{ sent: number; failed: number }>(`/admin/announcements/${encodeURIComponent(id)}/email`, { acting, method: 'POST', body: {} });
    if (r.failed) throw new AdminApiError(502, `${r.sent} sent, ${r.failed} failed. The failures are recorded; run it again to retry them.`);
  });
}

export async function keycloakSignOut(f: FormData) {
  const id = field(f, 'id');
  await act(`/admin/users/${id}?tab=auth`, 'Keycloak sessions ended.', async (acting) => {
    const r = await adminApi<{ keycloak?: { ok?: boolean; linked?: boolean } }>(`/admin/users/${encodeURIComponent(id)}/sign-out`, { acting, method: 'POST' });
    if (r.keycloak?.linked && r.keycloak.ok === false) throw new AdminApiError(502, 'Keycloak could not be reached. Nothing was changed there.');
  });
}

// ── payments: the deliberate steps. The API re-checks the role, the amount and the order's state; these only carry the form.
const orderBack = (id: string) => `/admin/payments/${id}`;
export async function reconcileOrder(f: FormData) {
  const id = field(f, 'id');
  await act(orderBack(id), 'Asked the payment provider. The order shows what it said.', (acting) => adminApi(`/admin/payments/${encodeURIComponent(id)}/reconcile`, { acting, method: 'POST' }));
}
export async function settleOrder(f: FormData) {
  const id = field(f, 'id');
  let note = '';
  await act(orderBack(id), () => `Payment settled and the plan is active.${note}`, async (acting) => { note = kcNote(await adminApi(`/admin/payments/${encodeURIComponent(id)}/settle`, { acting, method: 'POST', body: { amount_received: field(f, 'amount_received'), reference: field(f, 'reference') || undefined, reason: field(f, 'reason') } })); });
}
export async function rejectOrder(f: FormData) {
  const id = field(f, 'id');
  await act(orderBack(id), 'Order rejected. Nothing was activated.', (acting) => adminApi(`/admin/payments/${encodeURIComponent(id)}/reject`, { acting, method: 'POST', body: { reason: field(f, 'reason') } }));
}
export async function refundOrder(f: FormData) {
  const id = field(f, 'id');
  await act(orderBack(id), 'Order refunded and the plan taken back.', (acting) => adminApi(`/admin/payments/${encodeURIComponent(id)}/refund`, { acting, method: 'POST', body: { reason: field(f, 'reason') } }));
}

export async function approveAccess(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/access', 'Approved. They are an administrator now; they sign in again to open the console.', (acting) => adminApi(`/admin/access-requests/${encodeURIComponent(id)}/approve`, { acting, method: 'POST', body: { admin_role: field(f, 'admin_role') } }));
}
export async function declineAccess(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/access', 'Declined. Nothing changed for them.', (acting) => adminApi(`/admin/access-requests/${encodeURIComponent(id)}/decline`, { acting, method: 'POST', body: { note: field(f, 'note') || undefined } }));
}

export async function addAdmin(f: FormData) {
  const email = field(f, 'email');
  await act('/admin/settings', () => `Added. ${email} becomes an administrator the first time they sign in with that email, or right now if they already have an account.`,
    (acting) => adminApi('/admin/admin-invites', { acting, method: 'POST', body: { email, admin_role: field(f, 'admin_role') } }));
}
export async function revokeAdminInvite(f: FormData) {
  const email = field(f, 'email');
  await act('/admin/settings', 'Invite removed.', (acting) => adminApi('/admin/admin-invites/revoke', { acting, method: 'POST', body: { email } }));
}

/** Credits typed in by hand from the Compute & Credits page: the person is found by their exact email, then the same guarded credit call as the user page. */
export async function grantCreditsByEmail(f: FormData) {
  const email = field(f, 'email').toLowerCase(), back = '/admin/compute';
  await act(back, () => `Recorded for ${email}.`, async (acting) => {
    const found = await adminApi<{ users: Array<{ id: string; email: string | null }> }>(`/admin/users?${new URLSearchParams({ q: email })}`, { acting });
    const u = found.users.find((x) => (x.email ?? '').toLowerCase() === email);
    if (!u) throw new AdminApiError(404, 'No one has that email. They need to sign in once first.');
    await adminApi(`/admin/users/${encodeURIComponent(u.id)}/credits`, {
      acting, method: 'POST',
      body: { kind: field(f, 'kind') || 'grant', pool: field(f, 'pool') || 'paid', amount: Number(field(f, 'amount')), reason: field(f, 'reason'), valid_days: field(f, 'valid_days') ? Number(field(f, 'valid_days')) : undefined },
    });
  });
}
