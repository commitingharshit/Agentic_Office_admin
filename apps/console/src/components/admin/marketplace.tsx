import Link from 'next/link';
import { allowedActions, canRescan, label, summarizeValidation, verificationRows, verificationTone, verificationWord, withParams, type Check, type MarketAction } from '../../lib/marketplace';
import { StatusBadge, Notice } from './bits';
import { ConfirmForm } from './client';
import { ReasonForm } from './ReasonForm';
import { approveIncomplete, rescanVersion, runVerification, versionAction } from '../../app/admin/marketplace/actions';
import { IncompleteApproveForm } from './IncompleteApproveForm';

const STATE_TONE: Record<string, string> = { published: 'active', approved: 'active', submitted: 'pending', in_review: 'pending', rejected: 'failed', quarantined: 'failed', revoked: 'revoked', deprecated: 'expired' };
export const StateBadge = ({ state }: { state: string | null | undefined }) => (state ? <StatusBadge status={STATE_TONE[state] ?? state}>{label(state)}</StatusBadge> : <span className="faint">no versions</span>);
const VERDICT_TONE: Record<string, string> = { clean: 'active', pending: 'pending', blocked: 'failed' };
export const VerdictBadge = ({ verdict }: { verdict: string | null | undefined }) => (verdict ? <StatusBadge status={VERDICT_TONE[verdict] ?? verdict}>{verdict === 'pending' ? 'not verified' : verdict}</StatusBadge> : <span className="faint">—</span>);

/** "Next" by keyset cursor. The API has no previous-page cursor; the browser's Back button is the way back. */
export function CursorPager({ base, query, next }: { base: string; query: Record<string, string | undefined>; next: string | null | undefined }) {
  if (!next && !query.page) return null;
  return (
    <div className="pager">
      <span>{query.page ? 'Showing a later page.' : 'First page.'}</span>
      <span className="btns">
        {query.page ? <Link className="btn sm" href={withParams(base, query, { page: undefined })}>First page</Link> : null}
        {next ? <Link className="btn sm" href={withParams(base, query, { page: next })}>Next</Link> : <span className="btn sm" aria-disabled="true">No more</span>}
      </span>
    </div>
  );
}

export function ValidationReport({ report, title = 'Validation' }: { report: { ok?: boolean; verified?: boolean; checks?: Check[] } | null | undefined; title?: string }) {
  if (!report) return <Notice icon="info">No validation report is on record for this version.</Notice>;
  const s = summarizeValidation(report);
  return (
    <>
      <Notice tone={s.outcome === 'verified' ? 'ok' : s.outcome === 'unverified' ? 'warn' : 'bad'} icon={s.outcome === 'verified' ? 'check' : 'alert'}><b>{title}: {s.outcome}.</b> {s.headline} <span className="muted">({s.passed} passed, {s.skipped} skipped, {s.failed} failed)</span></Notice>
      <div className="table-wrap" style={{ marginTop: 10 }}><table className="dt"><thead><tr><th>Check</th><th>Result</th><th>Required</th><th>Detail</th></tr></thead>
        <tbody>{s.checks.map((c, i) => (
          <tr key={i}><td className="mono">{c.name}</td>
            <td><StatusBadge status={c.status === 'ok' ? 'active' : c.status === 'skipped' ? 'pending' : 'failed'}>{c.status}</StatusBadge></td>
            <td>{c.required ? 'yes' : 'no'}</td><td className="muted">{c.detail ?? ''}</td></tr>))}
          {!s.checks.length && <tr><td colSpan={4} className="dt-empty">The report lists no checks.</td></tr>}</tbody></table></div>
    </>
  );
}

const COPY: Record<MarketAction, { label: string; title: string; body: string; tone: 'danger' | 'primary' | ''; reason: boolean }> = {
  claim: { label: 'Claim', title: 'Claim this version for review?', body: 'It moves to in review and shows you as the reviewer.', tone: 'primary', reason: false },
  approve: { label: 'Approve', title: 'Approve this version?', body: 'Approval needs a verified security scan. A version you submitted yourself needs another admin (a superadmin can override).', tone: 'primary', reason: false },
  reject: { label: 'Reject', title: 'Reject this version?', body: 'The publisher sees the reason. A rejected version is final.', tone: 'danger', reason: true },
  publish: { label: 'Publish', title: 'Publish this version?', body: 'It becomes installable by everyone the listing is visible to.', tone: 'primary', reason: false },
  deprecate: { label: 'Deprecate', title: 'Deprecate this version?', body: 'It stays installed where it is but is no longer offered.', tone: '', reason: false },
  quarantine: { label: 'Quarantine', title: 'Quarantine this version?', body: 'It is pulled from the catalog while it is investigated.', tone: 'danger', reason: true },
  revoke: { label: 'Revoke', title: 'Revoke this version?', body: 'Revocation is final: it cannot be installed or re-enabled anywhere.', tone: 'danger', reason: true },
};

