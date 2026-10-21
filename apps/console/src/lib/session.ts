import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { adminApi } from './admin-api';
import { withMarketplacePermissions } from './marketplace';
import { getAuth } from './instance';
import { keycloakMode, readSession, safeNext, SESSION_COOKIE } from './keycloak';
import { cookies } from 'next/headers';

export interface Person { id: string; email: string; name?: string | null; role?: string; status?: string }

export async function currentUser(): Promise<Person | undefined> {
  if (keycloakMode()) {
    const s = readSession((await cookies()).get(SESSION_COOKIE)?.value);
    return s ? { id: s.id, email: s.email, name: s.name } : undefined;
  }
  const s = await getAuth().api.getSession({ headers: await headers() });
  return s?.user as Person | undefined;
}

/** The admin console is for the private network only: the hostname the request came in on must be one we list. Fail closed. */
export function adminHostAllowed(host: string | null | undefined, allowed = process.env.ADMIN_HOSTS): boolean {
  const list = (allowed ?? '127.0.0.1,localhost').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !!h && list.includes(h);
}

/** Admin two-factor sign-in is on unless ADMIN_REQUIRE_MFA is exactly "false" (any other value, including a typo, keeps it on). */
export function adminMfaRequired(value = process.env.ADMIN_REQUIRE_MFA): boolean {
  return (value ?? '').trim().toLowerCase() !== 'false';
}

export async function requireAdmin(next?: string): Promise<Person> {
  const h = await headers();
  // Where they were headed: the address the proxy recorded, if it is one of ours; else the overview.
  next ??= safeNext(h.get('x-ao-path'));
  if (!adminHostAllowed(h.get('host'))) {
    // Say why: the usual cause is a missing name in ADMIN_HOSTS. A form action's redirect is fetched by the server through
    // `localhost`, so `localhost` must be listed too or every successful action ends on a 404.
    console.warn(`[admin] refused host "${h.get('host') ?? ''}"; ADMIN_HOSTS is "${process.env.ADMIN_HOSTS ?? '(unset: loopback only)'}"`);
    notFound();
  }   // reached through the public hostname: it does not exist
  const u = await currentUser();
  if (keycloakMode()) {
    if (!u) redirect(`/admin/login?next=${encodeURIComponent(next)}`);
    // Keycloak signed them in; whether they are an admin NOW (and active) is the admin API's answer, asked every time.
    try { await adminApi('/admin/me', { acting: u.id }); } catch (e) { redirect((e as { status?: number }).status === 403 || (e as { status?: number }).status === 401 ? '/?denied=1' : '/?signin=failed'); }
    return { ...u, role: 'admin' };   // MFA is Keycloak's job in this mode (its OTP policy), not a second prompt here
  }
  if (!u) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  if (u.status && u.status !== 'active') redirect('/?disabled=1');
  if (u.role !== 'admin') redirect('/?denied=1');
  if (!adminMfaRequired()) return u;   // switched off on purpose for now (the console shows a banner while it is)
  const session = await getAuth().api.getSession({ headers: h });
  if (!session?.user.twoFactorEnabled || !session.session.adminMfaVerified) redirect('/mfa');
  return u;
}

/** The signed-in admin and what their role may do, from the admin API (the authority). Cached per request. */
export interface AdminContext { person: Person; role: string; permissions: string[] }
export const adminContext = cache(async (): Promise<AdminContext> => {
  const person = await requireAdmin();
  const me = await adminApi<{ role: string; permissions: string[] }>('/admin/me', { acting: person.id });
  const mp = await adminApi<{ role?: string; permissions?: string[] }>('/admin/marketplace/me', { acting: person.id }).catch(() => null);   // unreachable or not mounted: no marketplace permissions
  return { person, role: me.role ?? "unknown", permissions: withMarketplacePermissions(Array.isArray(me.permissions) ? me.permissions : [], mp) };
});
