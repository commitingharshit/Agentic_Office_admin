import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyId } from '../../../../components/admin/client';
import { MetricCard } from '../../../../components/admin/MetricCard';
import { ErrorState, PageHeader, Section, StatusBadge, num, when } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agent run' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/runs/${encodeURIComponent(id)}`, person.id);
  if (!res.ok) { if (/No such/.test(res.error)) notFound(); return <><PageHeader title="Agent run" /><ErrorState message={res.error} /></>; }
  const { run: r, children } = res.data;
  const secs = r.ended_at ? Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000)) : null;
  return (
    <>
      <PageHeader title="Agent run" subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><StatusBadge status={r.state} /><CopyId value={r.run_id} short={40} /><span className="faint">·</span><Link href={`/admin/users/${r.user_id}`}>{r.email}</Link></span>} />
      <div className="grid kpis">
        <MetricCard label="Agent" value={r.agent_id ?? '—'} icon="runs" /><MetricCard label="Started" value={when(r.started_at)} />
        <MetricCard label="Duration" value={secs === null ? 'running' : `${secs} s`} /><MetricCard label="Tokens" value={num(r.tokens_in + r.tokens_out)} hint={`${num(r.tokens_in)} in · ${num(r.tokens_out)} out`} />
      </div>
      <Section title="Sub-runs" count={children.length}>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Run</th><th>Agent</th><th>State</th><th>Started</th><th className="right">Tokens</th></tr></thead>
          <tbody>{children.map((c: any) => <tr key={c.run_id}><td><Link href={`/admin/runs/${c.run_id}`} className="mono">{c.run_id.slice(0, 18)}</Link></td><td>{c.agent_id ?? '—'}</td><td><StatusBadge status={c.state} /></td><td>{when(c.started_at)}</td><td className="num">{num(c.tokens_in + c.tokens_out)}</td></tr>)}
            {!children.length && <tr><td colSpan={5} className="dt-empty">This run started no sub-runs.</td></tr>}</tbody></table></div>
      </Section>
    </>
  );
}
