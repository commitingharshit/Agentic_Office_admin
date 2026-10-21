import Link from 'next/link';
import { AuthFrame } from '../components/AuthFrame';
import { keycloakMode } from '../lib/keycloak';
import { cookies } from 'next/headers';
import { ASK_COOKIE, unsign } from '../lib/keycloak';
import { currentUser } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string; disabled?: string; signin?: string; requested?: string; ask?: string }> }) {
  const q = await searchParams;
  const asker = unsign<{ id: string; email: string }>(decodeURIComponent((await cookies()).get(ASK_COOKIE)?.value ?? ''));
  const user = await currentUser().catch(() => undefined);
  return (
    <AuthFrame title="Agentic Office">
      {q.denied && !q.requested && <div className="msg err">That page is for administrators.</div>}
      {q.requested && <div className="msg" role="status">Request sent. An administrator will look at it. Once they approve it, sign in again and the console will open.</div>}
      {q.ask === 'closed' && <div className="msg err">You are already an administrator, or this account is not active.</div>}
      {q.ask === 'failed' && <div className="msg err">The request could not be sent. Try again in a moment.</div>}
      {q.denied && !q.requested && asker && (
        <form action="/request-access" method="post" style={{ margin: '12px 0' }}>
          <p>You are signed in as <b>{asker.email}</b>. Ask an administrator to give you access:</p>
          <label className="field"><span>Why do you need it? (optional)</span><input name="note" maxLength={300} placeholder="e.g. I handle billing for the team" /></label>
          <button className="btn primary" style={{ marginTop: 10 }}>Request admin access</button>
        </form>)}
      {q.signin && <div className="msg err" role="alert">{({ expired: 'That sign-in took too long or was started in another window. Try again.', cancelled: 'Sign-in was cancelled.', unverified: 'An account with this email already exists. Sign in the way you did before, or verify your email address first.', failed: 'Sign-in did not complete. Try again, and tell an administrator if it keeps happening.' } as Record<string, string>)[q.signin] ?? 'Sign-in did not complete.'}</div>}
      {q.disabled && <div className="msg err">This account is disabled. Contact the administrator.</div>}
      {user ? (
        <>
          <p>Signed in as <b>{user.email}</b>. You can return to the Agentic Office app.</p>
          {user.role === 'admin' && <p><Link className="btn primary" href="/admin">Open the admin console</Link></p>}
        </>
      ) : <p><Link className={asker ? 'btn' : 'btn primary'} href={keycloakMode() ? '/admin/login' : '/sign-in'}>{asker ? 'Sign in as someone else' : 'Sign in'}</Link></p>}
    </AuthFrame>
  );
}
