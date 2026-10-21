import Link from 'next/link';
import { HaltForm } from '../../../../components/admin/HaltForm';
import { StateBadge } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { ADVANCED_TYPES, tierTone } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';
import { haltTypeAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Advanced Types' };

const Rows = ({ items, empty }: { items: any[]; empty: string }) => (
  <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Type</th><th>Version</th><th>State</th><th>Risk</th><th>Live installs</th><th>Open reports</th><th>Why</th></tr></thead>
    <tbody>{items.map((r) => (
      <tr key={r.versionId}><td><b>{r.name}</b><div className="faint mono">{r.listingId}</div></td><td className="mono">{r.type}</td>
        <td><Link className="mono" href={`/admin/marketplace/versions/${encodeURIComponent(r.versionId)}`}>{r.version}</Link></td><td><StateBadge state={r.state} /></td>
        <td>{r.riskTier ? <StatusBadge status={tierTone(r.riskTier)}>{r.riskTier}</StatusBadge> : '—'}</td><td className="right">{num(r.liveInstalls)}</td><td className="right">{num(r.openReports)}</td>
        <td style={{ maxWidth: 320 }}>{r.reason ?? <span className="faint">—</span>}{r.by ? <div className="faint">by {r.by} {ago(r.at)}</div> : null}</td></tr>))}
      {!items.length && <tr><td colSpan={8} className="dt-empty">{empty}</td></tr>}</tbody></table></div>
);

/** Security view for the types that run something or reach outside the app: pulled versions, executable versions still live, and the per-type halt. */
export default async function AdvancedSecurity({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/marketplace/security/advanced', person.id);
  const canHalt = permissions.includes('marketplace.moderate');
  return (
    <>
      <PageHeader title="Advanced Types" subtitle="Hooks, bridges, connectors, routines, memory, workflows, agents and bundles: what was pulled, what is live at the highest risk tier, and a per-type emergency stop." />
      <Flash q={q} />
      {res.ok ? (
        <>
          <Section title="Quarantined" count={res.data.quarantined.length}><Rows items={res.data.quarantined} empty="No advanced-type version is quarantined." /></Section>
          <Section title="Revoked" count={res.data.revoked.length}><Rows items={res.data.revoked} empty="No advanced-type version is revoked." /></Section>
          <Section title="Live at the executable tier" count={res.data.highTierPublished.length}><Rows items={res.data.highTierPublished} empty="No published version is at the executable tier." /></Section>
          <p className="hint">{res.data.note}</p>
          <Section title="Halt a type">
            {canHalt ? <Notice tone="warn" icon="alert">Halting quarantines every published or deprecated version of the type at once. Devices pick it up on their next status check.</Notice> : <Notice icon="info">Halting needs marketplace.moderate; your role can read this page only.</Notice>}
            <div className="table-wrap" style={{ marginTop: 10 }}><table className="dt"><thead><tr><th>Type</th><th>Quarantined</th><th>Revoked</th><th>Live executable</th>{canHalt && <th />}</tr></thead>
              <tbody>{ADVANCED_TYPES.map((t) => {
                const n = (state: string) => (res.data.counts as any[]).filter((c) => c.type === t && c.state === state).reduce((a, c) => a + c.n, 0);
                return <tr key={t}><td className="mono">{t}</td><td className="right">{num(n('quarantined'))}</td><td className="right">{num(n('revoked'))}</td><td className="right">{num(n('published') + n('deprecated'))}</td>{canHalt && <td className="right"><HaltForm action={haltTypeAction} type={t} /></td>}</tr>;
              })}</tbody></table></div>
          </Section>
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
