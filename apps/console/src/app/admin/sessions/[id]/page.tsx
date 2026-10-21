import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyId } from '../../../../components/admin/client';
import { MetricCard } from '../../../../components/admin/MetricCard';
import { BarChart } from '../../../../components/admin/Charts';
import { ErrorState, Notice, PageHeader, Section, StatusBadge, ago, num, when } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Session' };

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/sessions/${encodeURIComponent(id)}`, person.id);
  if (!res.ok) { if (/No such/.test(res.error)) notFound(); return <><PageHeader title="Session" /><ErrorState message={res.error} /></>; }
  const { session: s, summary, types, runs, note } = res.data;
  return (
    <>
      <PageHeader title="Session" subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><CopyId value={s.id} short={40} /><span className="faint">·</span><Link href={`/admin/users/${s.user_id}`}>{s.email}</Link></span>} />
      <div className="grid kpis">
        <MetricCard label="Events" value={num(summary.events)} icon="sessions" />
        <MetricCard label="Started" value={when(summary.first_at ?? s.created_at)} />
        <MetricCard label="Last event" value={ago(summary.last_at)} hint={when(summary.last_at)} />
        <MetricCard label="Agent runs" value={num(runs.length)} icon="runs" />
      </div>
      <Notice icon="info">{note}</Notice>
      <Section title="Events by type" count={types.length}>
        {types.length ? <div className="card"><div className="card-body"><BarChart data={types.map((t: any) => t.events)} labels={types.map((t: any) => t.type)} /></div></div> : <div className="muted">No events yet.</div>}
      </Section>
      <Section title="Agent runs" count={runs.length}>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Run</th><th>Agent</th><th>State</th><th>Started</th><th className="right">Tokens</th></tr></thead>
          <tbody>{runs.map((r: any) => <tr key={r.run_id}><td><Link href={`/admin/runs/${r.run_id}`} className="mono">{r.run_id.slice(0, 18)}</Link></td><td>{r.agent_id ?? '—'}</td><td><StatusBadge status={r.state} /></td><td>{when(r.started_at)}</td><td className="num">{num(r.tokens_in + r.tokens_out)}</td></tr>)}
            {!runs.length && <tr><td colSpan={5} className="dt-empty">No runs shared for this session.</td></tr>}</tbody></table></div>
      </Section>
    </>
  );
}
