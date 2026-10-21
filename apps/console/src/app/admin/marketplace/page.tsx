import Link from 'next/link';
import { BarChart } from '../../../components/admin/Charts';
import { MetricCard } from '../../../components/admin/MetricCard';
import { ErrorState, Flash, Notice, PageHeader, Section, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { pct } from '../../../lib/marketplace';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace' };

export default async function MarketplaceOverview({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const [an, queue, quarantined, revoked] = await Promise.all([
    load<any>('/admin/marketplace/analytics', person.id),
    load<any>('/admin/marketplace/submissions', person.id),
    load<any>('/admin/marketplace/catalog?state=quarantined&limit=100', person.id),
    load<any>('/admin/marketplace/catalog?state=revoked&limit=100', person.id),
  ]);
  const byType: Record<string, number> = an.ok ? an.data.publishedListingsByType : {};
  const types = Object.keys(byType);
  const waiting = queue.ok ? (queue.data.items as any[]) : [];
  return (
    <>
      <PageHeader title="Marketplace" subtitle="Templates and skills: what is published, what is waiting for review, and what the app reports back. Everything here comes from the marketplace API." />
      <Flash q={q} />
      {an.ok ? (
        <>
          <div className="grid kpis">
            <MetricCard icon="inbox" label="Published listings" value={num(types.reduce((n, t) => n + byType[t], 0))} hint={types.length ? types.map((t) => `${byType[t]} ${t}`).join(' · ') : 'none yet'} />
            <MetricCard icon="check" label="Waiting for review" value={queue.ok ? num(waiting.length) : '—'} hint={queue.ok ? `${waiting.filter((w) => w.state === 'submitted').length} submitted · ${waiting.filter((w) => w.state === 'in_review').length} in review` : 'queue unavailable'} />
            <MetricCard icon="device" label="Installs" value={num(an.data.installs)} hint={`${num(an.data.activeInstalls)} active now · ${num(an.data.uninstalls)} uninstalled`} />
            <MetricCard icon="alert" label="Failed installs" value={num(an.data.failedInstalls)} hint={`failure rate ${pct(an.data.failureRate)}`} />
            <MetricCard icon="reliability" label="Quarantined / revoked" value={quarantined.ok && revoked.ok ? `${(quarantined.data.items as any[]).length} / ${(revoked.data.items as any[]).length}` : '—'} hint={`${num(an.data.securityIncidents)} security events recorded`} />
          </div>
          <Section title="Published listings by type">
            {types.length ? <BarChart data={types.map((t) => byType[t])} labels={types} /> : <p className="hint">Nothing is published yet.</p>}
          </Section>
          <Section title="How much the app reports">
            <Notice icon="info"><span>Devices reporting installs: <b>{num(an.data.telemetryCoverage.devicesReporting)}</b> of <b>{num(an.data.telemetryCoverage.devicesKnown)}</b> known ({pct(an.data.telemetryCoverage.ratio)}). Counts above cover only those devices.</span></Notice>
            <p className="hint" style={{ marginTop: 8 }}><b>Not collected:</b> {(an.data.notCollected as string[]).map((n) => n.replace(/_/g, ' ')).join(', ') || 'nothing'}. These have no data source, so no figure is shown for them.</p>
          </Section>
        </>
      ) : <ErrorState message={an.error} />}
      <Section title="Next up" count={queue.ok ? waiting.length : undefined} actions={<Link className="btn sm" href="/admin/marketplace/review">Open review queue</Link>}>
        {queue.ok ? (waiting.length ? (
          <div className="table-wrap"><table className="dt"><tbody>{waiting.slice(0, 5).map((w) => (
            <tr key={w.versionId}><td><Link href={`/admin/marketplace/versions/${w.versionId}`}>{w.name}</Link> <span className="faint mono">{w.listingId} {w.version}</span></td><td>{w.type}</td><td>{w.state.replace('_', ' ')}</td></tr>))}</tbody></table></div>
        ) : <p className="hint">The review queue is empty.</p>) : <ErrorState message={queue.error} />}
      </Section>
    </>
  );
}
