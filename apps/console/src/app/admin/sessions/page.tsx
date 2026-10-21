import Link from 'next/link';
import { DataTable, FilterBar, Pager, type Column } from '../../../components/admin/DataTable';
import { ErrorState, Notice, PageHeader, ago, num, when } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sessions' };
type S = { id: string; user_id: string; email: string; events: number; created_at: string; updated_at: string; last_event: string | null };

export default async function Sessions({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const params = new URLSearchParams({ pageSize: '25' });
  for (const k of ['q', 'user_id', 'sort', 'dir', 'page']) if (q[k]) params.set(k, q[k]);
  const res = await load<any>(`/admin/sessions?${params}`, person.id);
  const columns: Column<S>[] = [
    { key: 'id', label: 'Session', render: (s) => <Link href={`/admin/sessions/${s.id}`} className="mono">{s.id.slice(0, 20)}</Link> },
    { key: 'user', label: 'User', render: (s) => <Link href={`/admin/users/${s.user_id}`}>{s.email}</Link> },
    { key: 'events', label: 'Events', align: 'right', render: (s) => num(s.events) },
    { key: 'created', label: 'Started', sort: 'created', render: (s) => when(s.created_at) },
    { key: 'updated', label: 'Last activity', sort: 'updated', render: (s) => ago(s.last_event ?? s.updated_at) },
  ];
  return (
    <>
      <PageHeader title="Sessions" subtitle="Work sessions synced from people's devices: when, how active, never what was said." />
      <Notice icon="info">Titles, prompts and documents are encrypted on the device. Sessions are identified by id, owner, event counts and times only.</Notice>
      <FilterBar base="/admin/sessions" query={q} fields={[{ name: 'q', label: 'Search', placeholder: 'email or session id', width: 260 }]} />
      {res.ok ? <><DataTable<S> columns={columns} rows={res.data.sessions} base="/admin/sessions" query={q} rowKey={(s) => s.id} emptyTitle="No synced sessions" emptyHint="Sessions appear once a signed-in device syncs." />
        <Pager base="/admin/sessions" query={q} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} /></> : <ErrorState message={res.error} />}
    </>
  );
}
