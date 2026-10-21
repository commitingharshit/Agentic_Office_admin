import { AreaChart } from '../../../components/admin/Charts';
import { MetricCard } from '../../../components/admin/MetricCard';
import { EmptyState, ErrorState, Notice, PageHeader, Section, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Product Analytics' };

export default async function Analytics({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/analytics?days=${days}`, person.id);
  if (!res.ok) return <><PageHeader title="Product Analytics" /><ErrorState message={res.error} /></>;
  const d = res.data, c = d.coverage, a = d.activation;
  const of = (n: number) => `of ${num(c.users_sharing)} sharing`;
  return (
    <>
      <PageHeader title="Product Analytics" subtitle="What people do with the agent: who gets a first result, and which modes and documents they use."
        actions={<form method="get" className="form-row"><select name="days" defaultValue={String(days)} aria-label="Date range">{[7, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}</select><button className="btn sm">Apply</button></form>} />
      <Notice icon="info">{c.users_sharing} of {c.active_users} active users share usage. {d.note}</Notice>
      {c.users_sharing === 0 ? (
        <div className="table-wrap"><EmptyState icon="analytics" title="Nobody is sharing usage yet">Sharing is off by default. When people turn it on in the app, activation and adoption appear here, always against the number of people sharing.</EmptyState></div>
      ) : (
        <>
          <div className="grid kpis">
            <MetricCard icon="users" label="People sharing" value={num(c.users_sharing)} hint={`${num(c.active_users)} active users in total`} />
            <MetricCard icon="runs" label="Ran the agent" value={num(a.ran_a_run)} hint={of(a.ran_a_run)} />
            <MetricCard icon="check" label="Got a successful result" value={num(a.had_a_success)} hint={a.ran_a_run ? `${((a.had_a_success / a.ran_a_run) * 100).toFixed(0)}% of those who ran it` : 'no runs yet'} />
          </div>
          {d.daily.length > 1 && <Section title="Runs per day"><div className="card"><div className="card-body"><AreaChart data={d.daily.map((r: any) => r.runs)} labels={d.daily.map((r: any) => r.day)} unit="runs" /></div></div></Section>}
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <Section title="Compute mode">
              <div className="table-wrap"><table className="dt"><thead><tr><th>Mode</th><th className="right">Runs</th><th className="right">People</th></tr></thead>
                <tbody>{d.by_mode.map((m: any) => <tr key={m.mode}><td>{m.mode === 'managed' ? 'Agentic Office compute' : m.mode === 'byok' ? 'Own API key' : m.mode === 'local' ? 'Local model' : 'Not stated'}</td><td className="num">{num(m.runs)}</td><td className="num">{num(m.users)}</td></tr>)}</tbody></table></div>
            </Section>
            <Section title="Document types checked">
              <div className="table-wrap"><table className="dt"><thead><tr><th>Format</th><th className="right">Runs</th><th className="right">People</th></tr></thead>
                <tbody>{d.by_format.map((m: any) => <tr key={m.format}><td>{m.format}</td><td className="num">{num(m.runs)}</td><td className="num">{num(m.users)}</td></tr>)}
                  {!d.by_format.length && <tr><td colSpan={3} className="dt-empty">No document checks shared.</td></tr>}</tbody></table></div>
            </Section>
            <Section title="Agents">
              <div className="table-wrap"><table className="dt"><thead><tr><th>Agent</th><th className="right">Runs</th></tr></thead>
                <tbody>{d.by_agent.map((m: any) => <tr key={m.agent}><td className="mono">{m.agent}</td><td className="num">{num(m.runs)}</td></tr>)}</tbody></table></div>
            </Section>
          </div>
        </>)}
    </>
  );
}
