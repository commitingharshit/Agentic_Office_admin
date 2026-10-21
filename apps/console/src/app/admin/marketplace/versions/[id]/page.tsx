import Link from 'next/link';
import { Timeline } from '../../../../../components/admin/Feed';
import { AgentReview, BundleReview } from '../../../../../components/admin/marketplace-agents';
import { StateBadge, ValidationReport, VerdictBadge, VerificationPanel, VersionActions } from '../../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, bytes, when } from '../../../../../components/admin/bits';
import { load } from '../../../../../lib/admin-api';
import { ADVANCED_TYPES, isSensitiveCapability, label } from '../../../../../lib/marketplace';
import { adminContext } from '../../../../../lib/session';
import { approveReviewed } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Version' };

export default async function VersionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const [res, ver] = await Promise.all([load<any>(`/admin/marketplace/versions/${encodeURIComponent(id)}`, person.id), load<any>(`/admin/marketplace/versions/${encodeURIComponent(id)}/verification`, person.id)]);
  if (!res.ok) return <><PageHeader title="Version" /><ErrorState message={res.error} /></>;
  const v = res.data, m = v.manifest ?? {};
  const overall = (v.scans as any[]).filter((s) => s.scanner === 'validation').pop();
  const perChecks = (v.scans as any[]).filter((s) => s.scanner !== 'validation');
  const report = overall?.findings && typeof overall.findings === 'object' && Array.isArray(overall.findings.checks) ? overall.findings : null;
  const perms: any[] = Array.isArray(m.permissions) ? m.permissions : [];
  const back = `/admin/marketplace/versions/${id}`;
  // Agents and bundles with elevated members need an acknowledged review summary; the server builds it and its hash, the page only relays both.
  const wantsSummary = (ADVANCED_TYPES as readonly string[]).includes(m.type) && ['submitted', 'in_review'].includes(v.state) && permissions.includes('marketplace.review');
  const sub = wantsSummary ? await load<any>(`/admin/marketplace/submissions/${encodeURIComponent(id)}`, person.id) : null;
  return (
    <>
      <PageHeader title={m.title ?? v.listingId} subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StateBadge state={v.state} /><VerdictBadge verdict={v.scanVerdict} /><span className="mono">{v.listingId} {v.version}</span></span>}
        actions={<VersionActions versionId={v.id} state={v.state} permissions={permissions} back={back} verification={ver.ok ? ver.data?.verification?.verdict ?? null : null} ackRequired={sub?.ok === true && sub.data.manualReview === true} />} />
      <Flash q={q} />
      <Section title="Manifest">
        <div className="card"><div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 16px' }}>
          <span className="muted">Type</span><span>{m.type ?? '—'}</span><span className="muted">Summary</span><span>{m.summary ?? '—'}</span>
          <span className="muted">License</span><span>{m.license ?? '—'}</span><span className="muted">Compatible with</span><span><code>{JSON.stringify(v.compat ?? m.compat ?? {})}</code></span>
          <span className="muted">Package</span><span>{bytes(v.size)} · <span className="mono">{String(v.sha256).slice(0, 16)}…</span></span>
          <span className="muted">Created</span><span>{when(v.createdAt)}</span><span className="muted">Published</span><span>{v.publishedAt ? when(v.publishedAt) : 'not published'}</span>
          <span className="muted">Dependencies</span><span>{(v.dependencies as any[]).length ? (v.dependencies as any[]).map((d) => `${d.id} ${d.range}`).join(', ') : 'none'}</span>
          <span className="muted">Review</span><span>{v.submission ? <>{label(v.submission.state)}{v.submission.notes ? ` — ${v.submission.notes}` : ''}</> : 'no submission record'}</span>
        </div></div>
      </Section>
      <Section title="Requested permissions" count={perms.length}>
        {perms.length ? (
          <>
            <Notice tone="warn" icon="alert">Review each request against what the package needs. Highlighted rows can write, run code, or reach the network.</Notice>
            <div className="table-wrap" style={{ marginTop: 10 }}><table className="dt"><thead><tr><th>Capability</th><th>Scope</th><th>Reason given</th></tr></thead>
              <tbody>{perms.map((p, i) => <tr key={i} style={isSensitiveCapability(String(p.capability)) ? { background: 'color-mix(in srgb, var(--warn, #b7791f) 12%, transparent)' } : undefined}>
                <td className="mono">{String(p.capability)} {isSensitiveCapability(String(p.capability)) && <StatusBadge status="past_due">sensitive</StatusBadge>}</td><td className="mono">{String(p.scope ?? '—')}</td><td>{String(p.reason ?? '—')}</td></tr>)}</tbody></table></div>
          </>) : <p className="hint">This package requests no permissions.</p>}
      </Section>
      {sub?.ok && sub.data.manualReview && (
        <Section title="Manual review summary">
          <Notice tone="warn" icon="alert">This version needs a reviewer to read the summary below and acknowledge it. The approval is refused unless the hash matches this exact version.{sub.data.highRisk?.length ? ` High risk: ${sub.data.highRisk.join('; ')}.` : ''}</Notice>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '10px 0' }}>{sub.data.summary.text}</pre>
          <form action={approveReviewed}>
            <input type="hidden" name="id" value={v.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="ack" value={sub.data.summarySha256} />
            <button className="btn primary" disabled={sub.data.summary.truncated}>I read the summary: approve</button>
            <span className="faint mono"> {String(sub.data.summarySha256).slice(0, 16)}…</span>
          </form>
        </Section>)}
      {sub && !sub.ok && <ErrorState message={sub.error} />}
      {m.type === 'agent' && <AgentReview manifest={m} checks={report?.checks ?? []} dependencies={v.dependencies} />}
      {m.type === 'bundle' && <BundleReview manifest={m} checks={report?.checks ?? []} />}
      <Section title="Security scan">
        <ValidationReport report={report} />
        {v.state === 'submitted' && !v.validation?.verified && <p className="hint">Approve and publish stay blocked until a scan is verified; “Rescan” re-runs the validators on the stored package.</p>}
        {perChecks.length > 0 && <p className="hint">{perChecks.length} per-check scan row{perChecks.length === 1 ? '' : 's'} on record; latest summary {overall ? when(overall.at) : 'none'}.</p>}
      </Section>
      <Section title="Verification">
        {ver.ok ? <VerificationPanel versionId={v.id} data={ver.data} permissions={permissions} state={v.state} back={back} summaryHash={sub?.ok && sub.data.manualReview ? sub.data.summarySha256 : undefined} /> : <ErrorState message={ver.error} />}
      </Section>
      <Section title="Release events" count={(v.events as any[]).length}>
        {(v.events as any[]).length ? <Timeline items={(v.events as any[]).map((e) => ({ at: e.at, title: <>{e.event} <span className="faint">by {e.actor ?? 'system'}</span></>, detail: e.detail?.reason ? `Reason: ${e.detail.reason}` : e.detail?.from ? `${e.detail.from} to ${e.detail.to}` : undefined, tone: ['rejected', 'quarantined', 'revoked'].includes(e.event) ? 'bad' : e.event === 'published' ? 'ok' : undefined }))} /> : <p className="hint">No release events.</p>}
      </Section>
      <p><Link className="btn" href="/admin/marketplace/catalog">Back to the catalog</Link></p>
    </>
  );
}
