'use client';
import { useRef, useState } from 'react';

/** Halt a whole type: quarantine every published version of it. Needs the type name typed back and a written reason. */
export function HaltForm({ action, type }: { action: (f: FormData) => void | Promise<void>; type: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [confirm, setConfirm] = useState(''), [reason, setReason] = useState('');
  const ready = confirm.trim() === type && reason.trim().length >= 3;
  return (
    <>
      <button type="button" className="btn sm danger" onClick={() => { setConfirm(''); setReason(''); ref.current?.showModal(); }}>Halt {type}</button>
      <dialog ref={ref} aria-label={`Halt ${type}`}>
        <form action={action}>
          <input type="hidden" name="type" value={type} />
          <div className="dialog-body">
            <h3>Halt every published {type}?</h3>
            <div className="muted">Every published or deprecated version of type <b>{type}</b> is quarantined at once. Devices stop using them on their next status check. Submissions are not blocked.</div>
            <label className="field"><span>Type “{type}” to confirm</span><input name="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoFocus /></label>
            <label className="field"><span>Reason (required, kept in the release history and audit log)</span>
              <textarea name="reason" required minLength={3} maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button className="btn danger" disabled={!ready}>Halt {type}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
