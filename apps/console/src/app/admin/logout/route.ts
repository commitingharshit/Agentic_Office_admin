import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { getAuth } from '../../../lib/instance';
import { adminHostAllowed } from '../../../lib/session';
import { kcConfig, keycloakMode, SESSION_COOKIE } from '../../../lib/keycloak';

export const dynamic = 'force-dynamic';

/** End the console session, and Keycloak's with it (so the next sign-in asks again). Post only: a link or an image cannot sign anyone out. */
export async function POST(req: Request) {
  if (!adminHostAllowed(req.headers.get('host'))) return new NextResponse('Not found', { status: 404 });
  const base = (process.env.AUTH_BASE_URL ?? new URL(req.url).origin).replace(/\/+$/, '');
  if (keycloakMode()) {
    const c = kcConfig();
    const to = new URL(`${c.issuer}/protocol/openid-connect/logout`);
    to.search = new URLSearchParams({ client_id: c.clientId, post_logout_redirect_uri: `${base}/` }).toString();
    const res = NextResponse.redirect(to, 303);
    res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
    return res;
  }
  await getAuth().api.signOut({ headers: await headers() }).catch(() => undefined);
  return NextResponse.redirect(`${base}/sign-in`, 303);
}
