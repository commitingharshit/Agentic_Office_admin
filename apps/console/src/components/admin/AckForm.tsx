'use client';
import { useState } from 'react';

/** The approval step for a version that needs manual review: the button stays disabled until the box is ticked, and the hash posted is the one rendered on this page. */
export function AckForm({ action, id, hash }: { action: (f: FormData) => void | Promise<void>; id: string; hash: string }) {
  const [ok, setOk] = useState(false);
  return (
    <form action={action} className="card" style={{ marginTop: 12 }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="ack" value={hash} />
      <div className="card-body" style={{ display: 'grid', gap: 10 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" name="reviewed" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ marginTop: 4 }} />
          <span><b>I reviewed this summary.</b> I understand that approving acknowledges exactly this version, with summary hash <code className="mono">{hash.slice(0, 16)}…</code>. If the version changes, the server will refuse this approval.</span>
        </label>
        <div><button className="btn primary" disabled={!ok}>Approve this version</button></div>
      </div>
    </form>
  );
}
