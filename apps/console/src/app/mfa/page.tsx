import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { MfaForm } from '../../components/MfaForm';
import { getAuth } from '../../lib/instance';
import { keycloakMode } from '../../lib/keycloak';
import { adminHostAllowed } from '../../lib/session';

export const dynamic = 'force-dynamic';
export default async function MfaPage() {
  if (keycloakMode()) notFound();   // retired: the authenticator step is Keycloak's
  const h = await headers();
  if (!adminHostAllowed(h.get('host'))) notFound();
  const s = await getAuth().api.getSession({ headers: h });
  if (s && (s.user.role !== 'admin' || s.user.status !== 'active')) redirect('/?denied=1');
  // A sign-in challenge has no session until the authenticator code is verified.
  if (!s && !h.get('cookie')?.includes('better-auth.two_factor=')) redirect('/sign-in?next=%2Fadmin');
  return <MfaForm enroll={!!s && !s.user.twoFactorEnabled} />;
}
