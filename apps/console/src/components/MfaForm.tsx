'use client';
import { useState } from 'react';
import { AuthFrame } from './AuthFrame';

export function MfaForm({ enroll }: { enroll: boolean }) {
  const [uri, setUri] = useState('');
  const [backup, setBackup] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>, enable: boolean) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const data = new FormData(e.currentTarget);
      const r = await fetch(`/api/auth/two-factor/${enable ? 'enable' : 'verify-totp'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(enable ? { password: data.get('password') } : { code: data.get('code') }),
      });
      const body = await r.json();
      if (!r.ok) { setError(body.message ?? 'Verification failed.'); return; }
      if (enable) { setUri(body.totpURI); setBackup(body.backupCodes ?? []); }
      else window.location.href = '/admin';
    } catch { setError('Could not reach the sign-in service. Try again.'); }
    finally { setBusy(false); }
  }
  return <AuthFrame title="Administrator verification">
    {error && <div className="msg err" role="alert">{error}</div>}
    {enroll && !uri && <form onSubmit={(e) => submit(e, true)}>
      <p>Set up an authenticator app to use the admin console.</p>
      <label className="field"><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="btn primary" disabled={busy}>Set up authenticator</button>
    </form>}
    {uri && <><p>Add this account to your authenticator app:</p><p><a href={uri}>Open authenticator</a></p><code style={{ overflowWrap: 'anywhere' }}>{uri}</code>
      <p>Save these recovery codes somewhere private:</p><pre>{backup.join('\n')}</pre></>}
    {(!enroll || uri) && <form onSubmit={(e) => submit(e, false)}>
      <label className="field"><span>Authenticator code</span><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></label>
      <button className="btn primary" disabled={busy}>Verify</button>
    </form>}
  </AuthFrame>;
}
