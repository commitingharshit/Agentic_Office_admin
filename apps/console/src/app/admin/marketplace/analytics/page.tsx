import { BarChart } from '../../../../components/admin/Charts';
import { FilterBar } from '../../../../components/admin/DataTable';
import { MetricCard } from '../../../../components/admin/MetricCard';
import { ErrorState, Notice, PageHeader, Section, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { LISTING_TYPES, listQuery, pct } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Analytics' };

export default async function MarketplaceAnalytics({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/analytics${listQuery(q, { type: LISTING_TYPES, publisher: true, from: true, to: true })}`, person.id);
  return (
    <>
      <PageHeader title="Usage Analytics" subtitle="Derived from install records and reviews the apps report. Nothing here is estimated." />
      <FilterBar base="/admin/marketplace/analytics" query={q} fields={[
        { name: 'type', label: 'Type', type: 'select', options: [['', 'Any type'], ...LISTING_TYPES.map((t) => [t, t] as [string, string])] },
        { name: 'publisher', label: 'Publisher', width: 160 }, { name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }]} />
      {res.ok ? (() => {
        const d = res.data, cats = d.popularCategories as Array<{ tag: string; listings: number; installs: number }>;
        return (
          <>
            <div className="grid kpis">
              <MetricCard icon="device" label="Installs" value={num(d.installs)} hint={`${num(d.uninstalls)} uninstalled`} />
              <MetricCard icon="check" label="Active installs" value={num(d.activeInstalls)} hint="installed and enabled now" />
              <MetricCard icon="alert" label="Failed installs" value={num(d.failedInstalls)} hint={`failure rate ${pct(d.failureRate)}`} />
              <MetricCard icon="runs" label="On the latest version" value={pct(d.updateAdoption.ratio)} hint={`${num(d.updateAdoption.onLatest)} of ${num(d.updateAdoption.installs)} tracked installs`} />
              <MetricCard icon="support" label="Average rating" value={d.averageRating == null ? 'No ratings' : d.averageRating.toFixed(2)} hint={`${num(d.ratingCount)} ratings`} />
              <MetricCard icon="reliability" label="Security events" value={num(d.securityIncidents)} hint="quarantines and revocations" />
            </div>
            <Section title="Popular categories">
              {cats.length ? <BarChart data={cats.map((c) => c.installs)} labels={cats.map((c) => c.tag)} /> : <p className="hint">No tagged listings with installs yet.</p>}
            </Section>
            <Section title="Coverage and gaps">
              <Notice icon="info"><span>Devices reporting: <b>{num(d.telemetryCoverage.devicesReporting)}</b> of <b>{num(d.telemetryCoverage.devicesKnown)}</b> known ({pct(d.telemetryCoverage.ratio)}). This figure is global, not filtered.</span></Notice>
              <p className="hint" style={{ marginTop: 8 }}><b>Not collected:</b> {(d.notCollected as string[]).map((n) => n.replace(/_/g, ' ')).join(', ')}. No numbers are shown for these.</p>
              {(d.notes as string[]).map((n) => <p key={n} className="hint">{n}</p>)}
            </Section>
          </>);
      })() : <ErrorState message={res.error} />}
    </>
  );
}
