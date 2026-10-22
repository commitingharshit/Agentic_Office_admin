import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { zipSync, type Zippable } from 'fflate';
import type pg from 'pg';
import { S3 } from '../src/api/s3.ts';
import { ManifestError } from '../src/marketplace/manifest.ts';
import {
  ArtifactCorruptError, MANIFEST_NAME, foldName, MAX_ARTIFACT_BYTES, UnpackError, memoryArtifactStore, openArtifact, putArtifact, rewriteManifest, sha256Hex, unpack,
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

// ---- fix round 1 ------------------------------------------------------------------------------
const u32 = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);
/** offsets of every header with signature `sig` */
const findSig = (z: Uint8Array, sig: number) => { const out: number[] = []; for (let i = 0; i + 4 <= z.length; i++) if (u32(z).getUint32(i, true) === sig) out.push(i); return out; };
const name = (z: Uint8Array, off: number, nameAt: number, lenAt: number) => new TextDecoder().decode(z.subarray(off + nameAt, off + nameAt + u32(z).getUint16(off + lenAt, true)));

describe('unpack hardening', () => {
  test('CPU bomb: 256 MiB of zeros with a lying declared size is rejected fast without big allocations', () => {
    const z = pkg({ 'big.bin': new Uint8Array(256 * 1024 * 1024) });
    const d = u32(z);
    for (const i of findSig(z, 0x02014b50)) if (name(z, i, 46, 28) === 'big.bin') d.setUint32(i + 24, 10, true);
    const before = process.memoryUsage().arrayBuffers;
    const t = performance.now();
    rejectsWith(() => unpack(z), 'bad-zip');
    assert.ok(performance.now() - t < 200, `took ${performance.now() - t} ms`);
    assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024, 'no allocation beyond the declared size');
  });
  test('non-ASCII name with the UTF-8 flag is accepted; without it, rejected as bad-path', () => {
    const z = pkg({ 'café.md': enc('x') });
    assert.ok(unpack(z).files.has('café.md'));
    const d = u32(z);
    for (const i of findSig(z, 0x04034b50)) d.setUint16(i + 6, d.getUint16(i + 6, true) & ~0x800, true);
    for (const i of findSig(z, 0x02014b50)) d.setUint16(i + 8, d.getUint16(i + 8, true) & ~0x800, true);
    rejectsWith(() => unpack(z), 'bad-path');
  });
  test('zip64 locator rejected', () => {
    const z = pkg({ 'a.md': enc('x') });
    const e = findSig(z, 0x06054b50).at(-1)!;
    const out = new Uint8Array(z.length + 20); out.set(z.subarray(0, e)); out.set(z.subarray(e), e + 20);
    u32(out).setUint32(e, 0x07064b50, true);
    rejectsWith(() => unpack(out), 'bad-zip');
  });
  test('truncated / inconsistent central directory rejected', () => {
    const z = pkg({ 'a.md': enc('x') });
    rejectsWith(() => unpack(z.subarray(0, z.length - 30)), 'bad-zip');
    const bad = new Uint8Array(z); const e = findSig(bad, 0x06054b50).at(-1)!;
    u32(bad).setUint16(e + 10, 5, true); // total entries != this-disk entries
    rejectsWith(() => unpack(bad), 'bad-zip');
    const bad2 = new Uint8Array(z); u32(bad2).setUint16(e + 8, 5, true); u32(bad2).setUint16(e + 10, 5, true); // claims more than exist
    rejectsWith(() => unpack(bad2), 'bad-zip');
    const multi = new Uint8Array(z); u32(multi).setUint16(e + 4, 1, true);
    rejectsWith(() => unpack(multi), 'bad-zip');
  });
  test('EOCD signature inside the zip comment: the real (last consistent) EOCD is used', () => {
    const z = pkg({ 'a.md': enc('x') });
    const comment = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0), 0x78, 0x78, 0x78, 0x78]);
    const out = new Uint8Array(z.length + comment.length); out.set(z); out.set(comment, z.length);
    const e = findSig(z, 0x06054b50).at(-1)!;
    u32(out).setUint16(e + 20, comment.length, true);
    assert.ok(unpack(out).files.has('a.md'));
  });
  test('local header name mismatch: the central directory name wins, nothing escapes', () => {
    const z = pkg({ 'ok.md': enc('x') });
    const li = findSig(z, 0x04034b50).find((i) => name(z, i, 30, 26) === 'ok.md')!;
    z.set(enc('../xx'), li + 30);
    const u = unpack(z);
    assert.deepEqual([...u.files.keys()], ['ok.md']);
  });
  test('symlink-flagged directory entry rejected', () => {
    rejectsWith(() => unpack(pkg({ 'd/': [new Uint8Array(0), { attrs: (0o120777 << 16) >>> 0 }] })), 'symlink');
  });
  test('invalid manifest surfaces as UnpackError bad-manifest with the ManifestError as cause', () => {
    const z = zipSync({ [MANIFEST_NAME]: enc(JSON.stringify({ schema: 'nope' })) });
    assert.throws(() => unpack(z), (e: any) => e instanceof UnpackError && e.code === 'bad-manifest' && e.cause instanceof ManifestError);
    assert.throws(() => unpack(zipSync({ [MANIFEST_NAME]: enc('{not json') })), (e: any) => e instanceof UnpackError && e.code === 'bad-manifest');
  });
});

