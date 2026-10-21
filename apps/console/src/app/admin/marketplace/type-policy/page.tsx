import { ErrorState, Flash, Notice, PageHeader, StatusBadge, when } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { RISK_TIERS, TRUST_LEVELS } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';
import { saveTypePolicy } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Type Policy' };

export default async function TypePolicy({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/marketplace/type-policy', person.id);
  const canEdit = permissions.includes('marketplace.policy');
  return (
    <>
      <PageHeader title="Type Policy" subtitle="How strictly each type is reviewed. The built-in floor can be raised here, never lowered." />
      <Flash q={q} />
      {!canEdit && <Notice icon="info">Only a superadmin can change a policy; you can read it.</Notice>}
      {res.ok ? (
        <div className="table-wrap"><table className="dt"><thead><tr><th>Type</th><th>Floor</th><th>Now</th><th>Supported</th>{canEdit && <th>Raise</th>}</tr></thead>
          <tbody>{(res.data.items as any[]).map((r) => (
            <tr key={r.type}>
              <td className="mono">{r.type}</td>
              <td>{r.floor.riskTier} · {r.floor.manualReview ? 'manual review' : 'no manual review'} · publisher {r.floor.minPublisherTrust}+</td>
              <td>{r.riskTier} · {r.manualReview ? 'manual review' : 'no manual review'} · publisher {r.minPublisherTrust}+ {r.raised ? <StatusBadge status="pending">raised</StatusBadge> : null}{r.updatedAt ? <div className="faint">{r.updatedBy} {when(r.updatedAt)}</div> : null}</td>
              <td>{r.supported ? 'yes' : <span className="faint">not yet</span>}</td>
              {canEdit && <td>
                <form action={saveTypePolicy} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="hidden" name="type" value={r.type} />
                  <select name="riskTier" defaultValue={r.riskTier} aria-label={`Risk tier of ${r.type}`}>{RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                  <label><input type="checkbox" name="manualReview" defaultChecked={r.manualReview} /> manual review</label>
                  <select name="minPublisherTrust" defaultValue={r.minPublisherTrust} aria-label={`Minimum publisher trust of ${r.type}`}>{TRUST_LEVELS.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                  <input name="reason" required minLength={3} maxLength={1000} placeholder="Reason (required)" aria-label={`Reason for changing ${r.type}`} />
                  <button className="btn sm primary">Save</button>
                </form></td>}
            </tr>))}</tbody></table></div>
      ) : <ErrorState message={res.error} />}
      {res.ok && <p className="hint">{res.data.note}</p>}
    </>
  );
}
