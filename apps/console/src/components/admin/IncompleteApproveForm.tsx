'use client';
import { useState } from 'react';

/** Approving a version whose verification is incomplete: the person types why. The API stores the sentence in admin_audit. A manual-review type also carries its summary hash. */
export function IncompleteApproveForm({ action, id, back, hash }: { action: (f: FormData) => void | Promise<void>; id: string; back: string; hash?: string }) {
  const [text, setText] = useState('');
  const [reviewed, setReviewed] = useState(!hash);
  const ok = text.trim().length >= 20 && reviewed;
  return (
    <form action={action} className="card" style={{ marginTop: 12 }}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />
      {hash && <input type="hidden" name="ack" value={hash} />}
      <div className="card-body" style={{ display: 'grid', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>Some required checks did not run, so this version is <b>not fully verified</b>. To approve it anyway, say why. Your sentence is recorded in the audit log with your name.</p>
        {hash && <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><input type="checkbox" name="reviewed" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} style={{ marginTop: 4 }} /><span><b>I reviewed the permission summary</b> (hash <code className="mono">{hash.slice(0, 16)}…</code>).</span></label>}
        <label className="field"><span>Acknowledgement (at least 20 characters)</span>
          <textarea name="ack_incomplete" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} required /></label>
        <div><button className="btn primary" disabled={!ok}>Approve with acknowledgement</button></div>
      </div>
    </form>
  );
}
