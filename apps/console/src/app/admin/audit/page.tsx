import { DataTable, FilterBar, Pager, type Column } from '../../../components/admin/DataTable';
import { ErrorState, PageHeader, StatusBadge, when } from '../../../components/admin/bits';
import { CopyId } from '../../../components/admin/client';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Security & Audit' };
type E = { id: number; admin_user_id: string; action: string; target_user_id: string | null; detail: Record<string, unknown>; at: string };

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const params = new URLSearchParams({ pageSize: '50' });
  for (const k of ['action', 'target', 'page']) if (q[k]) params.set(k, q[k]);
  const res = await load<any>(`/admin/audit?${params}`, person.id);
  const columns: Column<E>[] = [
    { key: 'at', label: 'When', render: (e) => when(e.at) },
    { key: 'admin', label: 'Admin', render: (e) => <CopyId value={e.admin_user_id} short={20} /> },
    { key: 'action', label: 'Action', render: (e) => <StatusBadge status={e.action === 'denied' ? 'failed' : 'info'}>{e.action.replace(/_/g, ' ')}</StatusBadge> },
    { key: 'target', label: 'Target', render: (e) => e.target_user_id ? <CopyId value={e.target_user_id} short={20} /> : '—' },
    { key: 'detail', label: 'Detail', render: (e) => Object.keys(e.detail ?? {}).length ? <code className="mono faint">{JSON.stringify(e.detail).slice(0, 120)}</code> : '' },
  ];
  return (
    <>
      <PageHeader title="Security & Audit" subtitle="Every administrator action, including the ones that were refused." />
      <FilterBar base="/admin/audit" query={q} fields={[{ name: 'action', label: 'Action', placeholder: 'e.g. set_role', width: 200 }, { name: 'target', label: 'Target user id', placeholder: 'usr_…', width: 260 }]} />
      {res.ok ? <><DataTable<E> columns={columns} rows={res.data.entries} base="/admin/audit" query={q} rowKey={(e) => String(e.id)} emptyTitle="No entries match" />
        <Pager base="/admin/audit" query={q} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} /></> : <ErrorState message={res.error} />}
    </>
  );
}
