import { NextResponse } from 'next/server';
import { adminApi, AdminApiError } from '../../lib/admin-api';
import { ASK_COOKIE, keycloakMode, unsign } from '../../lib/keycloak';
import { adminHostAllowed } from '../../lib/session';

export const dynamic = 'force-dynamic';

const cookieOf = (req: Request, name: string) => (req.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const to = (req: Request, path: string) => NextResponse.redirect(new URL(path, process.env.AUTH_BASE_URL ?? req.url), 303);

/** "Let me in". Only a person who signed in a moment ago and was turned away (the signed cookie) can ask, and only for themselves. */
export async function POST(req: Request) {
  if (!adminHostAllowed(req.headers.get('host')) || !keycloakMode()) return new NextResponse('Not found', { status: 404 });
  const who = unsign<{ id: string; email: string }>(decodeURIComponent(cookieOf(req, ASK_COOKIE) ?? ''));
  if (!who) return to(req, '/?signin=expired');
  const note = String((await req.formData().catch(() => null))?.get('note') ?? '').trim().slice(0, 300);
  try { await adminApi('/admin/access-requests', { method: 'POST', body: { user_id: who.id, note: note || undefined } }); }
  catch (e) { return to(req, `/?denied=1&ask=${e instanceof AdminApiError && e.status === 409 ? 'closed' : 'failed'}`); }
  return to(req, '/?requested=1');
}
