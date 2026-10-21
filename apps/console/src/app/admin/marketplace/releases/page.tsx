import Link from 'next/link';
import { FilterBar } from '../../../../components/admin/DataTable';
import { CursorPager, StateBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Notice, PageHeader, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { CATALOG_FILTERS, LISTING_TYPES, VERSION_STATES, listQuery } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Releases' };

export default async function Releases({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/catalog${listQuery(q, CATALOG_FILTERS)}`, person.id);
  return (
    <>
      <PageHeader title="Versions & Releases" subtitle="Most recently changed listings first. Open a version for its full release history." />
      <Notice icon="info">The API has no cross-listing release-event feed yet, so this page lists listings by last change and links to each version's own event history (claimed, approved, published, deprecated, quarantined, revoked, with who and why).</Notice>
      <FilterBar base="/admin/marketplace/releases" query={q} fields={[
        { name: 'q', label: 'Search', width: 200 }, { name: 'type', label: 'Type', type: 'select', options: [['', 'Any type'], ...LISTING_TYPES.map((t) => [t, t] as [string, string])] },
        { name: 'state', label: 'Latest state', type: 'select', options: [['', 'Any state'], ...VERSION_STATES.map((s) => [s, s.replace(/_/g, ' ')] as [string, string])] }]} />
      {res.ok ? (
        <>
          <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Latest version</th><th>State</th><th>Changed</th></tr></thead>
            <tbody>{(res.data.items as any[]).map((r) => (
              <tr key={r.id}><td><b>{r.name}</b> <span className="faint mono">{r.id}</span></td><td>{r.latestVersionId ? <Link className="mono" href={`/admin/marketplace/versions/${r.latestVersionId}`}>{r.latestVersion}</Link> : '—'}</td><td><StateBadge state={r.state} /></td><td>{ago(r.updatedAt)}</td></tr>))}
              {!res.data.items.length && <tr><td colSpan={4} className="dt-empty">No listings.</td></tr>}</tbody></table></div>
          <CursorPager base="/admin/marketplace/releases" query={q} next={res.data.nextPage} />
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
