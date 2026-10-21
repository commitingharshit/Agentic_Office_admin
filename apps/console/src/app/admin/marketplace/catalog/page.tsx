import Link from 'next/link';
import { DataTable, FilterBar, type Column } from '../../../../components/admin/DataTable';
import { CursorPager, StateBadge, VerdictBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, PageHeader, StatusBadge, ago, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { CATALOG_FILTERS, LISTING_TYPES, VERSION_STATES, VISIBILITIES, listQuery, ratingText, verificationTone, verificationWord } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Catalog' };
const opts = (xs: readonly string[], all: string): Array<[string, string]> => [['', all], ...xs.map((x) => [x, x.replace(/_/g, ' ')] as [string, string])];

export default async function Catalog({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/catalog${listQuery(q, CATALOG_FILTERS)}`, person.id);
  return (
    <>
      <PageHeader title="Catalog" subtitle="Every listing with its latest version. The state and security outcome are the latest version's." />
      <Flash q={q} />
      <FilterBar base="/admin/marketplace/catalog" query={q} fields={[
        { name: 'q', label: 'Search', placeholder: 'name or id', width: 220 },
        { name: 'type', label: 'Type', type: 'select', options: opts(LISTING_TYPES, 'Any type') },
        { name: 'publisher', label: 'Publisher', placeholder: 'publisher id', width: 160 },
        { name: 'visibility', label: 'Visibility', type: 'select', options: opts(VISIBILITIES, 'Any visibility') },
        { name: 'state', label: 'State', type: 'select', options: opts(VERSION_STATES, 'Any state') }]} />
      {res.ok ? (
        <>
          <DataTable<any> base="/admin/marketplace/catalog" query={q} rowKey={(r) => r.id} rows={res.data.items} emptyTitle="No listings match" emptyHint="Nothing is published yet, or the filters exclude everything."
            columns={[
              { key: 'name', label: 'Name', render: (r) => <><b>{r.name}</b><div className="faint mono">{r.id}</div></> },
              { key: 'type', label: 'Type' },
              { key: 'publisher', label: 'Publisher' },
              { key: 'visibility', label: 'Visibility', render: (r) => <>{r.visibility} <StatusBadge status={r.trust === 'official' ? 'admin' : r.trust === 'verified' ? 'active' : ''}>{r.trust}</StatusBadge></> },
              { key: 'state', label: 'State', render: (r) => <StateBadge state={r.state} /> },
              { key: 'version', label: 'Version', render: (r) => r.latestVersionId ? <Link className="mono" href={`/admin/marketplace/versions/${r.latestVersionId}`}>{r.latestVersion}</Link> : '—' },
              { key: 'installs', label: 'Installs', align: 'right', render: (r) => num(r.installs) },
              { key: 'active', label: 'Active', align: 'right', render: (r) => num(r.activeInstalls) },
              { key: 'rating', label: 'Rating', render: (r) => ratingText(r.ratingAvg, r.ratingCount) },
              { key: 'updated', label: 'Updated', render: (r) => ago(r.updatedAt) },
              { key: 'scan', label: 'Security', render: (r) => <VerdictBadge verdict={r.scanVerdict} /> },
              { key: 'verification', label: 'Verification', render: (r) => <StatusBadge status={verificationTone(r.verification)}>{verificationWord(r.verification)}</StatusBadge> },
            ] as Column<any>[]} />
          <CursorPager base="/admin/marketplace/catalog" query={q} next={res.data.nextPage} />
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
