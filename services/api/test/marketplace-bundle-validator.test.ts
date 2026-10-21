import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compatIntersects, createBundleValidator } from '../src/marketplace/validate/bundle.ts';
import { parseRiskTier } from '../src/marketplace/validate/advanced-common.ts';
import type { UnpackedPackage, ValidationCheck } from '../src/marketplace/types.ts';
import { bundleOf, catalogOf, H, member, pkgOf } from './helpers/bundle-fixtures.ts';

const pub = { visibility: 'public' as const, teamId: null };
const run = (pkg: UnpackedPackage, ms = [] as ReturnType<typeof member>[], ctx: any = pub, hidden: string[] = []) =>
  createBundleValidator({ catalog: catalogOf(ms, hidden), context: ctx })(pkg) as Promise<ValidationCheck[]>;
const failed = (cs: ValidationCheck[]) => cs.filter((c) => !c.ok).map((c) => c.name);
const get = (cs: ValidationCheck[], n: string) => cs.find((c) => c.name === n)!;

describe('createBundleValidator', () => {
  test('a good bundle passes with no failing and no skipped check', async () => {
    const a = member('acme/a'), b = member('acme/b', { dependencies: [{ id: 'acme/a', range: '^1.0.0' }] });
    const cs = await run(pkgOf(bundleOf([a, b])), [a, b]);
    assert.deepEqual(failed(cs), []); assert.ok(!cs.some((c) => c.skipped));
    assert.equal(parseRiskTier(cs), 'declarative');
  });
  test('files allowlist: documents, memories, env files and executables are refused', async () => {
    const a = member('acme/a');
    for (const name of ['notes.pdf', 'memory.md', '.env', 'client.docx', 'secrets.json', 'data.csv', 'run.sh']) {
      const cs = await run(pkgOf(bundleOf([a]), { extra: { [name]: new TextEncoder().encode('x') } }), [a]);
      assert.ok(failed(cs).includes('bundle-files-allowlist'), name);
    }
    const ok = await run(pkgOf(bundleOf([a]), { extra: { 'README.md': new TextEncoder().encode('# hi') } }), [a]);
    assert.deepEqual(failed(ok), []);
    const sh = await run(pkgOf(bundleOf([a]), { extra: { 'README.md': new TextEncoder().encode('#!/bin/sh\nrm -rf /') } }), [a]);
    assert.ok(failed(sh).includes('bundle-files-allowlist'));
  });
  test('parse failures stop early with a reason', async () => {
    for (const bad of ['{nope', JSON.stringify({ schema: 'x' })]) assert.ok(failed(await run(pkgOf(bad))).includes('bundle-parse'));
    const empty = pkgOf(bundleOf([member('acme/a')])); empty.files.delete('bundle.json');
    assert.ok(failed(await run(empty)).includes('bundle-parse'));
  });
  test('pin integrity: forged hash, wrong version, unpublished, not visible, unknown member', async () => {
    const a = member('acme/a'), rev = member('acme/rev', { state: 'revoked' }), hid = member('acme/hid');
    const b = bundleOf([a, rev, hid, member('acme/gone')]); b.items[0].sha256 = H('forged');
    const cs = await run(pkgOf(b), [a, rev, hid], pub, ['acme/hid']);
    const d = get(cs, 'items-pinned').detail!;
    assert.ok(!get(cs, 'items-pinned').ok);
    for (const re of [/acme\/a@1.0.0: sha256 does not match/, /acme\/rev@1.0.0: is revoked/, /acme\/hid@1.0.0: not visible to the publisher/, /acme\/gone@1.0.0: not_found/]) assert.match(d, re);
  });
  test('nested bundle and self reference', async () => {
    const a = member('acme/a'); const b = bundleOf([a]);
    b.items.push({ id: 'acme/inner', type: 'bundle', version: '1.0.0', sha256: H('i') }, { id: 'acme/starter-pack', type: 'skill', version: '1.0.0', sha256: H('s') });
    b.installOrder.push('acme/inner', 'acme/starter-pack');
    const cs = await run(pkgOf(b), [a]);
    assert.ok(failed(cs).includes('items-types')); assert.match(get(cs, 'items-types').detail!, /cannot contain a bundle.*cannot contain itself/);
  });
  test('unsupported member types make the bundle fail with an explicit reason', async () => {
    const h = member('acme/h', { type: 'hook' }), a = member('acme/a');
    const cs = await run(pkgOf(bundleOf([a, h])), [a, h]);
    assert.ok(failed(cs).includes('members-supported')); assert.match(get(cs, 'members-supported').detail!, /acme\/h: type hook is not supported yet/);
    const ok = await createBundleValidator({ catalog: catalogOf([a, h]), context: pub, supported: () => true })(pkgOf(bundleOf([a, h])));
    assert.ok(!failed(ok as ValidationCheck[]).includes('members-supported'));
  });
  test('closure: missing transitive dependency, dependency at an unsatisfying pin, cycle', async () => {
    const a = member('acme/a', { dependencies: [{ id: 'acme/ghost', range: '^1.0.0' }] });
    assert.match(get(await run(pkgOf(bundleOf([a])), [a]), 'closure-complete').detail!, /acme\/ghost.*not an item/);
    const b = member('acme/b', { dependencies: [{ id: 'acme/c', range: '^2.0.0' }] }), c = member('acme/c');
    assert.match(get(await run(pkgOf(bundleOf([b, c])), [b, c]), 'closure-complete').detail!, /pins 1\.0\.0/);
    const x = member('acme/x', { dependencies: [{ id: 'acme/y', range: '^1.0.0' }] }), y = member('acme/y', { dependencies: [{ id: 'acme/x', range: '^1.0.0' }] });
    assert.match(get(await run(pkgOf(bundleOf([x, y])), [x, y]), 'closure-complete').detail!, /dependency cycle/);
  });
  test('installOrder: wrong order, missing id, duplicate', async () => {
    const a = member('acme/a'), b = member('acme/b', { dependencies: [{ id: 'acme/a', range: '^1.0.0' }] });
    for (const order of [['acme/b', 'acme/a'], ['acme/a'], ['acme/a', 'acme/a', 'acme/b'], ['acme/a', 'acme/b', 'acme/zzz']]) {
      const bd = bundleOf([a, b]); bd.installOrder = order;
      assert.ok(failed(await run(pkgOf(bd), [a, b])).includes('install-order-valid'), order.join());
    }
  });
  test('compat: disjoint member ranges fail, overlapping pass, unreported compat is skipped+required', async () => {
    const a = member('acme/a', { compatApp: '^1.0.0' }), b = member('acme/b', { compatApp: '^2.0.0' });
    assert.ok(failed(await run(pkgOf(bundleOf([a, b]), { compat: '>=1.0.0' }), [a, b])).includes('compat-consistent'));
    assert.deepEqual(failed(await run(pkgOf(bundleOf([a]), { compat: '>=1.0.0 <1.5.0' }), [a])), []);
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { compat: '^2.0.0' }), [a])).includes('compat-consistent'));
    const nc = member('acme/n', { compatApp: undefined });
    const c = get(await run(pkgOf(bundleOf([nc])), [nc]), 'compat-consistent');
    assert.equal(c.skipped, true); assert.equal(c.required, true);
    assert.equal(compatIntersects(['<1.0.0', '>=1.0.0']), false); assert.equal(compatIntersects(['^1.2.0', '~1.2.3', '1.x']), true); assert.equal(compatIntersects(['nonsense']), false);
  });
  test('visibility: a public bundle cannot hold private/team/org members; a team bundle may hold its own team', async () => {
    const pr = member('acme/pr', { visibility: 'private' }), tm = member('acme/tm', { visibility: 'team', teamId: 't1' }), og = member('acme/og', { visibility: 'org' });
    const cs = await run(pkgOf(bundleOf([pr, tm, og])), [pr, tm, og]);
    assert.match(get(cs, 'visibility-no-escalation').detail!, /acme\/pr.*private.*acme\/tm.*team.*acme\/og.*org/);
    const team = { visibility: 'team', teamId: 't1' };
    const ok = await run(pkgOf(bundleOf([tm, og], { teamScope: { kind: 'team', teamId: 't1' } })), [tm, og], team);
    assert.deepEqual(failed(ok), []);
    const other = await run(pkgOf(bundleOf([tm], { teamScope: { kind: 'team', teamId: 't2' } })), [tm], { visibility: 'team', teamId: 't2' });
    assert.ok(failed(other).includes('visibility-no-escalation'));
    assert.ok(failed(await run(pkgOf(bundleOf([og])), [og], team)).includes('team-scope-valid'));
    assert.ok(failed(await run(pkgOf(bundleOf([og], { teamScope: { kind: 'team', teamId: 't1' } })), [og], pub)).includes('team-scope-valid'));
  });
  test('permissions union: under-declared fails, over-declared passes with a note, exact passes', async () => {
    const net = { capability: 'network' as const, scope: 'api.example.com', reason: 'r' };
    const a = member('acme/a', { permissions: [net] });
    assert.ok(failed(await run(pkgOf(bundleOf([a])), [a])).includes('permissions-union'));
    assert.deepEqual(failed(await run(pkgOf(bundleOf([a]), { permissions: [net] }), [a])), []);
    const over = get(await run(pkgOf(bundleOf([member('acme/b')]), { permissions: [net] }), [member('acme/b')]), 'permissions-union');
    assert.equal(over.ok, true); assert.match(over.detail!, /declared but not used/);
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { permissions: [{ ...net, scope: '*' }] }), [a])).includes('permissions-union'));
  });
  test('an elevated member makes the bundle elevated', async () => {
    const e = member('acme/e', { permissions: [{ capability: 'exec.script', scope: 'build', reason: 'r' }] }), h = member('acme/h', { type: 'routine' });
    const cs = await createBundleValidator({ catalog: catalogOf([e, h]), context: pub, supported: () => true })(pkgOf(bundleOf([e, h]), { permissions: e.permissions })) as ValidationCheck[];
    assert.equal(parseRiskTier(cs), 'executable'); assert.match(get(cs, 'manual-review-required').detail!, /acme\/e/);
  });
  test('manifest dependencies must match the pinned items', async () => {
    const a = member('acme/a');
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { deps: [{ id: 'acme/a', range: '^1.0.0' }] }), [a])).includes('deps-match-manifest'));
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { deps: [] }), [a])).includes('deps-match-manifest'));
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { deps: [{ id: 'acme/a', range: '=1.0.0' }, { id: 'acme/z', range: '=1.0.0' }] }), [a])).includes('deps-match-manifest'));
  });
  test('secrets in bundle.json and manifest payload fail; sha256 pins do not trip the scanner', async () => {
    const a = member('acme/a');
    const b = bundleOf([a], { notes: 'use sk-' + 'abcdefghijklmnopqrstuvwx' }); 
    const cs = await run(pkgOf(b), [a]);
    assert.ok(failed(cs).includes('no-secrets')); assert.ok(!JSON.stringify(cs).includes('abcdefghijklmnopqrstuvwx'));
    assert.ok(failed(await run(pkgOf(bundleOf([a]), { payload: { k: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' } }), [a])).includes('no-secrets-manifest-payload'));
    assert.ok(!failed(await run(pkgOf(bundleOf([a])), [a])).includes('no-secrets'));
  });
  test('confusable ids: member vs bundle id', async () => {
    const a = member('acme/starterpack');
    assert.ok(failed(await run(pkgOf(bundleOf([a])), [a])).includes('confusable-ids'));
  });
  test('no catalog or no audience: catalog checks are skipped and required (never verified)', async () => {
    const a = member('acme/a');
    for (const v of [createBundleValidator(), createBundleValidator({ catalog: catalogOf([a]) })]) {
      const cs = await v(pkgOf(bundleOf([a]))) as ValidationCheck[];
      assert.deepEqual(failed(cs), []);
      for (const n of ['items-pinned', 'closure-complete', 'install-order-valid', 'permissions-union']) { assert.equal(get(cs, n).skipped, true, n); assert.equal(get(cs, n).required, true); }
    }
  });
  test('a catalog that throws fails the pin check, not the validator', async () => {
    const a = member('acme/a');
    const cs = await createBundleValidator({ catalog: { resolve: async () => { throw new Error('boom'); } }, context: pub })(pkgOf(bundleOf([a]))) as ValidationCheck[];
    assert.match(get(cs, 'items-pinned').detail!, /boom/);
  });
});
