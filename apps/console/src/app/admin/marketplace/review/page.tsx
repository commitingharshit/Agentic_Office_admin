import Link from 'next/link';
import { VersionActions, StateBadge, VerdictBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, StatusBadge, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { allowedActions, riskPreview, tierTone } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Review Queue' };

export default async function ReviewQueue({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/marketplace/submissions', person.id);
  const canReview = permissions.includes('marketplace.review');
  return (
    <>
      <PageHeader title="Review Queue" subtitle="Claim, approve, reject and publish. Approving or publishing needs a verified security scan; a type that needs manual review is approved from its review page, after you read its permission summary." />
      <Flash q={q} />
      {!canReview && <Notice tone="warn" icon="alert">Your role can read the queue but not decide on it (needs marketplace.review).</Notice>}
      {res.ok ? (
        <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Version</th><th>Risk</th><th>State</th><th>Security</th><th>Submitted</th><th>Actions</th></tr></thead>
          <tbody>{(res.data.items as any[]).map((r) => {
            const risks = riskPreview(r.highRisk, 3);
            return (
              <tr key={r.versionId}>
                <td><Link href={`/admin/marketplace/review/${encodeURIComponent(r.versionId)}`}><b>{r.name}</b></Link> <span className="faint">{r.type} · {r.publisher}</span></td>
                <td className="mono">{r.version}</td>
                <td className="wrap">{r.riskTier ? <StatusBadge status={tierTone(r.riskTier)}>{r.riskTier}</StatusBadge> : <span className="faint">—</span>} {r.manualReview && <StatusBadge status="pending">manual review</StatusBadge>}
                  {risks.shown.length > 0 && <div className="faint" style={{ maxWidth: 280 }}>{risks.shown.join('; ')}{risks.more ? `; +${risks.more} more` : ''}</div>}</td>
                <td><StateBadge state={r.state} /></td>
                <td><VerdictBadge verdict={r.scanVerdict} /> {!r.verified && r.scanVerdict !== 'pending' && <StatusBadge status="pending">not verified</StatusBadge>}</td>
                <td>{ago(r.submittedAt)}</td>
                <td className="wrap">{allowedActions(r.state, permissions).length || permissions.includes('marketplace.write') ? <VersionActions versionId={r.versionId} state={r.state} permissions={permissions} back="/admin/marketplace/review" ackRequired={r.manualReview === true} /> : <span className="faint">—</span>}</td></tr>);
          })}
            {!res.data.items.length && <tr><td colSpan={7} className="dt-empty">Nothing is waiting for review.</td></tr>}</tbody></table></div>
      ) : <ErrorState message={res.error} />}
    </>
  );
}
