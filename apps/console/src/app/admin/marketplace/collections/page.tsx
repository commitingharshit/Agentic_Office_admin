import Link from 'next/link';
import { DataTable, type Column } from '../../../../components/admin/DataTable';
import { StateBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Notice, PageHeader, Section, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agents & Bundles' };

const Table = ({ rows, base }: { rows: any[]; base: string }) => (
  <DataTable<any> base={base} query={{}} rowKey={(r) => r.id} rows={rows} emptyTitle="Nothing listed" emptyHint="No listing of this type exists yet."
    columns={[
      { key: 'name', label: 'Name', render: (r) => <><b>{r.name}</b><div className="faint mono">{r.id}</div></> },
      { key: 'publisher', label: 'Publisher' }, { key: 'visibility', label: 'Visibility' },
      { key: 'state', label: 'State', render: (r) => <StateBadge state={r.state} /> },
      { key: 'version', label: 'Version', render: (r) => r.latestVersionId ? <Link className="mono" href={`/admin/marketplace/versions/${r.latestVersionId}`}>{r.latestVersion}</Link> : '—' },
      { key: 'updated', label: 'Updated', render: (r) => ago(r.updatedAt) },
    ] as Column<any>[]} />
);

export default async function AgentsAndBundles() {
  const { person } = await adminContext();
  const [agents, bundles] = await Promise.all([load<any>('/admin/marketplace/catalog?type=agent', person.id), load<any>('/admin/marketplace/catalog?type=bundle', person.id)]);
  return (
    <>
      <PageHeader title="Agents & Bundles" subtitle="Every agent and every bundle with its latest version. Open a version to see its components, permissions and members." />
      <Notice icon="info">Curated collections do not exist yet; this page lists the two Plan 2 types straight from the catalog. Pinning a bundle to a team is under Team assignments.</Notice>
      <Section title="Agents" count={agents.ok ? agents.data.items.length : undefined}>{agents.ok ? <Table rows={agents.data.items} base="/admin/marketplace/collections" /> : <ErrorState message={agents.error} />}</Section>
      <Section title="Bundles" count={bundles.ok ? bundles.data.items.length : undefined}>{bundles.ok ? <Table rows={bundles.data.items} base="/admin/marketplace/collections" /> : <ErrorState message={bundles.error} />}</Section>
    </>
  );
}
