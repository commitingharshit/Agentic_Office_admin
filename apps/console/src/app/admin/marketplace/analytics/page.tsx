import { BarChart } from '../../../../components/admin/Charts';
import { FilterBar } from '../../../../components/admin/DataTable';
import { MetricCard } from '../../../../components/admin/MetricCard';
import { ErrorState, Notice, PageHeader, Section, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { LISTING_TYPES, listQuery, pct, typeRows } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Analytics' };

export default async function MarketplaceAnalytics({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const [res, byType] = await Promise.all([
    load<any>(`/admin/marketplace/analytics${listQuery(q, { type: LISTING_TYPES, publisher: true, from: true, to: true })}`, person.id),
    load<any>(`/admin/marketplace/analytics/advanced${listQuery(q, { from: true, to: true })}`, person.id),
  ]);
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
            <Section title="By type">
              {byType.ok ? (() => {
                const rows = typeRows(byType.data);
                return (
                  <>
                    <div className="table-wrap"><table className="dt"><thead><tr><th>Type</th><th className="right">Published</th><th className="right">Installs</th><th className="right">Failed</th><th className="right">Failure rate</th><th className="right">Active</th><th className="right">Awaiting config</th><th className="right">Uninstalled</th><th className="right">Quarantined</th><th className="right">Revoked</th></tr></thead>
                      <tbody>{rows.map((r) => <tr key={r.type}><td className="mono">{r.type}</td><td className="right">{num(r.publishedListings)}</td><td className="right">{num(r.installs)}</td><td className="right">{num(r.failedInstalls)}</td><td className="right">{pct(r.failureRate)}</td><td className="right">{num(r.activeInstalls)}</td><td className="right">{num(r.awaitingConfiguration)} <span className="faint">({pct(r.awaitingConfigurationRate)})</span></td><td className="right">{num(r.uninstalls)}</td><td className="right">{num(r.quarantines)}</td><td className="right">{num(r.revokes)}</td></tr>)}
                        {!rows.length && <tr><td colSpan={10} className="dt-empty">No per-type data.</td></tr>}</tbody></table></div>
                    {rows.some((r) => r.failedReasons.length) && (
                      <>
                        <p className="hint" style={{ marginTop: 10 }}><b>Why installs failed</b> (device-reported text with hosts, urls, emails, paths and ids removed):</p>
                        <ul>{rows.filter((r) => r.failedReasons.length).map((r) => <li key={r.type}><span className="mono">{r.type}</span>: {r.failedReasons.map((x) => `${x.reason} (${num(x.count)})`).join('; ')}</li>)}</ul>
                      </>)}
                    {(byType.data.notes as string[] | undefined)?.map((n) => <p key={n} className="hint">{n}</p>)}
                  </>);
              })() : <ErrorState message={byType.error} />}
            </Section>
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
