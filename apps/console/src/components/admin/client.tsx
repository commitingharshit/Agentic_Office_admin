'use client';
import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Click to copy an id; says so. */
export function CopyId({ value, short = 14 }: { value: string; short?: number }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="copyid" title={`Copy ${value}`} onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined); }}>
      {value.length > short ? `${value.slice(0, short)}…` : value}<Icon name={done ? 'check' : 'copy'} size={12} />
    </button>
  );
}

/** A button that asks first. With `phrase`, the person must type it (for things that cannot be undone). The form posts to a server action. */
export function ConfirmForm({ action, fields, label, title, body, confirmLabel, phrase, tone = 'danger', size = 'sm' }: {
  action: (f: FormData) => void | Promise<void>; fields: Record<string, string>; label: string; title: string; body: ReactNode; confirmLabel?: string; phrase?: string; tone?: 'danger' | 'primary' | ''; size?: 'sm' | '';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const ok = !phrase || typed === phrase;
  return (
    <>
      <button type="button" className={`btn ${size} ${tone}`.trim()} onClick={() => { setTyped(''); ref.current?.showModal(); }}>{label}</button>
      <dialog ref={ref} aria-labelledby="dlg-title">
        <form action={action}>
          {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <div className="dialog-body">
            <h3 id="dlg-title">{title}</h3>
            <div className="muted">{body}</div>
            {phrase && <label className="field"><span>Type <b className="mono">{phrase}</b> to confirm</span><input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus /></label>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
            <button className={`btn ${tone === 'danger' ? 'danger' : 'primary'}`} disabled={!ok}>{confirmLabel ?? label}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