/** Only the buttons the state machine allows AND the viewer's permissions cover. The API checks both again. */
export function VersionActions({ versionId, state, permissions, back, verification = null }: { versionId: string; state: string; permissions: readonly string[]; back: string; /** the latest verdict for this artifact: an incomplete one is approved only with a typed acknowledgement (see VerificationPanel) */ verification?: string | null }) {
  const acts = allowedActions(state, permissions).filter((a) => !(verification === 'incomplete' && a === 'approve'));
  const rescan = canRescan(state, permissions);
  if (!acts.length && !rescan) return <span className="faint">No actions available{permissions.some((p) => p.startsWith('marketplace.')) ? ' in this state for your role' : ''}.</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {acts.map((a) => {
        const c = COPY[a], fields = { id: versionId, action: a, back };
        return c.reason
          ? <ReasonForm key={a} action={versionAction} fields={fields} label={c.label} title={c.title} body={c.body} tone={c.tone} />
          : <ConfirmForm key={a} action={versionAction} fields={fields} label={c.label} title={c.title} body={c.body} tone={c.tone} confirmLabel={c.label} />;
      })}
      {rescan && <ConfirmForm action={rescanVersion} fields={{ id: versionId, back }} label="Rescan" title="Rescan the stored package?" body="Runs the validators again on the stored bytes and records a fresh scan result." tone="" confirmLabel="Rescan" />}
    </span>
  );
}

/** The verification result of one version: heading, one row per stage (a word AND a glyph, never colour alone), evidence behind a native <details> (keyboard accessible, images only loaded when opened), the Run button and, for an incomplete result, the typed-acknowledgement approval. Every string from a package is rendered as text. */
export function VerificationPanel({ versionId, data, permissions, state, back, summaryHash }: { versionId: string; data: any; permissions: readonly string[]; state: string; back: string; summaryHash?: string }) {
  const v = data?.verification ?? null;
  const rows = verificationRows(v, versionId);
  const canRun = permissions.includes('marketplace.review') && ['submitted', 'in_review', 'approved'].includes(state);
  const canApprove = permissions.includes('marketplace.review') && ['submitted', 'in_review'].includes(state);
  const glyph = { Pass: '✓', Fail: '✕', Skipped: '–' } as const;
  return (
    <div id="verification">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <StatusBadge status={verificationTone(v?.verdict)}>{verificationWord(v?.verdict)}</StatusBadge>
        <span className="muted">{v ? `${v.pipeline} v${v.pipelineVersion} · ${String(v.at).slice(0, 10)} · artifact ${String(v.artifactSha256).slice(0, 12)}${v.stale ? ' · checked with an older pipeline' : ''}` : 'Not yet verified. That is not a sign that anything is wrong.'}</span>
        {canRun && <ConfirmForm action={runVerification} fields={{ id: versionId, back }} label="Run verification" title="Run verification on the stored package?" body="Runs the pipeline for this type on the stored bytes and records a new result. A heavy stage may be queued for the verifier worker." tone="" confirmLabel="Run" />}
      </div>
      {v?.verdict === 'incomplete' && <Notice tone="warn" icon="alert">Not fully verified: {rows.filter((r) => r.blocking && r.word === 'Skipped').length} required check(s) were skipped. Approving needs a written acknowledgement.</Notice>}
      {data?.job && <p className="hint">Latest job: {String(data.job.status)}{data.job.lastError ? ` (${String(data.job.lastError).slice(0, 200)})` : ''}.</p>}
      {rows.length > 0 && (
        <div className="table-wrap"><table className="dt"><thead><tr><th>Result</th><th>Check</th><th>Required</th><th>Reason and evidence</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><StatusBadge status={r.word === 'Pass' ? 'active' : r.word === 'Fail' ? 'failed' : 'pending'}><span aria-hidden="true">{glyph[r.word]} </span>{r.word}</StatusBadge></td>
              <td>{r.title} <span className="faint mono">{r.id}</span></td>
              <td>{r.required ? 'yes' : 'no'}</td>
              <td>{r.reason && <div className="muted" style={{ overflowWrap: 'anywhere' }}>{r.reason}</div>}
                {r.evidence.length > 0 && (
                  <details><summary>Evidence ({r.evidence.length})</summary>
                    {r.evidence.map((e, i) => (
                      <div key={i} style={{ marginTop: 6 }}>
                        <div className="faint">{e.kind}: {e.label}</div>
                        {e.detail && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{e.detail}</pre>}
                        {e.imagePath && <img src={e.imagePath} alt={e.label || 'verification evidence'} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />}
                      </div>))}
                  </details>)}</td></tr>))}</tbody></table></div>)}
      {v?.verdict === 'incomplete' && canApprove && <IncompleteApproveForm action={approveIncomplete} id={versionId} back={back} hash={summaryHash} />}
    </div>
  );
}
