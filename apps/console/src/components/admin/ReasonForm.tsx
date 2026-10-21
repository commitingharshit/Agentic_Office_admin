'use client';
import { useRef, useState, type ReactNode } from 'react';

/** A button that opens a dialog asking for a written reason (required) before it posts to a server action. For reject, quarantine, revoke. */
export function ReasonForm({ action, fields, label, title, body, confirmLabel, tone = 'danger' }: {
  action: (f: FormData) => void | Promise<void>; fields: Record<string, string>; label: string; title: string; body: ReactNode; confirmLabel?: string; tone?: 'danger' | 'primary' | '';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  return (
    <>
      <button type="button" className={`btn sm ${tone}`.trim()} onClick={() => { setReason(''); ref.current?.showModal(); }}>{label}</button>
      <dialog ref={ref} aria-label={title}>
        <form action={action}>
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <div className="dialog-body">
            <h3>{title}</h3>
            <div className="muted">{body}</div>
            <label className="field"><span>Reason (required, kept in the release history and audit log)</span>
              <textarea name="reason" required minLength={3} maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`} disabled={reason.trim().length < 3}>{confirmLabel ?? label}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