describe('ArtifactStore.has and putArtifact', () => {
  test('putArtifact consults has() and skips put for an existing blob', async () => {
    const calls: string[] = [];
    const inner = memoryArtifactStore();
    const store = { ...inner, async has(s: string) { calls.push('has'); return inner.has(s); }, async put(s: string, b: Uint8Array) { calls.push('put'); return inner.put(s, b); } };
    await putArtifact(store, enc('same')); await putArtifact(store, enc('same'));
    assert.deepEqual(calls, ['has', 'put', 'has']);
  });
});

describe('openArtifact connection hygiene', () => {
  test('a failing ROLLBACK destroys the pooled connection (release(err))', async () => {
    let released: unknown = 'not-called';
    const client = {
      async query(t: string) { if (t === 'ROLLBACK') throw new Error('rollback boom'); return { rows: [] }; },
      release(err?: unknown) { released = err; },
    };
    const pool: any = { totalCount: 1, async connect() { return client; }, query: client.query };
    assert.equal(await openArtifact(pool, memoryArtifactStore(), { userId: 'u' }, 'v'), undefined);
    assert.ok(released instanceof Error);
  });
});

describe('S3 byte methods', () => {
  test('putBytes/getBytes/head against a local server; getBytes enforces maxBytes', async () => {
    const blobs = new Map<string, Buffer>();
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const k = req.url!;
        if (req.method === 'PUT') { blobs.set(k, Buffer.concat(chunks)); res.writeHead(200).end(); }
        else if (req.method === 'HEAD') { const b = blobs.get(k); res.writeHead(b ? 200 : 404, b ? { 'content-length': String(b.length) } : {}).end(); }
        else { const b = blobs.get(k); b ? res.writeHead(200, { 'content-length': String(b.length) }).end(b) : res.writeHead(404).end(); }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const s3 = new S3({ endpoint: `http://127.0.0.1:${(srv.address() as any).port}`, accessKey: 'a', secretKey: 'b' });
      await s3.putBytes('bkt', 'k/1', enc('hello'));
      assert.deepEqual(await s3.getBytes('bkt', 'k/1', 100), enc('hello'));
      assert.equal(await s3.getBytes('bkt', 'nope', 100), undefined);
      await assert.rejects(s3.getBytes('bkt', 'k/1', 3), /exceeds/);
    } finally { srv.close(); }
  });
});

