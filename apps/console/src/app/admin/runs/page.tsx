import Link from 'next/link';
import { DataTable, FilterBar, Pager, type Column } from '../../../components/admin/DataTable';
import { EmptyState, ErrorState, Notice, PageHeader, StatusBadge, num, when } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agent Runs' };
type R = { run_id: string; user_id: string; email: string; agent_id: string | null; state: string; started_at: string; ended_at: string | null; tokens_in: number; tokens_out: number };

export default async function Runs({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const params = new URLSearchParams({ pageSize: '25' });
  for (const k of ['state', 'user_id', 'page']) if (q[k]) params.set(k, q[k]);
  const res = await load<any>(`/admin/runs?${params}`, person.id);
  const columns: Column<R>[] = [
    { key: 'run', label: 'Run', render: (r) => <Link href={`/admin/runs/${r.run_id}`} className="mono">{r.run_id.slice(0, 18)}</Link> },
    { key: 'user', label: 'User', render: (r) => <Link href={`/admin/users/${r.user_id}`}>{r.email}</Link> },
    { key: 'agent', label: 'Agent', render: (r) => r.agent_id ?? '—' },
    { key: 'state', label: 'State', render: (r) => <StatusBadge status={r.state} /> },
    { key: 'started', label: 'Started', render: (r) => when(r.started_at) },
    { key: 'dur', label: 'Duration', align: 'right', render: (r) => r.ended_at ? `${Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000))} s` : '—' },
    { key: 'tokens', label: 'Tokens', align: 'right', render: (r) => num(r.tokens_in + r.tokens_out) },
  ];
  return (
    <>
      <PageHeader title="Agent Runs" subtitle="What the agent did, as ids, states, timings and token counts." />
      {res.ok ? (
        <>
          <Notice icon="info">{res.data.coverage.users_with_runs} of {res.data.coverage.active_users} active users have shared run details. People share usage only if they turn it on in the app; nothing is collected by default.</Notice>
          <FilterBar base="/admin/runs" query={q} fields={[{ name: 'state', label: 'State', type: 'select', options: [['', 'Any'], ['running', 'Running'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['cancelled', 'Cancelled']] }]} />
          {res.data.total === 0 && !q.state
            ? <div className="table-wrap"><EmptyState icon="runs" title="No agent runs shared yet">Run details arrive only from people who opt in to share usage. Until the app sends them, this page stays empty.</EmptyState></div>
            : <><DataTable<R> columns={columns} rows={res.data.runs} base="/admin/runs" query={q} rowKey={(r) => r.run_id} emptyTitle="No runs match" />
              <Pager base="/admin/runs" query={q} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} /></>}
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
