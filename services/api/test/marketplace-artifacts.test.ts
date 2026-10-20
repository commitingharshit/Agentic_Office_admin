import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { zipSync, type Zippable } from 'fflate';
import type pg from 'pg';
import {
  ArtifactCorruptError, MANIFEST_NAME, UnpackError, memoryArtifactStore, openArtifact, putArtifact, sha256Hex, unpack,
} from '../src/marketplace/artifacts.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (extra: Record<string, unknown> = {}) => ({
  schema: 'agentic.marketplace/1', id: 'acme/my-skill', type: 'skill', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
  compat: { app: '^1.0.0' }, dependencies: [], permissions: [], files: [], payload: {}, ...extra,
});
const pkg = (entries: Zippable, withManifest = true): Uint8Array =>
  zipSync({ ...(withManifest ? { [MANIFEST_NAME]: enc(JSON.stringify(manifest())) } : {}), ...entries }, { level: 6 });
const rejectsWith = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: any) => e instanceof UnpackError && e.code === code, `expected UnpackError ${code}`);

describe('unpack', () => {
  test('valid package round-trips (manifest excluded from files, dirs skipped)', () => {
    const z = pkg({ 'SKILL.md': enc('# hi'), 'refs/': new Uint8Array(0), 'refs/a.md': enc('a') });
    const u = unpack(z);
    assert.equal(u.manifest.id, 'acme/my-skill');
    assert.deepEqual([...u.files.keys()].sort(), ['SKILL.md', 'refs/a.md']);
    assert.equal(new TextDecoder().decode(u.files.get('SKILL.md')), '# hi');
  });
  test('zip-slip (..) rejected', () => rejectsWith(() => unpack(pkg({ '../evil': enc('x') })), 'zip-slip'));
  test('nested .. rejected', () => rejectsWith(() => unpack(pkg({ 'a/../../evil': enc('x') })), 'zip-slip'));
  test('absolute path rejected', () => rejectsWith(() => unpack(pkg({ '/etc/passwd': enc('x') })), 'zip-slip'));
  test('backslash path rejected', () => rejectsWith(() => unpack(pkg({ 'a\\b': enc('x') })), 'zip-slip'));
  test('other bad path (reserved name) rejected as bad-path', () => rejectsWith(() => unpack(pkg({ 'nul.txt': enc('x') })), 'bad-path'));
  test('symlink rejected', () => {
    const z = pkg({ 'link': [enc('/etc/passwd'), { attrs: (0o120777 << 16) >>> 0 }] });
    rejectsWith(() => unpack(z), 'symlink');
  });
  test('regular file with unix mode is fine', () => {
    const z = pkg({ 'run.sh': [enc('#!/bin/sh'), { attrs: (0o100755 << 16) >>> 0 }] });
    assert.ok(unpack(z).files.has('run.sh'));
  });
  test('zip bomb (declared size) rejected fast', () => {
    const z = pkg({ 'big.bin': new Uint8Array(200 * 1024 * 1024) });
    assert.ok(z.length < 1024 * 1024, 'compresses small');
    const t = performance.now();
    rejectsWith(() => unpack(z), 'too-large');
    assert.ok(performance.now() - t < 500, 'fails before inflating');
  });
  test('zip bomb that lies about its size is still stopped', () => {
    const z = pkg({ 'big.bin': new Uint8Array(20 * 1024 * 1024) });
    // patch the declared (uncompressed) size in the central directory to 10 bytes
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    for (let i = z.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x02014b50) {
      const nl = dv.getUint16(i + 28, true), name = new TextDecoder().decode(z.subarray(i + 46, i + 46 + nl));
      if (name === 'big.bin') dv.setUint32(i + 24, 10, true);
    }
    const t = performance.now();
    assert.throws(() => unpack(z, { maxTotal: 1024 * 1024 }), (e: any) => e instanceof UnpackError && e.code === 'bad-zip');
    assert.ok(performance.now() - t < 500);
  });
  test('actual inflated total over maxTotal rejected', () => {
    const z = pkg({ 'a.bin': new Uint8Array(600), 'b.bin': new Uint8Array(600) });
    rejectsWith(() => unpack(z, { maxTotal: 1000 }), 'too-large');
  });
  test('too many files rejected', () => {
    const e: Zippable = {}; for (let i = 0; i < 6; i++) e[`f${i}.txt`] = enc('x');
    rejectsWith(() => unpack(pkg(e), { maxFiles: 5 }), 'too-many-files');
  });
  test('duplicate entry rejected', () => {
    const z = pkg({ 'aaaa.txt': enc('1'), 'bbbb.txt': enc('2') });
    // rename bbbb.txt -> aaaa.txt in both local and central headers
    const s = Buffer.from(z); let from = 0, n = 0, i: number;
    while ((i = s.indexOf('bbbb.txt', from)) >= 0) { s.write('aaaa.txt', i); from = i + 1; n++; }
    assert.equal(n, 2);
    rejectsWith(() => unpack(new Uint8Array(s)), 'duplicate');
  });
  test('case and Unicode collisions rejected', () => {
    rejectsWith(() => unpack(pkg({ 'Readme.md': enc('1'), 'README.md': enc('2') })), 'duplicate');
    rejectsWith(() => unpack(pkg({ 'café.md': enc('1'), 'café.md': enc('2') })), 'duplicate');
  });
  test('missing manifest rejected', () => rejectsWith(() => unpack(pkg({ 'a.md': enc('x') }, false)), 'missing-manifest'));
  test('manifest in a subdirectory does not count', () =>
    rejectsWith(() => unpack(zipSync({ ['sub/' + MANIFEST_NAME]: enc(JSON.stringify(manifest())) })), 'missing-manifest'));
  test('not a zip rejected', () => rejectsWith(() => unpack(enc('hello world, definitely not a zip file')), 'bad-zip'));
});

