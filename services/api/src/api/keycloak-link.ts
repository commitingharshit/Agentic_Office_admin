// A person's Keycloak identity (from oauth_accounts, provider 'keycloak') and what the console shows or mirrors there.
import type { AdminDeps } from './admin.ts';

const subjectOf = async (deps: AdminDeps, userId: string): Promise<string | undefined> =>
  (await deps.ro.query(`SELECT subject FROM oauth_accounts WHERE user_id = $1 AND provider = 'keycloak' AND purpose = 'sign_in' AND revoked_at IS NULL ORDER BY created_at LIMIT 1`, [userId])).rows[0]?.subject;

/** For the user page: is this person on Keycloak, are they enabled, do they have an authenticator, where are they signed in, what happened lately. */
export async function keycloakView(deps: AdminDeps, userId: string) {
  if (!deps.keycloak) return { configured: false as const };
  const sub = await subjectOf(deps, userId);
  if (!sub) return { configured: true as const, linked: false as const };
  try {
    const [user, sessions, events] = await Promise.all([deps.keycloak.user(sub), deps.keycloak.sessions(sub), deps.keycloak.events(sub, 30)]);
    return { configured: true as const, linked: true as const, user, sessions, events };
  } catch (e) {
    return { configured: true as const, linked: true as const, error: (e as { notFound?: boolean }).notFound ? 'Keycloak no longer has this person.' : 'Keycloak could not be reached.' };
  }
}

/** Mirror an action into Keycloak. Never throws: the answer says what happened, and the caller's own change stands either way. */
export async function mirrorKeycloak(deps: AdminDeps, userId: string, o: { enabled?: boolean; endSessions?: boolean; attributes?: Record<string, string> }) {
  if (!deps.keycloak) return { configured: false as const };
  const sub = await subjectOf(deps, userId);
  if (!sub) return { configured: true as const, linked: false as const };
  try {
    if (o.enabled !== undefined) await deps.keycloak.setEnabled(sub, o.enabled);
    if (o.attributes) await deps.keycloak.setAttributes(sub, o.attributes);
    if (o.endSessions) await deps.keycloak.logout(sub);
    return { configured: true as const, linked: true as const, ok: true as const };
  } catch (e) {
    return { configured: true as const, linked: true as const, ok: false as const, error: (e as Error).message.slice(0, 160) };
  }
}
