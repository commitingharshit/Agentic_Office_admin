import { notFound } from 'next/navigation';
import { SignInForm } from '../../components/SignInForm';
import { keycloakMode } from '../../lib/keycloak';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (keycloakMode()) notFound();   // retired: Keycloak is the sign-in
  const { next } = await searchParams;
  const providers = [process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'google' : '', process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET ? 'microsoft' : ''].filter(Boolean);
  // Only same-site paths: a sign-in link must not be an open redirect.
  const safeNext = next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : '/';
  return <SignInForm providers={providers} next={safeNext} />;
}
