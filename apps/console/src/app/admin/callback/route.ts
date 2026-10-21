import { NextResponse } from 'next/server';
import { adminHostAllowed } from '../../../lib/session';
import { adminApi } from '../../../lib/admin-api';
import { ASK_COOKIE, finishLogin, keycloakMode, kcConfig, LOGIN_COOKIE, newSession, sign, SESSION_COOKIE, secureCookies, unsign } from '../../../lib/keycloak';

export const dynamic = 'force-dynamic';

const cookieOf = (req: Request, name: string) => (req.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const back = (req: Request, to: string, clear: boolean) => {
  const res = NextResponse.redirect(new URL(to, process.env.AUTH_BASE_URL ?? req.url), 303);
  if (clear) res.cookies.set(LOGIN_COOKIE, '', { path: '/admin', maxAge: 0 });
  return res;
};

/** Keycloak sends the browser back here with a code. State must be the one this browser started; the code is used once. */
export async function GET(req: Request) {
  if (!adminHostAllowed(req.headers.get('host'))) return new NextResponse('Not found', { status: 404 });
  if (!keycloakMode()) return back(req, '/sign-in', false);
  const url = new URL(req.url), c = kcConfig();
  const login = unsign<{ v: string; s: string; n: string; next: string }>(decodeURIComponent(cookieOf(req, LOGIN_COOKIE) ?? ''));
  if (!login || url.searchParams.get('state') !== login.s) return back(req, '/?signin=expired', true);
  if (url.searchParams.get('error')) return back(req, '/?signin=cancelled', true);
  const code = url.searchParams.get('code');
  if (!code) return back(req, '/?signin=failed', true);
  let r = await finishLogin(c, code, { verifier: login.v, nonce: login.n });
  // An administrator may have added this person's email before their first sign-in; the invite is claimed here, once, for a verified email.
  if (!r.ok && r.reason === 'denied') {
    const claimed = await adminApi<{ claimed?: boolean }>('/admin/admin-invites/claim', { method: 'POST', body: { user_id: r.who.id } }).catch(() => ({ claimed: false }));
    if (claimed.claimed) r = { ok: true, id: r.who.id, email: r.who.email, name: r.who.name, role: 'admin' };
  }
  if (!r.ok && r.reason === 'denied') {
    const res = back(req, '/?denied=1', true);
    res.cookies.set(ASK_COOKIE, sign({ ...r.who, exp: Math.floor(Date.now() / 1000) + 1800 }), { httpOnly: true, sameSite: 'lax', secure: secureCookies(c), path: '/', maxAge: 1800 });
    return res;
  }
  if (!r.ok) return back(req, r.reason === 'disabled' ? '/?disabled=1' : r.reason === 'unverified' ? '/?signin=unverified' : '/?signin=failed', true);
  const res = back(req, login.next, true);
  res.cookies.set(SESSION_COOKIE, newSession({ id: r.id, email: r.email, name: r.name }), { httpOnly: true, sameSite: 'lax', secure: secureCookies(c), path: '/', maxAge: 8 * 3600 });
  return res;
}
