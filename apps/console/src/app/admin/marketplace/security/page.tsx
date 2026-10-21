import Link from 'next/link';
import { FilterBar } from '../../../../components/admin/DataTable';
import { CursorPager, StateBadge } from '../../../../components/admin/marketplace';
import { ConfirmForm } from '../../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { burstRows, listQuery, verificationTone, verificationWord } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';
import { resolveReport } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Security Reports' };
const RSTATES = ['open', 'triaged', 'actioned', 'dismissed'];

export default async function Security({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const [reports, quarantined, revoked, vissues, bursts] = await Promise.all([
    load<any>(`/admin/marketplace/reports${listQuery(q, { state: RSTATES, page: true })}`, person.id),
    load<any>('/admin/marketplace/catalog?state=quarantined&limit=100', person.id),
    load<any>('/admin/marketplace/catalog?state=revoked&limit=100', person.id),
    load<any>('/admin/marketplace/security/verification', person.id),
    load<any>('/admin/marketplace/security/suspicious-install-bursts', person.id),
  ]);
  const burstList = bursts.ok ? burstRows(bursts.data) : [];
  const canModerate = permissions.includes('marketplace.moderate');
  const pulled = [...(quarantined.ok ? quarantined.data.items : []), ...(revoked.ok ? revoked.data.items : [])] as any[];
  return (
    <>
      <PageHeader title="Security Reports" subtitle="Reports people filed against listings, and the versions that were pulled." />
      <Flash q={q} />
      <Section title="Quarantined and revoked" count={quarantined.ok && revoked.ok ? pulled.length : undefined}>
        {quarantined.ok && revoked.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Latest version</th><th>State</th><th>Publisher</th><th>Updated</th></tr></thead>
            <tbody>{pulled.map((r) => <tr key={r.id}><td><b>{r.name}</b> <span className="faint mono">{r.id}</span></td><td>{r.latestVersionId ? <Link className="mono" href={`/admin/marketplace/versions/${r.latestVersionId}`}>{r.latestVersion}</Link> : '—'}</td><td><StateBadge state={r.state} /></td><td>{r.publisher}</td><td>{ago(r.updatedAt)}</td></tr>)}
              {!pulled.length && <tr><td colSpan={5} className="dt-empty">No listing currently has a quarantined or revoked latest version.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={(!quarantined.ok ? quarantined.error : !revoked.ok ? revoked.error : '')} />}
        <p className="hint">This lists listings whose latest version is quarantined or revoked. Older versions pulled while a newer one exists appear in that listing's version history.</p>
      </Section>
      <Section title="Failed or incomplete verification" count={vissues.ok ? vissues.data.items.length : undefined}>
        {vissues.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Version</th><th>State</th><th>Verification</th><th>Checks that stopped it</th><th>Checked</th></tr></thead>
            <tbody>{(vissues.data.items as any[]).map((r) => <tr key={r.versionId}><td className="mono">{r.listingId} <span className="faint">{r.type}</span></td><td><Link className="mono" href={`/admin/marketplace/versions/${r.versionId}#verification`}>{r.version}</Link></td><td><StateBadge state={r.state} /></td>
              <td><StatusBadge status={verificationTone(r.verdict)}>{verificationWord(r.verdict)}</StatusBadge></td>
              <td>{(r.problemStages as any[]).map((s) => `${s.id} (${s.status}${s.reason ? `: ${s.reason}` : ''})`).join('; ') || '—'}</td><td>{ago(r.at)}</td></tr>)}
              {!vissues.data.items.length && <tr><td colSpan={6} className="dt-empty">No submitted, approved or published version has a failed or incomplete verification.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={vissues.error} />}
      </Section>
      <Section title="Suspicious install bursts" count={bursts.ok ? burstList.length : undefined}>
        {bursts.ok ? (
          <>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th className="right">Installs</th><th className="right">New accounts</th><th>First</th><th>Last</th></tr></thead>
              <tbody>{burstList.map((b) => <tr key={b.listingId}><td className="mono">{b.listingId}</td><td className="right">{num(b.installs)}</td><td className="right">{num(b.accounts)}</td><td>{ago(b.firstAt)}</td><td>{ago(b.lastAt)}</td></tr>)}
                {!burstList.length && <tr><td colSpan={5} className="dt-empty">No listing had a burst of installs from brand-new accounts in the last {num(bursts.data.window?.hours)} hours.</td></tr>}</tbody></table></div>
            {typeof bursts.data.note === 'string' && <p className="hint">{bursts.data.note}</p>}
          </>) : <ErrorState message={bursts.error} />}
      </Section>
      <Section title="Reports" count={reports.ok ? reports.data.items.length : undefined}>
        <FilterBar base="/admin/marketplace/security" query={q} fields={[{ name: 'state', label: 'State', type: 'select', options: [['', 'Any state'], ...RSTATES.map((s) => [s, s] as [string, string])] }]} />
        {reports.ok ? (
          <>
            {reports.data.note && <Notice icon="info">{reports.data.note}</Notice>}
            <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Reason</th><th>Details</th><th>State</th><th>Filed</th>{canModerate && <th />}</tr></thead>
              <tbody>{(reports.data.items as any[]).map((r) => (
                <tr key={r.id}><td className="mono">{r.listingId}{r.versionId && <div className="faint"><Link href={`/admin/marketplace/versions/${r.versionId}`}>{r.versionId}</Link></div>}</td><td>{r.reason}</td><td style={{ maxWidth: 360 }}>{r.details ?? ''}</td>
                  <td><StatusBadge status={r.state === 'open' ? 'open' : r.state === 'actioned' ? 'active' : ''}>{r.state}</StatusBadge></td><td>{ago(r.createdAt)}</td>
                  {canModerate && <td className="right">{r.state === 'open' && <ConfirmForm action={resolveReport} fields={{ id: r.id, state: 'triaged' }} label="Triage" title="Mark as triaged?" body="You have looked at it; it stays open for follow-up." tone="" confirmLabel="Triage" />}{(r.state === 'open' || r.state === 'triaged') && <> <ConfirmForm action={resolveReport} fields={{ id: r.id, state: 'actioned' }} label="Actioned" title="Mark as actioned?" body="Action was taken (for example the version was quarantined). This closes the report." tone="primary" confirmLabel="Mark actioned" /> <ConfirmForm action={resolveReport} fields={{ id: r.id, state: 'dismissed' }} label="Dismiss" title="Dismiss this report?" body="No action is needed. This closes the report." confirmLabel="Dismiss" /></>}</td>}</tr>))}
                {!reports.data.items.length && <tr><td colSpan={6} className="dt-empty">No reports.</td></tr>}</tbody></table></div>
            <CursorPager base="/admin/marketplace/security" query={q} next={reports.data.nextPage} />
          </>) : <ErrorState message={reports.error} />}
      </Section>
    </>
  );
}
