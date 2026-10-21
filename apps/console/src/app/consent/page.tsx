// Required by the OAuth provider's configuration. The desktop app is first-party and skips consent, so a person only
// lands here if some other client is ever registered; there is no such client, so say so rather than approve anything.
import { notFound } from 'next/navigation';
import { AuthFrame } from '../../components/AuthFrame';
import { keycloakMode } from '../../lib/keycloak';

export const dynamic = 'force-dynamic';   // decided per request: it does not exist once Keycloak is on
export default function ConsentPage() {
  if (keycloakMode()) notFound();
  return <AuthFrame title="Nothing to approve"><p className="muted">Agentic Office does not ask you to approve other apps.</p></AuthFrame>;
}
