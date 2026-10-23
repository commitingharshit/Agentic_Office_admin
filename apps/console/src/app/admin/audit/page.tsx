import Link from 'next/link';
import { DataTable, FilterBar, Pager, type Column } from '../../../components/admin/DataTable';
import { ErrorState, Notice, PageHeader, StatusBadge, when } from '../../../components/admin/bits';
import { CopyId } from '../../../components/admin/client';
import { load } from '../../../lib/admin-api';
import { ENTITY_LABEL, entityHref, trailHref } from '../../../lib/entities';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Security & Audit' };
type E = {
  id: number; admin_user_id: string; admin_email: string | null; admin_name: string | null; action: string;
  target_user_id: string | null; target_email: string | null; target_type: string | null; target_id: string | null;
  detail: Record<string, unknown>; at: string;
};

const FILTERS = ['action', 'target', 'targetType', 'targetId', 'admin', 'from', 'to', 'q', 'page'];

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  if (!permissions.includes('audit.read')) {
    return (<><PageHeader title="Security & Audit" /><Notice tone="warn" icon="alert">Your role cannot read the audit log. Ask a superadmin if you need to.</Notice></>);
  }
  const params = new URLSearchParams({ pageSize: '50' });
  for (const k of FILTERS) if (q[k]) params.set(k, q[k]);
  const res = await load<any>(`/admin/audit?${params}`, person.id);
  const columns: Column<E>[] = [
    { key: 'at', label: 'When', render: (e) => when(e.at) },
    { key: 'admin', label: 'Administrator', render: (e) => e.admin_user_id === 'system'
        ? <span className="faint">system</span>
        : <Link href={`/admin/users/${encodeURIComponent(e.admin_user_id)}`} title={e.admin_user_id}>{e.admin_email ?? e.admin_user_id.slice(0, 20)}</Link> },
    { key: 'action', label: 'Action', render: (e) => <StatusBadge status={e.action === 'denied' ? 'failed' : 'info'}>{e.action.replace(/_/g, ' ')}</StatusBadge> },
    { key: 'target', label: 'Subject', render: (e) => {
        if (!e.target_type || !e.target_id) return '—';
        const href = entityHref(e.target_type, e.target_id);
        const label = e.target_type === 'user' && e.target_email ? e.target_email : e.target_id.length > 22 ? `${e.target_id.slice(0, 20)}…` : e.target_id;
        return <span><span className="faint">{ENTITY_LABEL[e.target_type] ?? e.target_type} </span>{href ? <Link href={href} title={e.target_id}>{label}</Link> : label}{' '}<Link href={trailHref(e.target_type, e.target_id)} className="faint" title="Everything that happened to this">trail</Link></span>;
      } },
    { key: 'detail', label: 'Detail', render: (e) => Object.keys(e.detail ?? {}).length
        ? <details><summary className="mono faint">{JSON.stringify(e.detail).slice(0, 80)}</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(e.detail, null, 2)}</pre><CopyId value={String(e.id)} short={12} /></details>
        : '' },
  ];
  const actions: string[] = res.ok ? res.data.actions ?? [] : [];
  return (
    <>
      <PageHeader title="Security & Audit" subtitle="Every administrator action, including the ones that were refused. Open a subject to see its page, or its trail to see everything that happened to it." />
      <FilterBar base="/admin/audit" query={q} fields={[
        { name: 'action', label: 'Action', type: 'select', options: [['', 'Any action'], ...actions.map((a): [string, string] => [a, a.replace(/_/g, ' ')])] },
        { name: 'targetType', label: 'Subject', type: 'select', options: [['', 'Anything'], ...Object.entries(ENTITY_LABEL).map(([k, v]): [string, string] => [k, v])] },
        { name: 'targetId', label: 'Subject id', placeholder: 'usr_…, an order id, a campaign id', width: 240 },
        { name: 'admin', label: 'Administrator id', placeholder: 'usr_…', width: 200 },
        { name: 'from', label: 'From', type: 'date' },
        { name: 'to', label: 'To', type: 'date' },
        { name: 'q', label: 'Contains', placeholder: 'text in the detail', width: 200 },
      ]} />
      {res.ok ? <><DataTable<E> columns={columns} rows={res.data.entries} base="/admin/audit" query={q} rowKey={(e) => String(e.id)} emptyTitle="No entries match" />
        <Pager base="/admin/audit" query={q} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} /></> : <ErrorState message={res.error} />}
    </>
  );
}
