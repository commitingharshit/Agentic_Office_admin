import Link from 'next/link';
import { FilterBar } from '../../../../components/admin/DataTable';
import { CursorPager } from '../../../../components/admin/marketplace';
import { ConfirmForm } from '../../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { listQuery } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';
import { deleteReview } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Reviews' };

export default async function Reviews({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>(`/admin/marketplace/reviews${listQuery(q, { listing: true, page: true })}`, person.id);
  const canModerate = permissions.includes('marketplace.moderate');
  const back = `/admin/marketplace/reviews${listQuery(q, { listing: true })}`;
  return (
    <>
      <PageHeader title="Ratings & Reviews" subtitle="Newest first. Deleting a review is permanent; the audit log keeps a hash and length of the text, never the text." />
      <Flash q={q} />
      <FilterBar base="/admin/marketplace/reviews" query={q} fields={[{ name: 'listing', label: 'Listing id', placeholder: 'publisher/name', width: 240 }]} />
      {res.ok ? (
        <>
          {res.data.note && <Notice icon="info">{res.data.note}</Notice>}
          <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Stars</th><th>Review</th><th>User</th><th>When</th><th /></tr></thead>
            <tbody>{(res.data.items as any[]).map((r) => (
              <tr key={r.id}><td><Link className="mono" href={`/admin/marketplace/reviews?listing=${encodeURIComponent(r.listingId)}`}>{r.listingId}</Link></td><td>{'★'.repeat(r.stars)}{'☆'.repeat(Math.max(0, 5 - r.stars))}</td>
                <td style={{ maxWidth: 420 }}>{r.body ?? <span className="faint">rating only</span>}</td><td><Link className="mono" href={`/admin/users/${r.userId}?tab=marketplace`}>{r.userId}</Link></td><td>{ago(r.createdAt)}</td>
                <td className="right">{canModerate ? <ConfirmForm action={deleteReview} fields={{ id: r.id, back }} label="Delete" title="Delete this review?" body="The review is removed for good and the listing's rating is recalculated. This cannot be undone." confirmLabel="Delete review" /> : null}</td></tr>))}
              {!res.data.items.length && <tr><td colSpan={6} className="dt-empty">No reviews yet.</td></tr>}</tbody></table></div>
          <CursorPager base="/admin/marketplace/reviews" query={q} next={res.data.nextPage} />
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
