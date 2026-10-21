// Pure helpers behind the agent / bundle admin pages and the policy + team-assignment pages (Plan 2 Task 14).
// `node --import tsx --test test/marketplace-plan2.test.ts`
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LISTING_TYPES, PUBLISHABLE_TYPES, withMarketplacePermissions } from '../src/lib/marketplace.ts';
import {
  ASSIGNMENT_MODES, PACKAGE_HELP, agentComponentRows, assignmentRows, bundleMembers, checkByName, dryRunLine, parsePolicyForm, permissionComparison,
  policyToForm, unsupportedFromChecks,
} from '../src/lib/marketplace-agents.ts';

const checks = [
  { name: 'compiles', ok: true, detail: 'hermes-profile-distribution 1' },
  { name: 'dry-run', ok: true, detail: '4 step(s)' },
  { name: 'permissions-subset', ok: true, detail: 'derived: fs.workspace.read, network; declared: fs.workspace.read' },
  { name: 'unsupported-reported', ok: true, detail: 'not available yet: hookBindings, schedulingPolicy' },
];

test('publish wizard offers agent and bundle and still refuses types it has no pipeline for', () => {
  assert.ok(PUBLISHABLE_TYPES.includes('agent') && PUBLISHABLE_TYPES.includes('bundle'));
  assert.ok(LISTING_TYPES.includes('bundle'));
  assert.ok(!PUBLISHABLE_TYPES.includes('surface'));
  assert.match(PACKAGE_HELP.agent, /blueprint\.json/); assert.match(PACKAGE_HELP.agent, /SOUL\.md/);
  assert.match(PACKAGE_HELP.bundle, /bundle\.json/);
});

test('checkByName finds a check and never invents one', () => {
  assert.equal(checkByName(checks, 'compiles')?.ok, true);
  assert.equal(checkByName(checks, 'nope'), undefined);
  assert.equal(checkByName(undefined, 'compiles'), undefined);
});

test('unsupportedFromChecks parses the server sentence; "none" and a missing check are an empty list, not a guess', () => {
  assert.deepEqual(unsupportedFromChecks(checks), ['hookBindings', 'schedulingPolicy']);
  assert.deepEqual(unsupportedFromChecks([{ name: 'unsupported-reported', ok: true, detail: 'none' }]), []);
  assert.deepEqual(unsupportedFromChecks([]), []);
  assert.deepEqual(unsupportedFromChecks([{ name: 'unsupported-reported', ok: true, detail: 'not available yet: <script>x</script>' }]), ['<script>x</script>'], 'text is passed through as text; React escapes it');
});

test('agentComponentRows: one row per declared component, marked not available yet only when the server said so', () => {
  const rows = agentComponentRows({ payload: { components: ['identity', 'skillReferences', 'hookBindings', 'schedulingPolicy'] } }, checks);
  assert.deepEqual(rows.map((r) => [r.component, r.state]), [['identity', 'supported'], ['skillReferences', 'supported'], ['hookBindings', 'not_available'], ['schedulingPolicy', 'not_available']]);
  assert.deepEqual(agentComponentRows({}, checks), []);
  assert.deepEqual(agentComponentRows({ payload: { components: 'x' } }, checks), []);
  // with no compiler verdict at all, nothing is promised as supported
  const unknown = agentComponentRows({ payload: { components: ['identity'] } }, []);
  assert.equal(unknown[0].state, 'unknown');
});

test('permissionComparison: derived vs declared, and what is derived but not declared', () => {
  assert.deepEqual(permissionComparison(checks), { derived: ['fs.workspace.read', 'network'], declared: ['fs.workspace.read'], undeclared: ['network'], known: true });
  assert.deepEqual(permissionComparison([{ name: 'permissions-subset', ok: true, detail: 'derived: none; declared: none' }]), { derived: [], declared: [], undeclared: [], known: true });
  assert.equal(permissionComparison([]).known, false);
  assert.equal(permissionComparison([{ name: 'permissions-subset', ok: false, detail: 'tool.invoke is required but not declared' }]).known, false);
});

test('dryRunLine never reports a skipped or missing dry run as passed', () => {
  assert.deepEqual(dryRunLine(checks), { status: 'passed', text: '4 step(s)' });
  assert.equal(dryRunLine([{ name: 'dry-run', ok: true, skipped: true, detail: 'skipped: no compiler bridge configured' }]).status, 'skipped');
  assert.equal(dryRunLine([{ name: 'dry-run', ok: false, detail: 'step 2 failed' }]).status, 'failed');
  assert.equal(dryRunLine([]).status, 'not_run');
});

