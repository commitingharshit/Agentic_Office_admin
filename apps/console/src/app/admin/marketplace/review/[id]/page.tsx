import Link from 'next/link';
import { AckForm } from '../../../../../components/admin/AckForm';
import { ValidationReport, VersionActions, StateBadge, VerdictBadge } from '../../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago } from '../../../../../components/admin/bits';
import { load } from '../../../../../lib/admin-api';
import { ackState, tierTone } from '../../../../../lib/marketplace';
import { adminContext } from '../../../../../lib/session';
import { approveWithAck } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Review' };

/** One submission in full: the summary the SERVER built from the stored version (nothing here is computed from the package in the browser) and the acknowledgement step. */
export default async function ReviewDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>(`/admin/marketplace/submissions/${encodeURIComponent(id)}`, person.id);
  if (!res.ok) return <><PageHeader title="Review" /><ErrorState message={res.error} /></>;
  const d = res.data, ack = ackState(d, permissions), back = `/admin/marketplace/review/${encodeURIComponent(id)}`;
  const sections = (d.summary?.sections ?? []) as Array<{ title: string; lines: string[] }>;
  return (
    <>
      <PageHeader title={d.name} subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StateBadge state={d.state} /><VerdictBadge verdict={d.scanVerdict} /><StatusBadge status={tierTone(d.riskTier)}>{d.riskTier}</StatusBadge><span className="mono">{d.listingId} {d.version}</span><span className="faint">{d.type} · {d.publisher} · submitted {ago(d.submittedAt)}{d.submittedBy ? ` by ${d.submittedBy}` : ''}</span></span>}
        actions={<VersionActions versionId={d.versionId} state={d.state} permissions={permissions} back={back} ackRequired={d.manualReview === true} />} />
      <Flash q={q} />
      {Array.isArray(d.highRisk) && d.highRisk.length > 0 && (
        <Notice tone="warn" icon="alert"><span><b>High-risk items ({d.highRisk.length}):</b> {(d.highRisk as string[]).join('; ')}.</span></Notice>)}
      {d.summary?.truncated && <Notice tone="bad" icon="alert">This summary was cut to its size limit. Treat the package as unsafe: it cannot be approved from here.</Notice>}
      {sections.map((s) => (
        <Section key={s.title} title={s.title}>
          <div className="card"><div className="card-body"><pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{s.lines.join('\n')}</pre></div></div>
        </Section>))}
      <Section title="Automated checks"><ValidationReport report={{ ok: !((d.summary?.validation ?? []) as Array<{ ok: boolean }>).some((c) => !c.ok), verified: d.verified === true, checks: d.summary?.validation ?? [] }} /></Section>
      <Section title="Acknowledgement">
        <p className="hint">Policy for {d.type}: risk tier at least <b>{d.policy?.floor?.riskTier ?? '—'}</b>{d.policy?.effective && JSON.stringify(d.policy.effective) !== JSON.stringify(d.policy.floor) ? <> (raised to <b>{d.policy.effective.riskTier}</b>)</> : null}, manual review {d.manualReview ? 'required' : 'not required'}.
          {' '}The summary hash is <code className="mono">{d.summarySha256}</code>.</p>
        {ack.offer
          ? <AckForm action={approveWithAck} id={d.versionId} hash={d.summarySha256} />
          : <Notice icon="info">{ack.reason}</Notice>}
      </Section>
      <p><Link className="btn" href="/admin/marketplace/review">Back to the queue</Link> <Link className="btn" href={`/admin/marketplace/versions/${encodeURIComponent(d.versionId)}`}>Raw manifest and events</Link></p>
    </>
  );
}
