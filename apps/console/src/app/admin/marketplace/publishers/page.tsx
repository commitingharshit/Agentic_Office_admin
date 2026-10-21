import { ConfirmForm } from '../../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { saveMarketplacePublisher } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Publishers' };

export default async function Publishers({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, role } = await adminContext();
  const res = await load<any>('/admin/marketplace/publishers', person.id);
  const isSuper = role === 'superadmin';
  return (
    <>
      <PageHeader title="Publishers" subtitle="Who may publish. A publisher's trust (community, verified, official) is shown on all of its listings." />
      <Flash q={q} />
      {!isSuper && <Notice icon="info">Only a superadmin can create or verify publishers. You can read the list.</Notice>}
      {isSuper && (
        <Section title="Create or update a publisher">
          <form action={saveMarketplacePublisher} className="form-row">
            <label className="field"><span>Id (lowercase, digits, dashes)</span><input name="id" required pattern="[a-z0-9][a-z0-9\-]*" placeholder="acme-tools" /></label>
            <label className="field"><span>Display name</span><input name="displayName" maxLength={120} /></label>
            <label className="field"><span>Owner user id (new publishers)</span><input name="ownerUserId" placeholder="optional" /></label>
            <label className="field"><span>Trust</span><select name="trust" defaultValue="community"><option value="community">community (not verified)</option><option value="verified">verified</option><option value="official">official</option></select></label>
            <button className="btn primary">Save publisher</button>
          </form>
          <p className="hint">Changing trust updates the trust shown on every non-private listing of that publisher.</p>
        </Section>)}
      <Section title="Publishers" count={res.ok ? res.data.items.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Id</th><th>Name</th><th>Trust</th><th className="right">Listings</th><th>Owner</th><th>Created</th>{isSuper && <th />}</tr></thead>
            <tbody>{(res.data.items as any[]).map((p) => (
              <tr key={p.id}><td className="mono">{p.id}</td><td>{p.displayName}</td><td><StatusBadge status={p.trust === 'official' ? 'admin' : p.trust === 'verified' ? 'active' : ''}>{p.trust}</StatusBadge></td><td className="num">{num(p.listings)}</td><td className="mono">{p.ownerUserId}</td><td>{ago(p.createdAt)}</td>
                {isSuper && <td className="right">{p.trust === 'community'
                  ? <ConfirmForm action={saveMarketplacePublisher} fields={{ id: p.id, trust: 'verified' }} label="Verify" title={`Verify ${p.id}?`} body="Its listings will show as verified." tone="primary" confirmLabel="Verify" />
                  : <ConfirmForm action={saveMarketplacePublisher} fields={{ id: p.id, trust: 'community' }} label="Remove verification" title={`Remove verification from ${p.id}?`} body="Its listings go back to community trust." confirmLabel="Remove verification" />}</td>}</tr>))}
              {!res.data.items.length && <tr><td colSpan={7} className="dt-empty">No publishers yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
    </>
  );
}
