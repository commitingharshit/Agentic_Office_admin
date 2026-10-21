import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planBundle, unionPermissions } from '../src/marketplace/bundle/plan.ts';
import type { EffectivePolicy } from '../src/marketplace/policy.ts';
import { bundleOf, catalogOf, H, member } from './helpers/bundle-fixtures.ts';

const ctx = { visibility: 'public' as const, teamId: null };
const none = new Map<string, { version: string; sha256: string }>();

describe('planBundle', () => {
  test('orders dependencies first and is deterministic', async () => {
    const a = member('acme/a'), b = member('acme/b', { dependencies: [{ id: 'acme/a', range: '^1.0.0' }] }), c = member('acme/c', { dependencies: [{ id: 'acme/b', range: '=1.0.0' }] });
    const bundle = bundleOf([c, a, b]);
    const p1 = await planBundle(catalogOf([a, b, c]), bundle, none, ctx);
    const p2 = await planBundle(catalogOf([c, b, a]), bundleOf([b, c, a]), none, ctx);
    assert.deepEqual(p1.steps.map((s) => s.id), ['acme/a', 'acme/b', 'acme/c']);
    assert.equal(JSON.stringify(p1), JSON.stringify(p2));
    assert.deepEqual(p1.problems, []); assert.equal(p1.installable, true);
    assert.deepEqual(p1.steps[2].dependsOn, ['acme/b']);
  });
  test('already_installed, upgrade and conflict', async () => {
    const a = member('acme/a'), b = member('acme/b', { version: '2.0.0' }), c = member('acme/c');
    const inst = new Map([['acme/a', { version: '1.0.0', sha256: a.sha256 }], ['acme/b', { version: '1.0.0', sha256: H('old') }], ['acme/c', { version: '1.0.0', sha256: H('forged') }]]);
    const p = await planBundle(catalogOf([a, b, c]), bundleOf([a, b, c]), inst, ctx);
    const act = Object.fromEntries(p.steps.map((s) => [s.id, s.action]));
    assert.deepEqual(act, { 'acme/a': 'already_installed', 'acme/b': 'upgrade', 'acme/c': 'conflict' });
    assert.equal(p.conflicts.length, 1); assert.equal(p.installable, false);
  });
  test('a downgrade is flagged', async () => {
    const a = member('acme/a');
    const p = await planBundle(catalogOf([a]), bundleOf([a]), new Map([['acme/a', { version: '2.0.0', sha256: H('x') }]]), ctx);
    assert.ok(p.warnings.some((w) => /downgrade/.test(w)));
  });
  test('pin mismatch, unpublished, not visible, wrong type, nested bundle, missing dep, cycle', async () => {
    const a = member('acme/a'), rev = member('acme/rev', { state: 'revoked' }), hid = member('acme/hid'), ty = member('acme/ty', { type: 'template' });
    const needs = member('acme/needs', { dependencies: [{ id: 'acme/ghost', range: '^1.0.0' }] });
    const wrongRange = member('acme/wr', { dependencies: [{ id: 'acme/a', range: '^2.0.0' }] });
    const x = member('acme/x', { dependencies: [{ id: 'acme/y', range: '^1.0.0' }] }), y = member('acme/y', { dependencies: [{ id: 'acme/x', range: '^1.0.0' }] });
    const bundle = bundleOf([a, rev, hid, ty, needs, wrongRange, x, y]);
    bundle.items[0].sha256 = H('swapped');
    bundle.items[3].type = 'skill';
    bundle.items.push({ id: 'acme/inner', type: 'bundle', version: '1.0.0', sha256: H('i') });
    const p = await planBundle(catalogOf([a, rev, hid, ty, needs, wrongRange, x, y], ['acme/hid']), bundle, none, ctx);
    const text = p.problems.join('\n');
    for (const re of [/acme\/a@1.0.0: pinned sha256/, /acme\/rev@1.0.0: is revoked/, /acme\/hid: not_visible/, /acme\/ty: is a template/, /acme\/inner: a bundle cannot contain a bundle/,
      /acme\/needs: needs acme\/ghost/, /acme\/wr: needs acme\/a \^2\.0\.0/, /dependency cycle: acme\/x -> acme\/y -> acme\/x/]) assert.match(text, re);
    assert.equal(p.installable, false);
  });
  test('permission union is deduped and sorted; risk tiers and elevation are per member', async () => {
    const net = { capability: 'network' as const, scope: 'api.example.com', reason: 'r' };
    const a = member('acme/a', { permissions: [net] }), b = member('acme/b', { permissions: [net, { capability: 'exec.script', scope: 'build', reason: 'r2' }] });
    const p = await planBundle(catalogOf([a, b]), bundleOf([a, b]), none, ctx);
    assert.deepEqual(p.permissions.map((x) => x.capability), ['exec.script', 'network']);
    assert.equal(p.steps.find((s) => s.id === 'acme/a')!.riskTier, 'declarative');
    assert.equal(p.steps.find((s) => s.id === 'acme/b')!.riskTier, 'executable');
    assert.equal(p.riskTier, 'executable'); assert.equal(p.elevated, true);
    assert.deepEqual(unionPermissions([[net], [net]]), [net]);
  });
  test('policy verdicts: deny wins, every allowlist layer must match, unknown trust fails closed', async () => {
    const a = member('acme/a'), b = member('evil/b'), c = member('acme/c', { type: 'template' });
    const policy: EffectivePolicy = { layers: [
      { scopeKind: 'org', scopeId: 'default', mode: 'open', minTrust: null, requireCleanScan: false, rules: [{ effect: 'deny', matchKind: 'publisher', matchValue: 'evil' }] },
      { scopeKind: 'team', scopeId: 't1', mode: 'allowlist', minTrust: null, requireCleanScan: false, rules: [{ effect: 'allow', matchKind: 'type', matchValue: 'skill' }] }] };
    const p = await planBundle(catalogOf([a, b, c]), bundleOf([a, b, c]), none, { ...ctx, policy });
    const v = Object.fromEntries(p.steps.map((s) => [s.id, s.policy!.allowed]));
    assert.deepEqual(v, { 'acme/a': true, 'evil/b': false, 'acme/c': false });
    assert.deepEqual(p.policy!.allowed, ['acme/a']); assert.equal(p.installable, false);
    const strict: EffectivePolicy = { layers: [{ scopeKind: 'org', scopeId: 'default', mode: 'open', minTrust: 'verified', requireCleanScan: false, rules: [] }] };
    const q = await planBundle(catalogOf([a]), bundleOf([a]), none, { ...ctx, policy: strict });
    assert.equal(q.steps[0].policy!.allowed, false);
    const q2 = await planBundle(catalogOf([a]), bundleOf([a]), none, { ...ctx, policy: strict, trustOf: () => 'official' });
    assert.equal(q2.installable, true);
    const bad = await planBundle(catalogOf([a]), bundleOf([a]), none, { ...ctx, policy: { layers: [{ scopeKind: 'org', scopeId: 'd', mode: 'open', minTrust: 'bogus' as any, requireCleanScan: false, rules: [null as any] }] } });
    assert.equal(bad.steps[0].policy!.allowed, false);
  });
  test('a resolver that throws is a problem, not a crash', async () => {
    const a = member('acme/a');
    const p = await planBundle({ resolve: async () => { throw new Error('db down'); } }, bundleOf([a]), none, ctx);
    assert.match(p.problems[0], /db down/); assert.equal(p.steps.length, 0);
  });
});
