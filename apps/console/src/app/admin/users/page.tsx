import { CopyId } from '../../../components/admin/client';
import { DataTable, FilterBar, Pager, type Column } from '../../../components/admin/DataTable';
import { ErrorState, PageHeader, Person, StatusBadge, ago, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Users' };
type U = { id: string; email: string | null; display_name: string | null; role: string; status: string; providers: string | null; created_at: string; last_active_at: string | null; devices: number; sessions: number; plan_id: string | null; promo: number; paid: number };

export default async function Users({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const params = new URLSearchParams();
  for (const k of ['q', 'status', 'role', 'plan', 'provider', 'from', 'to', 'sort', 'dir', 'page']) if (q[k]) params.set(k, q[k]);
  params.set('pageSize', '25');
  const [res, plans] = await Promise.all([load<any>(`/admin/users?${params}`, person.id), load<any>('/admin/plans', person.id)]);
  const columns: Column<U>[] = [
    { key: 'person', label: 'User', sort: 'email', render: (u) => <Person id={u.id} email={u.email} name={u.display_name} href={`/admin/users/${u.id}`} /> },
    { key: 'id', label: 'ID', render: (u) => <CopyId value={u.id} /> },
    { key: 'providers', label: 'Sign-in', render: (u) => u.providers ? u.providers.split(',').map((p) => <span key={p} className="badge" style={{ marginRight: 4 }}>{p}</span>) : <span className="faint">email</span> },
    { key: 'plan', label: 'Plan', render: (u) => <StatusBadge status={u.plan_id ?? 'free'} /> },
    { key: 'role', label: 'Role', render: (u) => u.role === 'admin' ? <StatusBadge status="admin" /> : <span className="muted">user</span> },
    { key: 'status', label: 'Status', render: (u) => <StatusBadge status={u.status} /> },
    { key: 'created', label: 'Joined', sort: 'created', render: (u) => <span title={new Date(u.created_at).toLocaleString()}>{new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span> },
    { key: 'active', label: 'Last active', sort: 'active', render: (u) => ago(u.last_active_at) },
    { key: 'devices', label: 'Devices', sort: 'devices', align: 'right', render: (u) => num(u.devices) },
    { key: 'credits', label: 'Credits', align: 'right', render: (u) => num(u.promo + u.paid) },
  ];
  return (
    <>
      <PageHeader title="Users" subtitle="Everyone who has an Agentic Office account. Open a person for their sign-ins, devices, sessions, usage and history."
        actions={<a className="btn sm" href={`/admin/export/users?${params}`}>Export CSV</a>} />
      <FilterBar base="/admin/users" query={q} fields={[
        { name: 'q', label: 'Search', placeholder: 'email, name or id', width: 240 },
        { name: 'status', label: 'Status', type: 'select', options: [['', 'Any'], ['active', 'Active'], ['disabled', 'Disabled'], ['deleted', 'Deleted']] },
        { name: 'role', label: 'Role', type: 'select', options: [['', 'Any'], ['user', 'User'], ['admin', 'Admin']] },
        { name: 'plan', label: 'Plan', type: 'select', options: [['', 'Any'], ...(plans.ok ? (plans.data.plans as any[]).map((p) => [p.id, p.name] as [string, string]) : [])] },
        { name: 'provider', label: 'Sign-in', type: 'select', options: [['', 'Any'], ['google', 'Google'], ['microsoft', 'Microsoft'], ['github', 'GitHub']] },
        { name: 'from', label: 'Joined from', type: 'date' }, { name: 'to', label: 'to', type: 'date' },
      ]} />
      {res.ok ? (
        <>
          <DataTable<U> columns={columns} rows={res.data.users} base="/admin/users" query={q} rowKey={(u) => u.id} emptyTitle="No users match" emptyHint="Try a different search or clear the filters." />
          <Pager base="/admin/users" query={q} page={res.data.page} pageSize={res.data.pageSize} total={res.data.total} />
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
