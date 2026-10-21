import Link from 'next/link';
import { allowedActions, canRescan, label, summarizeValidation, withParams, type Check, type MarketAction } from '../../lib/marketplace';
import { StatusBadge, Notice } from './bits';
import { ConfirmForm } from './client';
import { ReasonForm } from './ReasonForm';
import { rescanVersion, versionAction } from '../../app/admin/marketplace/actions';

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
export function VersionActions({ versionId, state, permissions, back }: { versionId: string; state: string; permissions: readonly string[]; back: string }) {
  const acts = allowedActions(state, permissions);
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
