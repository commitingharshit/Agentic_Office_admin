import Link from 'next/link';
import { DataTable, FilterBar, type Column } from '../../../../components/admin/DataTable';
import { StateBadge, VerdictBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, StatusBadge, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { listQuery } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Submissions' };

export default async function Submissions({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/submissions${listQuery(q, { state: ['submitted', 'in_review'] })}`, person.id);
  return (
    <>
      <PageHeader title="Submissions" subtitle="Versions waiting for a decision, oldest first (up to 100). Open one to see its manifest, permissions and scan." />
      <Flash q={q} />
      <Notice icon="info">Packages that fail a required check are rejected automatically and never enter this queue; find them in the catalog with state “rejected”.</Notice>
      <FilterBar base="/admin/marketplace/submissions" query={q} fields={[{ name: 'state', label: 'State', type: 'select', options: [['', 'Submitted and in review'], ['submitted', 'submitted'], ['in_review', 'in review']] }]} />
      {res.ok ? (
        <DataTable<any> base="/admin/marketplace/submissions" query={q} rowKey={(r) => r.versionId} rows={res.data.items} emptyTitle="The queue is empty" emptyHint="Nothing is waiting for review."
          columns={[
            { key: 'name', label: 'Listing', render: (r) => <><Link href={`/admin/marketplace/versions/${r.versionId}`}><b>{r.name}</b></Link><div className="faint mono">{r.listingId}</div></> },
            { key: 'type', label: 'Type' }, { key: 'publisher', label: 'Publisher' },
            { key: 'version', label: 'Version', render: (r) => <span className="mono">{r.version}</span> },
            { key: 'state', label: 'State', render: (r) => <StateBadge state={r.state} /> },
            { key: 'scan', label: 'Security', render: (r) => <>{<VerdictBadge verdict={r.scanVerdict} />} {r.verified ? null : <StatusBadge status="pending">not verified</StatusBadge>}</> },
            { key: 'at', label: 'Submitted', render: (r) => ago(r.submittedAt) },
          ] as Column<any>[]} />
      ) : <ErrorState message={res.error} />}
    </>
  );
}
