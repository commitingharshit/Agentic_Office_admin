'use client';
import { useState } from 'react';
import { authClient } from '../lib/auth-client';
import { AuthFrame } from './AuthFrame';

export function SignInForm({ providers, next }: { providers: string[]; next: string }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email') ?? ''), password = String(f.get('password') ?? ''), name = String(f.get('name') ?? '');
    const r = mode === 'in' ? await authClient.signIn.email({ email, password }) : await authClient.signUp.email({ email, password, name: name || email.split('@')[0] });
    setBusy(false);
    if (r.error) { setError(r.error.message ?? 'That did not work.'); return; }
    if (r.data && 'twoFactorRedirect' in r.data && r.data.twoFactorRedirect) { window.location.href = '/mfa'; return; }
    // The OAuth client plugin has already resumed the app's sign-in when there is one; otherwise go where the person was headed.
    if (!window.location.search.includes('client_id')) window.location.href = next;
  }

  return (
    <AuthFrame title={mode === 'in' ? 'Sign in to Agentic Office' : 'Create your account'}>
      {error && <div className="msg err" role="alert">{error}</div>}
      <form onSubmit={submit}>
        {mode === 'up' && <label className="field"><span>Name</span><input name="name" autoComplete="name" /></label>}
        <label className="field"><span>Email</span><input name="email" type="email" autoComplete="email" required /></label>
        <label className="field"><span>Password</span><input name="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={mode === 'up' ? 10 : undefined} required /></label>
        <button className="btn primary" disabled={busy}>{busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
      </form>
      {providers.length > 0 && <p className="muted" style={{ textAlign: 'center' }}>or</p>}
      {providers.map((p) => (
        <p key={p} style={{ margin: '8px 0 0' }}><button className="btn" onClick={() => authClient.signIn.social({ provider: p as 'google' | 'microsoft' })}>Continue with {p === 'google' ? 'Google' : 'Microsoft'}</button></p>
      ))}
      <p className="muted">
        {mode === 'in' ? 'New here? ' : 'Have an account? '}
        <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>{mode === 'in' ? 'Create an account' : 'Sign in'}</a>
      </p>
    </AuthFrame>
  );
}