test('bundleMembers: the members are the manifest dependencies, pinned with "=", in the order the manifest lists them', () => {
  const rows = bundleMembers({ dependencies: [{ id: 'acme/a', range: '=1.0.0' }, { id: 'acme/b', range: '^2.0.0' }] });
  assert.deepEqual(rows, [{ id: 'acme/a', range: '=1.0.0', pinned: true, version: '1.0.0' }, { id: 'acme/b', range: '^2.0.0', pinned: false, version: null }]);
  assert.deepEqual(bundleMembers({}), []);
});

test('assignmentRows marks pulled pins blocked and keeps the mode as the server sent it', () => {
  const rows = assignmentRows({ items: [
    { id: 'a1', teamId: 't1', listingId: 'acme/x', title: 'X', type: 'agent', pinnedVersion: '1.0.0', pinSha256: 'a'.repeat(64), mode: 'required', versionState: 'published', blocked: false },
    { id: 'a2', teamId: 't1', listingId: 'acme/y', title: 'Y', type: 'bundle', pinnedVersion: '2.0.0', pinSha256: 'b'.repeat(64), mode: 'optional', versionState: 'revoked', blocked: true },
  ] });
  assert.equal(rows[0].status, 'ok'); assert.equal(rows[1].status, 'blocked');
  assert.equal(rows[1].statusText, 'Blocked: this version was revoked');
  assert.equal(rows[0].sha, 'a'.repeat(12));
  assert.deepEqual(assignmentRows(undefined), []);
  assert.deepEqual([...ASSIGNMENT_MODES], ['required', 'recommended', 'optional']);
});

test('parsePolicyForm turns the form into the document the API validates, one rule per line, and refuses what it cannot read', () => {
  const ok = parsePolicyForm({ mode: 'allowlist', minTrust: 'verified', requireCleanScan: 'on', rules: 'allow publisher acme\n\ndeny type hook\n  deny listing acme/bad  ' });
  assert.deepEqual(ok, { ok: true, doc: { mode: 'allowlist', minTrust: 'verified', requireCleanScan: true, rules: [
    { effect: 'allow', matchKind: 'publisher', matchValue: 'acme' }, { effect: 'deny', matchKind: 'type', matchValue: 'hook' }, { effect: 'deny', matchKind: 'listing', matchValue: 'acme/bad' }] } });
  const off = parsePolicyForm({ mode: 'open', minTrust: '', rules: '' });
  assert.deepEqual(off, { ok: true, doc: { mode: 'open', minTrust: null, requireCleanScan: false, rules: [] } });
  for (const bad of [{ mode: 'x', rules: '' }, { mode: 'open', minTrust: 'gold', rules: '' }, { mode: 'open', rules: 'allow publisher' }, { mode: 'open', rules: 'permit type hook' }, { mode: 'open', rules: 'allow planet mars' }]) {
    const r = parsePolicyForm(bad as any); assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(typeof (r as any).error === 'string');
  }
  assert.equal(parsePolicyForm({ mode: 'open', rules: Array.from({ length: 501 }, (_, i) => `allow publisher p${i}`).join('\n') }).ok, false);
});

test('policyToForm round-trips what the API returned', () => {
  const doc = { mode: 'allowlist', minTrust: 'verified', requireCleanScan: true, rules: [{ effect: 'deny', matchKind: 'type', matchValue: 'hook' }] };
  const f = policyToForm(doc);
  assert.equal(f.rules, 'deny type hook');
  const back = parsePolicyForm({ mode: f.mode, minTrust: f.minTrust, requireCleanScan: f.requireCleanScan ? 'on' : undefined, rules: f.rules });
  assert.deepEqual(back, { ok: true, doc });
  assert.equal(policyToForm(null).mode, 'open');
});

test('withMarketplacePermissions adds only known marketplace permissions from the marketplace API and never widens anything else', () => {
  assert.deepEqual(withMarketplacePermissions(['overview.read'], { role: 'engineer', permissions: ['marketplace.read', 'marketplace.review'] }), ['overview.read', 'marketplace.read', 'marketplace.review']);
  assert.deepEqual(withMarketplacePermissions(['overview.read'], null), ['overview.read'], 'the marketplace API unreachable: no marketplace permission (fail closed)');
  assert.deepEqual(withMarketplacePermissions([], { permissions: ['users.delete', 'marketplace.policy', 'marketplace.bogus', 7] } as any), ['marketplace.policy'], 'an unknown or non-marketplace entry is dropped');
  assert.deepEqual(withMarketplacePermissions(['marketplace.read'], { permissions: ['marketplace.read'] }), ['marketplace.read'], 'no duplicates');
  assert.deepEqual(withMarketplacePermissions(['a'], { permissions: 'marketplace.read' } as any), ['a']);
});
