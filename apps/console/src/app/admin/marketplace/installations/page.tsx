import Link from 'next/link';
import { DataTable, FilterBar, type Column } from '../../../../components/admin/DataTable';
import { CursorPager, VerdictBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, StatusBadge, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { listQuery } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Installations' };
const STATES = ['requested', 'permission_review', 'installed', 'configured', 'enabled', 'disabled', 'update_available', 'failed', 'uninstalled'];

export default async function Installations({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/installations${listQuery(q, { user: true, listing: true, state: true, page: true })}`, person.id);
  return (
    <>
      <PageHeader title="Installations" subtitle="What is installed where, as the apps reported it." />
      <Flash q={q} />
      <FilterBar base="/admin/marketplace/installations" query={q} fields={[
        { name: 'user', label: 'User id', placeholder: 'usr_…', width: 200 }, { name: 'listing', label: 'Listing id', placeholder: 'publisher/name', width: 220 },
        { name: 'state', label: 'State', type: 'select', options: [['', 'Any state'], ...STATES.map((s) => [s, s.replace(/_/g, ' ')] as [string, string])] }]} />
      {res.ok ? (
        <>
          {res.data.note && <Notice icon="info">{res.data.note}</Notice>}
          <DataTable<any> base="/admin/marketplace/installations" query={q} rowKey={(r) => r.id} rows={res.data.items} emptyTitle="No installations" emptyHint="Nothing matches, or no device has reported an install yet."
            columns={[
              { key: 'listing', label: 'Listing', render: (r) => <span className="mono">{r.listingId}</span> },
              { key: 'version', label: 'Version', render: (r) => r.version ?? '—' },
              { key: 'state', label: 'State', render: (r) => <StatusBadge status={['installed', 'enabled', 'configured'].includes(r.state) ? 'active' : r.state === 'failed' ? 'failed' : ''}>{String(r.state).replace(/_/g, ' ')}</StatusBadge> },
              { key: 'enabled', label: 'Enabled', render: (r) => (r.enabled ? 'yes' : 'no') },
              { key: 'scan', label: 'Scan', render: (r) => <VerdictBadge verdict={r.scanVerdict} /> },
              { key: 'user', label: 'User', render: (r) => <Link href={`/admin/users/${r.userId}?tab=marketplace`} className="mono">{r.userId}</Link> },
              { key: 'device', label: 'Device', render: (r) => <span className="mono">{r.deviceId ?? '—'}</span> },
              { key: 'scope', label: 'Scope', render: (r) => r.scope ?? '—' },
              { key: 'err', label: 'Last error', render: (r) => r.lastError ?? '' },
              { key: 'at', label: 'Updated', render: (r) => ago(r.updatedAt) },
            ] as Column<any>[]} />
          <CursorPager base="/admin/marketplace/installations" query={q} next={res.data.nextPage} />
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
