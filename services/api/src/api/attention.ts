// What needs a person's eyes, from what the database holds right now. Each item is shown only to an admin whose role
// could open the page it points at, so the list never reveals more than the pages do.
import type { AdminDeps } from './admin.ts';
import { can, type AdminRole } from './rbac.ts';

export interface AttentionItem { id: string; level: 'action' | 'warn' | 'info'; title: string; detail: string; href: string; count: number }

export async function attention(deps: AdminDeps, role: AdminRole): Promise<{ items: AttentionItem[] }> {
  const items: AttentionItem[] = [];
  const one = async (sql: string) => (await deps.ro.query(sql)).rows[0];
  if (can(role, 'payments.read')) {
    const w = await one(`SELECT count(*)::int AS n, coalesce(extract(epoch FROM now() - min(coalesce(observed_at, created_at)))::int, 0) AS age FROM payment_orders WHERE status IN ('observed', 'review')`);
    if (w.n) items.push({ id: 'payments-waiting', level: 'action', count: w.n, href: '/admin/payments?status=observed', title: `${w.n} payment${w.n === 1 ? '' : 's'} waiting for a bank check`,
      detail: `The provider says ${w.n === 1 ? 'it is' : 'they are'} paid. Nothing is activated until you confirm the bank received the money. Oldest has waited ${Math.max(1, Math.round(w.age / 60))} min.` });
    const stuck = await one(`SELECT count(*)::int AS n FROM payment_orders WHERE status IN ('created', 'pending') AND created_at < now() - interval '1 hour'`);
    if (stuck.n) items.push({ id: 'payments-stuck', level: 'warn', count: stuck.n, href: '/admin/payments?status=pending', title: `${stuck.n} checkout${stuck.n === 1 ? '' : 's'} open for over an hour`, detail: 'No payment has been reported. Reconcile to ask the provider, or leave them to expire.' });
    const bad = await one(`SELECT count(*)::int AS n FROM payment_events WHERE signature_ok = false AND received_at > now() - interval '24 hours'`);
    if (bad.n) items.push({ id: 'webhook-bad-signature', level: 'warn', count: bad.n, href: '/admin/payments', title: `${bad.n} payment notice${bad.n === 1 ? '' : 's'} with a bad signature in the last day`, detail: 'They were refused and changed nothing. A burst can mean someone is probing the endpoint, or the signing secret differs from the provider\'s.' });
  }
  if (can(role, 'support.read')) {
    const t = await one(`SELECT count(*)::int AS n FROM support_tickets WHERE status = 'open'`);
    if (t.n) items.push({ id: 'tickets-open', level: 'info', count: t.n, href: '/admin/support', title: `${t.n} open support ticket${t.n === 1 ? '' : 's'}`, detail: 'People waiting for a reply.' });
  }
  if (can(role, 'roles.write')) {
    const r = await one(`SELECT count(*)::int AS n FROM access_requests WHERE status = 'pending'`);
    if (r.n) items.push({ id: 'access-requests', level: 'action', count: r.n, href: '/admin/access', title: `${r.n} ${r.n === 1 ? 'person is' : 'people are'} asking for admin access`, detail: 'Approve with the role they need, or decline. Nobody becomes an administrator until you do.' });
  }
  if (can(role, 'users.read')) {
    const u = await one(`SELECT count(*)::int AS n FROM users WHERE created_at > now() - interval '24 hours'`);
    if (u.n) items.push({ id: 'new-people', level: 'info', count: u.n, href: '/admin/users', title: `${u.n} new ${u.n === 1 ? 'person' : 'people'} in the last day`, detail: 'Signed up through Keycloak.' });
  }
  const rank = { action: 0, warn: 1, info: 2 } as const;
  return { items: items.sort((a, b) => rank[a.level] - rank[b.level]) };
}
