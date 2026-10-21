import Link from 'next/link';
import { DataTable, FilterBar, type Column } from '../../../components/admin/DataTable';
import { ErrorState, Notice, PageHeader, StatusBadge, ago, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Support' };
type T = { id: string; user_id: string; email: string; subject: string; status: string; messages: number; updated_at: string };

export default async function Support({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/tickets${q.status ? `?status=${encodeURIComponent(q.status)}` : ''}`, person.id);
  const columns: Column<T>[] = [
    { key: 'subject', label: 'Subject', render: (t) => <Link href={`/admin/support/${t.id}`}>{t.subject}</Link> },
    { key: 'user', label: 'From', render: (t) => <Link href={`/admin/users/${t.user_id}`}>{t.email}</Link> },
    { key: 'status', label: 'Status', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'messages', label: 'Messages', align: 'right', render: (t) => num(t.messages) },
    { key: 'updated', label: 'Last activity', render: (t) => ago(t.updated_at) },
  ];
  return (
    <>
      <PageHeader title="Support" subtitle="Tickets people open from the app. Nothing arrives unless they write it." />
      <Notice icon="info">Diagnostics are never collected automatically. A person can choose to describe a problem in a ticket; that text is theirs and is shown here as written.</Notice>
      <FilterBar base="/admin/support" query={q} fields={[{ name: 'status', label: 'Status', type: 'select', options: [['', 'Any'], ['open', 'Open'], ['pending', 'Waiting for the person'], ['closed', 'Closed']] }]} />
      {res.ok ? <DataTable<T> columns={columns} rows={res.data.tickets} base="/admin/support" query={q} rowKey={(t) => t.id} emptyTitle="No tickets" emptyHint="Tickets appear when someone opens one from the app." /> : <ErrorState message={res.error} />}
    </>
  );
}
