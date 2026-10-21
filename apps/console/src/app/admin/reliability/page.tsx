import { AreaChart, BarChart } from '../../../components/admin/Charts';
import { MetricCard } from '../../../components/admin/MetricCard';
import { EmptyState, ErrorState, Notice, PageHeader, Section, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reliability' };
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const secs = (v: number | null) => (v === null ? '—' : v < 90 ? `${v.toFixed(1)} s` : `${(v / 60).toFixed(1)} min`);

export default async function Reliability({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const days = [7, 14, 30, 90].includes(Number(q.days)) ? Number(q.days) : 14;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/reliability?days=${days}`, person.id);
  if (!res.ok) return <><PageHeader title="Reliability" /><ErrorState message={res.error} /></>;
  const d = res.data, t = d.totals, c = d.coverage;
  return (
    <>
      <PageHeader title="Reliability" subtitle="How often the agent finishes the job, how long it takes, and where it fails."
        actions={<form method="get" className="form-row"><select name="days" defaultValue={String(days)} aria-label="Date range">{[7, 14, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}</select><button className="btn sm">Apply</button></form>} />
      <Notice icon="info">{c.users_sharing} of {c.active_users} active users share usage, and {c.users_with_runs} of them sent runs in this period. {d.note}</Notice>
      {t.runs === 0 ? (
        <div className="table-wrap"><EmptyState icon="reliability" title="No shared runs in this period">Figures appear when people who turned on “share usage” in the app run the agent. Until then nothing is shown rather than a rate of zero.</EmptyState></div>
      ) : (
        <>
          <div className="grid kpis">
            <MetricCard icon="reliability" label="Success rate" value={pct(t.success_rate)} hint={`${num(t.succeeded)} of ${num(t.finished)} finished runs`} />
            <MetricCard icon="runs" label="Runs" value={num(t.runs)} hint={`${num(t.failed)} failed · ${num(t.cancelled)} cancelled · ${num(t.running)} running`} />
            <MetricCard label="Median duration" value={secs(t.p50_s)} hint="runs that finished" />
            <MetricCard label="95th percentile" value={secs(t.p95_s)} hint="slowest 1 in 20" />
          </div>
          <Section title="Runs per day"><div className="card"><div className="card-body"><AreaChart data={d.daily.map((r: any) => r.runs)} labels={d.daily.map((r: any) => r.day)} unit="runs" /></div></div></Section>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            <Section title="Failures by category" count={d.failures.length}>
              {d.failures.length ? <div className="card"><div className="card-body"><BarChart data={d.failures.map((f: any) => f.runs)} labels={d.failures.map((f: any) => f.category.replace(/_/g, ' '))} /></div></div> : <div className="muted">No failed runs.</div>}
            </Section>
            <Section title="Client versions" count={d.versions.length}>
              <div className="table-wrap"><table className="dt"><thead><tr><th>Version</th><th className="right">Runs</th><th className="right">People</th></tr></thead>
                <tbody>{d.versions.map((v: any) => <tr key={v.version}><td className="mono">{v.version}</td><td className="num">{num(v.runs)}</td><td className="num">{num(v.users)}</td></tr>)}</tbody></table></div>
            </Section>
          </div>
          <Section title="Tools" count={d.tools.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Tool</th><th className="right">Calls</th><th className="right">Failed</th><th className="right">Failure rate</th><th className="right">Retries</th></tr></thead>
              <tbody>{d.tools.map((x: any) => <tr key={x.name}><td className="mono">{x.name}</td><td className="num">{num(x.steps)}</td><td className="num">{num(x.failed)}</td><td className="num">{pct(x.steps ? x.failed / x.steps : null)}</td><td className="num">{num(x.retries)}</td></tr>)}
                {!d.tools.length && <tr><td colSpan={5} className="dt-empty">No tool steps were shared.</td></tr>}</tbody></table></div>
          </Section>
          <Section title="Models" count={d.models.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Model</th><th className="right">Runs</th><th className="right">Failed</th><th className="right">Failure rate</th></tr></thead>
              <tbody>{d.models.map((x: any) => <tr key={x.name}><td className="mono">{x.name}</td><td className="num">{num(x.runs)}</td><td className="num">{num(x.failed)}</td><td className="num">{pct(x.runs ? x.failed / x.runs : null)}</td></tr>)}</tbody></table></div>
          </Section>
          {d.verification.length > 0 && (
            <Section title="Document checks" count={d.verification.length}>
              <div className="table-wrap"><table className="dt"><thead><tr><th>Format</th><th>Verdict</th><th className="right">Runs</th></tr></thead>
                <tbody>{d.verification.map((v: any) => <tr key={`${v.format}${v.verdict}`}><td>{v.format}</td><td>{v.verdict}</td><td className="num">{num(v.n)}</td></tr>)}</tbody></table></div>
            </Section>)}
        </>)}
    </>
  );
}
