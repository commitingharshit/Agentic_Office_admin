import type { ReactNode } from 'react';
import { Shell } from '../../components/admin/Shell';
import { visibleNav } from '../../components/admin/nav';
import { adminApi } from '../../lib/admin-api';
import { keycloakMode } from '../../lib/keycloak';
import { adminContext, adminMfaRequired } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: { default: 'Admin', template: '%s · Admin' } };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { person, role, permissions } = await adminContext();
  const healthy = await adminApi('/healthz', { acting: person.id }).then(() => true, () => false);
  const att = await adminApi<{ items: Array<{ id: string; level: string; title: string; href: string; count: number }> }>('/admin/attention', { acting: person.id }).catch(() => ({ items: [] }));
  return (
    <Shell alerts={att.items} nav={visibleNav(permissions)} admin={{ email: person.email, name: person.name, role }} mfaOff={keycloakMode() ? process.env.KEYCLOAK_ADMIN_OTP !== 'enforced' : !adminMfaRequired()} healthy={healthy}>
      {children}
    </Shell>
  );
}