describe('putArtifact', () => {
  test('same bytes -> same sha256, idempotent, stored once', async () => {
    const store = memoryArtifactStore();
    const z = pkg({ 'a.md': enc('a') });
    const a = await putArtifact(store, z), b = await putArtifact(store, new Uint8Array(z));
    assert.deepEqual({ ...a, wrote: 0 }, { ...b, wrote: 0 });
    assert.equal(a.wrote, true); assert.equal(b.wrote, false);   // only the first call wrote the blob
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

describe('rewriteManifest', () => {
  const base = () => {
    const files = new Map<string, Uint8Array>([['SKILL.md', enc('# hi')], ['refs/a.md', enc('a')]]);
    return { files, manifest: { ...manifest(), files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })) } as any };
  };
  test('changes the id and version, keeps every file, and recomputes the file hashes', () => {
    const p = base();
    // a stale hash in the input manifest must not survive: the new manifest describes the actual bytes
    p.manifest.files[0].sha256 = '0'.repeat(64);
    const out = unpack(rewriteManifest(p, { id: 'u-me/my-fork', version: '1.0.0-fork.1' }));
    assert.equal(out.manifest.id, 'u-me/my-fork');
    assert.equal(out.manifest.version, '1.0.0-fork.1');
    assert.equal(out.manifest.title, 'T');
    assert.deepEqual([...out.files.keys()].sort(), ['SKILL.md', 'refs/a.md']);
    for (const f of out.manifest.files) assert.equal(f.sha256, sha256Hex(out.files.get(f.path)!));
    assert.equal(out.manifest.files.length, 2);
  });
  test('is deterministic and does not modify its input', () => {
    const p = base(); const before = JSON.stringify(p.manifest);
    const a = rewriteManifest(p, { id: 'u-me/x' }), b = rewriteManifest(p, { id: 'u-me/x' });
    assert.equal(sha256Hex(a), sha256Hex(b));
    assert.equal(JSON.stringify(p.manifest), before);
    assert.equal(p.manifest.id, 'acme/my-skill');
  });
  test('output survives the hardened unpacker (UTF-8 names, unix mode) and a bad patch is refused', () => {
    const p = base(); p.files.set('référence.md', enc('é'));
    assert.ok(unpack(rewriteManifest(p, {})).files.has('référence.md'));
    assert.throws(() => rewriteManifest(p, { id: 'Not Valid' }), ManifestError);
    assert.throws(() => rewriteManifest(p, { version: 'nope' }), ManifestError);
  });
  test('tampered input: file bytes that no longer match the old manifest hashes are described by their ACTUAL hashes', () => {
    const p = base();
    p.files.set('SKILL.md', enc('# tampered after the manifest was written'));
    const out = unpack(rewriteManifest(p, { id: 'u-me/x' }));
    for (const f of out.manifest.files) assert.equal(sha256Hex(out.files.get(f.path)!), f.sha256, f.path);
    assert.equal(out.manifest.files.find((f: any) => f.path === 'SKILL.md')!.sha256, sha256Hex(enc('# tampered after the manifest was written')));
  });
  test('a rewrite that would exceed the artifact size cap is refused as too-large before anything is written', () => {
    const p = base(); p.files.set('big.bin', new Uint8Array(MAX_ARTIFACT_BYTES));
    assert.throws(() => rewriteManifest(p, {}), (e: any) => e instanceof UnpackError && e.code === 'too-large');
  });
});

describe('foldName conformance (shared with desktop and Hermes)', () => {
  const pairs: { a: string; b: string; same: boolean }[] = JSON.parse(
    readFileSync(new URL('../../../tests/marketplace/zip-differential/fold-conformance.json', import.meta.url), 'utf8')).pairs;
  test('matches the shared list', () => {
    assert.ok(pairs.length >= 10);
    for (const c of pairs) { assert.equal(foldName(c.a) === foldName(c.b), c.same, JSON.stringify(c)); }
  });
});
