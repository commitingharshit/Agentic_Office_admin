import { NextResponse } from 'next/server';
import { adminHostAllowed } from '../../../lib/session';
import { authorizeUrl, keycloakMode, kcConfig, LOGIN_COOKIE, newLogin, readSession, safeNext, secureCookies, SESSION_COOKIE, sign } from '../../../lib/keycloak';

export const dynamic = 'force-dynamic';

/** Start the admin sign-in at Keycloak. Only on the private hostnames; only when Keycloak is the sign-in. */
export async function GET(req: Request) {
  if (!adminHostAllowed(req.headers.get('host'))) return new NextResponse('Not found', { status: 404 });
  if (!keycloakMode()) return NextResponse.redirect(new URL('/sign-in?next=%2Fadmin', req.url), 303);
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  // Already signed in (a valid console session): go where they were headed instead of sending them through Keycloak again. The page still asks the API who they are.
  const have = (req.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (readSession(have)) return NextResponse.redirect(new URL(next, process.env.AUTH_BASE_URL ?? req.url), 303);
  const c = kcConfig(), l = newLogin(next);
  const res = NextResponse.redirect(authorizeUrl(c, l), 303);
  res.cookies.set(LOGIN_COOKIE, sign({ v: l.verifier, s: l.state, n: l.nonce, next: l.next, exp: Math.floor(Date.now() / 1000) + 600 }), { httpOnly: true, sameSite: 'lax', secure: secureCookies(c), path: '/admin', maxAge: 600 });
  return res;
}
