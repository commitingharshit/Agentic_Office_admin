'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

interface Source { n: number; source: string; heading: string; route: string | null }
interface Reply { answered: boolean; answer: string; sources: Source[]; questionId: number | null }
interface Turn { q: string; a?: Reply; error?: string; voted?: boolean }

const EXAMPLES = ['How do I create a coupon?', 'How do I disable a user?', 'Where do I see which servers are up?', 'What can the support role do?'];

/** The help assistant: a side panel that answers how-do-I questions from the documentation, with links to the pages it names. */
export function HelpPanel({ open, onClose, enabled }: { open: boolean; onClose: () => void; enabled: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) dlg.current?.showModal(); else dlg.current?.close(); }, [open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

  async function ask(text: string) {
    const question = text.trim();
    if (question.length < 3 || busy) return;
    setQ(''); setBusy(true);
    setTurns((t) => [...t, { q: question }]);
    let patch: Partial<Turn>;
    try {
      const r = await fetch('/admin/help/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
      const j = await r.json().catch(() => ({}));
      patch = r.ok ? { a: j as Reply } : { error: typeof j?.error === 'string' ? j.error : 'The help assistant is unavailable right now.' };
    } catch { patch = { error: 'Could not reach the console. Try again.' }; }
    setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, ...patch } : x)));
    setBusy(false);
  }
  async function vote(i: number, helpful: boolean) {
    const id = turns[i]?.a?.questionId;
    setTurns((t) => t.map((x, k) => (k === i ? { ...x, voted: true } : x)));
    if (id) await fetch('/admin/help/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: id, helpful }) }).catch(() => undefined);
  }

  return (
    <dialog ref={dlg} className="help-panel" onClose={onClose} aria-label="Help assistant">
      <header><b>Help</b><span className="faint">Answers come from the documentation only</span><span className="grow" /><button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close help">Close</button></header>
      <div className="help-body" aria-live="polite">
        {!enabled && <div className="notice warn">The help assistant is not switched on for this server yet. The person who runs the platform adds a provider key to turn it on.</div>}
        {enabled && !turns.length && (
          <div><p>Ask how to do something in the admin panel, or where a feature is.</p>
            <div className="help-examples">{EXAMPLES.map((e) => <button key={e} type="button" className="btn sm" onClick={() => ask(e)}>{e}</button>)}</div>
            <p className="faint">Do not paste customer details, tokens or keys. Emails and key-like text are removed before a question leaves the server.</p></div>)}
        {turns.map((t, i) => (
          <div key={i} className="help-turn">
            <p className="help-q">{t.q}</p>
            {t.error && <p className="notice warn">{t.error}</p>}
            {t.a && (<>
              <div className="help-a">{t.a.answer}</div>
              {t.a.sources.length > 0 && <div className="help-sources">{t.a.sources.map((s) => s.route
                ? <Link key={s.n} className="chip" href={s.route} onClick={onClose}>[{s.n}] {s.heading.split(' › ')[0]}</Link>
                : <span key={s.n} className="chip">[{s.n}] {s.heading.split(' › ')[0]}</span>)}</div>}
              {t.a.questionId && !t.voted && <div className="help-vote"><span className="faint">Was this helpful?</span><button type="button" className="btn ghost sm" onClick={() => vote(i, true)}>Yes</button><button type="button" className="btn ghost sm" onClick={() => vote(i, false)}>No</button></div>}
              {t.voted && <div className="faint">Thanks, noted.</div>}
            </>)}
          </div>))}
        {busy && <p className="faint">Looking it up…</p>}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void ask(q); }} className="help-form">
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={1000} placeholder="How do I…" aria-label="Your question" disabled={!enabled || busy} autoFocus />
        <button type="submit" className="btn primary sm" disabled={!enabled || busy || q.trim().length < 3}>Ask</button>
      </form>
    </dialog>
  );
}
