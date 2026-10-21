import { Notice, Section, StatusBadge } from './bits';
import { agentComponentRows, bundleMembers, checkByName, dryRunLine, permissionComparison, unsupportedFromChecks } from '../../lib/marketplace-agents';
import type { Check } from '../../lib/marketplace';

const STATE_TEXT = { supported: 'Supported', not_available: 'Not available yet', unknown: 'Unknown (no compiler verdict on record)' } as const;
const STATE_TONE = { supported: 'active', not_available: 'pending', unknown: 'pending' } as const;
const CHECK_TONE = (c: Check | undefined) => (!c ? 'pending' : c.skipped ? 'pending' : c.ok ? 'active' : 'failed');
const CHECK_TEXT = (c: Check | undefined) => (!c ? 'not on record' : c.skipped ? 'skipped' : c.ok ? 'passed' : 'failed');

/** Review detail for an agent version. Every value comes from the stored manifest and the recorded validation checks; text is rendered as text. */
export function AgentReview({ manifest, checks, dependencies }: { manifest: any; checks: Check[]; dependencies: Array<{ id: string; range: string }> }) {
  const rows = agentComponentRows(manifest, checks);
  const unsupported = unsupportedFromChecks(checks);
  const perms = permissionComparison(checks);
  const dry = dryRunLine(checks);
  const compiles = checkByName(checks, 'compiles');
  return (
    <>
      <Section title="Blueprint components" count={rows.length}>
        {rows.length ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Component</th><th>State</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.component}><td className="mono">{r.component}</td><td><StatusBadge status={STATE_TONE[r.state]}>{STATE_TEXT[r.state]}</StatusBadge></td></tr>)}</tbody></table></div>
        ) : <p className="hint">The manifest declares no blueprint components.</p>}
        {unsupported.length > 0 && <Notice tone="warn" icon="alert">The compiler reports these components as not available yet: {unsupported.join(', ')}. They are declared in the blueprint but do nothing when the agent runs.</Notice>}
      </Section>
      <Section title="Compiler and dry run">
        <div className="table-wrap"><table className="dt"><tbody>
          <tr><td>Compiles</td><td><StatusBadge status={CHECK_TONE(compiles)}>{CHECK_TEXT(compiles)}</StatusBadge></td><td className="muted">{compiles?.detail ?? ''}</td></tr>
          <tr><td>Dry run</td><td><StatusBadge status={dry.status === 'passed' ? 'active' : dry.status === 'failed' ? 'failed' : 'pending'}>{dry.status.replace('_', ' ')}</StatusBadge></td><td className="muted">{dry.text}</td></tr>
        </tbody></table></div>
        <p className="hint">The server keeps the dry run&apos;s outcome and step count, not the step list, so the steps themselves are not shown here.</p>
      </Section>
      <Section title="Permissions: derived by the compiler vs declared in the manifest">
        {perms.known ? (
          <>
            <div className="table-wrap"><table className="dt"><tbody>
              <tr><td>Derived from the blueprint</td><td className="mono">{perms.derived.join(', ') || 'none'}</td></tr>
              <tr><td>Declared in the manifest</td><td className="mono">{perms.declared.join(', ') || 'none'}</td></tr>
            </tbody></table></div>
            {perms.undeclared.length > 0
              ? <Notice tone="bad" icon="alert">Derived but not declared: {perms.undeclared.join(', ')}. The server should have refused this version; do not approve it.</Notice>
              : <p className="hint">Every derived capability is declared.</p>}
          </>) : <Notice tone="warn" icon="alert">The server recorded no derived-permission comparison for this version (the check failed, was skipped, or predates it). Compare the blueprint to the requested permissions by hand.</Notice>}
      </Section>
      <Section title="Dependencies" count={dependencies.length}>
        {dependencies.length ? <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Range</th></tr></thead><tbody>{dependencies.map((d) => <tr key={d.id}><td className="mono">{d.id}</td><td className="mono">{d.range}</td></tr>)}</tbody></table></div> : <p className="hint">This agent depends on no other listing.</p>}
      </Section>
    </>
  );
}

/** Review detail for a bundle version: members and pins, closure, union of permissions. */
export function BundleReview({ manifest, checks }: { manifest: any; checks: Check[] }) {
  const members = bundleMembers(manifest);
  const closure = checkByName(checks, 'closure-complete'), union = checkByName(checks, 'permissions-union'), manual = checkByName(checks, 'manual-review-required');
  const perms: any[] = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return (
    <>
      <Section title="Members" count={members.length}>
        {members.length ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Pinned to</th></tr></thead>
            <tbody>{members.map((m) => <tr key={m.id}><td className="mono">{m.id}</td><td>{m.pinned ? <span className="mono">{m.version}</span> : <StatusBadge status="failed">not pinned ({m.range})</StatusBadge>}</td></tr>)}</tbody></table></div>
        ) : <p className="hint">The manifest lists no members.</p>}
        <p className="hint">A bundle carries references only. The server resolved each member and recorded the closure and union checks below; install order is part of bundle.json and is validated, not shown here.</p>
      </Section>
      <Section title="Closure and permissions">
        <div className="table-wrap"><table className="dt"><tbody>
          <tr><td>Dependency closure complete</td><td><StatusBadge status={CHECK_TONE(closure)}>{CHECK_TEXT(closure)}</StatusBadge></td><td className="muted">{closure?.detail ?? ''}</td></tr>
          <tr><td>Declared permissions cover the union of members</td><td><StatusBadge status={CHECK_TONE(union)}>{CHECK_TEXT(union)}</StatusBadge></td><td className="muted">{union?.detail ?? ''}</td></tr>
        </tbody></table></div>
        {manual && <Notice tone="warn" icon="alert">Manual review is required: {manual.detail}</Notice>}
        <p className="hint">Declared by the bundle: {perms.length ? perms.map((p) => `${String(p.capability)}${p.scope ? ` (${String(p.scope)})` : ''}`).join(', ') : 'nothing'}.</p>
      </Section>
    </>
  );
}
