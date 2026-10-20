import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseManifest, ManifestError, compareSemver, satisfies } from '../src/marketplace/manifest.ts';
import { validateArtifact, registerValidator } from '../src/marketplace/validate/index.ts';
import type { ManifestV1, UnpackedPackage } from '../src/marketplace/types.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);
const HEX = 'a'.repeat(64);

function base(): any {
  return {
    schema: 'agentic.marketplace/1', id: 'acme/my-skill', type: 'skill', version: '1.2.3',
    title: 'T', summary: 'S', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [],
    permissions: [], files: [{ path: 'SKILL.md', sha256: HEX, size: 3 }], payload: {},
  };
}
function throwsAt(mut: (m: any) => void, path: string) {
  const m = base(); mut(m);
  assert.throws(() => parseManifest(m), (e: any) => e instanceof ManifestError && e.path === path, path);
}

test('valid minimal manifest parses', () => {
  const m = parseManifest(base());
  assert.equal(m.id, 'acme/my-skill');
});
test('rejects bad values with JSON path', () => {
  throwsAt(m => { m.version = '01.2.3'; }, 'version');
  throwsAt(m => { m.version = '1.2'; }, 'version');
  throwsAt(m => { m.id = 'Acme/x'; }, 'id');
  throwsAt(m => { m.id = 'noslash'; }, 'id');
  throwsAt(m => { m.files.push({ path: 'SKILL.md', sha256: HEX, size: 1 }); }, 'files[1].path');
  throwsAt(m => { m.files[0].path = 'a/../b'; }, 'files[0].path');
  throwsAt(m => { m.files[0].path = '/etc/passwd'; }, 'files[0].path');
  throwsAt(m => { m.files[0].path = 'a\\b'; }, 'files[0].path');
  throwsAt(m => { m.files[0].path = 'a//b'; }, 'files[0].path');
  throwsAt(m => { m.files[0].sha256 = 'abc'; }, 'files[0].sha256');
  throwsAt(m => { m.files[0].sha256 = 'A'.repeat(64); }, 'files[0].sha256');
  throwsAt(m => { m.files[0].size = -1; }, 'files[0].size');
  throwsAt(m => { m.permissions = [{ capability: 'root', scope: 'x', reason: 'y' }]; }, 'permissions[0].capability');
  throwsAt(m => { m.permissions = [{ capability: 'network', scope: '', reason: 'y' }]; }, 'permissions[0].scope');
  throwsAt(m => { m.schema = 'nope'; }, 'schema');
  throwsAt(m => { m.type = 'bogus'; }, 'type');
  throwsAt(m => { m.compat.app = ''; }, 'compat.app');
  throwsAt(m => { m.dependencies = [{ id: 'BAD', range: '^1.0.0' }]; }, 'dependencies[0].id');
  throwsAt(m => { m.payload = []; }, 'payload');
});

test('compareSemver', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.ok(compareSemver(order[i], order[i + 1]) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.ok(compareSemver(order[i + 1], order[i]) > 0);
  }
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.ok(compareSemver('1.10.0', '1.9.0') > 0);
});
test('satisfies', () => {
  const t: [string, string, boolean][] = [
    ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.2.5', '^0.2.0', true], ['0.3.0', '^0.2.0', false],
    ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.0', true], ['1.3.0', '~1.2.0', false],
    ['1.2.3', '>=1.2.3', true], ['1.2.2', '>=1.2.3', false], ['1.2.3', '<=1.2.3', true], ['1.2.4', '<=1.2.3', false],
    ['1.2.2', '<1.2.3', true], ['1.2.3', '<1.2.3', false], ['1.2.4', '>1.2.3', true], ['1.2.3', '>1.2.3', false],
    ['1.2.3', '=1.2.3', true], ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false],
    ['3.4.5', '*', true], ['3.4.5', 'x', true], ['1.5.0', '1.x', true], ['2.0.0', '1.x', false], ['1.2.7', '1.2.x', true], ['1.3.0', '1.2.x', false],
    ['1.0.0-rc.1', '>=1.0.0', false], ['1.0.0', '>=1.0.0-rc.1', true],
  ];
  for (const [v, r, exp] of t) assert.equal(satisfies(v, r), exp, `${v} ${r}`);
});

function pkg(type: any, files: Record<string, string>, declared?: Record<string, string>): UnpackedPackage {
  const fm = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, enc(v)]));
  const d = declared ?? files;
  const manifest: ManifestV1 = { ...parseManifest(base()), type, files: Object.entries(d).map(([p, c]) => ({ path: p, sha256: sha(enc(c)), size: enc(c).length })) };
  return { files: fm, manifest };
}
const failed = (r: any) => r.checks.filter((c: any) => !c.ok).map((c: any) => c.name);

test('hook has no validator -> type-supported fails', async () => {
  const r = await validateArtifact('hook', pkg('hook', { a: 'x' }));
  assert.equal(r.ok, false);
  const c = r.checks.find(c => c.name === 'type-supported')!;
  assert.equal(c.ok, false);
  assert.equal(c.detail, 'no validator for type hook');
});
test('registered validator runs after common checks', async () => {
  registerValidator('routine', async () => [{ name: 'custom', ok: true }]);
  const r = await validateArtifact('routine', pkg('routine', { a: 'x' }));
  assert.equal(r.ok, true);
  assert.ok(r.checks.some(c => c.name === 'custom'));
  assert.ok(r.checks.some(c => c.name === 'manifest-type-matches' && c.ok));
  assert.ok(r.checks.some(c => c.name === 'files-match-hashes' && c.ok));
});
test('hash mismatch fails files-match-hashes', async () => {
  registerValidator('routine', async () => []);
  const p = pkg('routine', { a: 'x' }, { a: 'y' });
  assert.deepEqual(failed(await validateArtifact('routine', p)), ['files-match-hashes']);
});
test('undeclared extra file fails', async () => {
  registerValidator('routine', async () => []);
  const p = pkg('routine', { a: 'x', extra: 'z' }, { a: 'x' });
  assert.deepEqual(failed(await validateArtifact('routine', p)), ['files-match-hashes']);
});
test('manifest type mismatch fails', async () => {
  registerValidator('routine', async () => []);
  assert.deepEqual(failed(await validateArtifact('routine', pkg('skill', { a: 'x' }))), ['manifest-type-matches']);
});