describe('putArtifact', () => {
  test('same bytes -> same sha256, idempotent, stored once', async () => {
    const store = memoryArtifactStore();
    const z = pkg({ 'a.md': enc('a') });
    const a = await putArtifact(store, z), b = await putArtifact(store, new Uint8Array(z));
    assert.deepEqual(a, b);
    assert.equal(a.sha256, sha256Hex(z));
    assert.equal(a.size, z.length);
    assert.equal(store.blobs.size, 1);
  });
  test('different bytes -> different key', async () => {
    const store = memoryArtifactStore();
    const a = await putArtifact(store, enc('one')), b = await putArtifact(store, enc('two'));
    assert.notEqual(a.sha256, b.sha256);
  });
  test('enforces max size', async () => {
    await assert.rejects(putArtifact(memoryArtifactStore(), new Uint8Array(11), 10), (e: any) => e instanceof UnpackError && e.code === 'too-large');
  });
});

describe('openArtifact (real Postgres, RLS)', { skip }, () => {
  let h: MarketplacePg, app: pg.Client;
  const store = memoryArtifactStore();
  const bytes = enc('artifact-bytes');
  const sha = sha256Hex(bytes);

  before(async () => {
    h = await startMarketplacePg(); app = h.app;
    await putArtifact(store, bytes);
    await h.owner.query(`
      INSERT INTO users(id) VALUES ('u1'),('u2');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('pa','A','u1');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES
        ('pa/open','skill','pa','u1','public','Open'), ('pa/secret','skill','pa','u1','private','Secret');
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${sha}', ${bytes.length}, 'marketplace/artifacts/${sha}');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES
        ('v_open','pa/open','1.0.0',1,0,0,'published','{}','${sha}',${bytes.length}),
        ('v_secret','pa/secret','1.0.0',1,0,0,'draft','{}','${sha}',${bytes.length});`);
  });
  after(async () => { if (h) await h.stop(); });

  test('visible public version returns verified bytes', async () => {
    const r = await openArtifact(app, store, { userId: 'u2' }, 'v_open');
    assert.ok(r); assert.equal(r.sha256, sha); assert.deepEqual(r.bytes, bytes);
  });
  test('private-listing version is invisible to a non-owner but visible to its owner', async () => {
    assert.equal(await openArtifact(app, store, { userId: 'u2' }, 'v_secret'), undefined);
    assert.ok(await openArtifact(app, store, { userId: 'u1' }, 'v_secret'));
  });
  test('unknown version -> undefined', async () => {
    assert.equal(await openArtifact(app, store, { userId: 'u1' }, 'nope'), undefined);
  });
  test('tampered store bytes -> ArtifactCorruptError', async () => {
    const bad = memoryArtifactStore();
    await bad.put(sha, enc('tampered'));
    await assert.rejects(openArtifact(app, bad, { userId: 'u2' }, 'v_open'), ArtifactCorruptError);
  });
  test('a failed lookup leaves the connection usable (no open transaction)', async () => {
    await openArtifact(app, store, { userId: 'u2' }, 'v_secret');
    const r = await app.query('SELECT 1 AS x'); assert.equal(r.rows[0].x, 1);
  });
});
