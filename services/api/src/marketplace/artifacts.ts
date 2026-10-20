// Artifact storage (content addressed, sha256-keyed) and safe unpacking of package zips.
// Nothing here writes to disk: unpack() returns bytes in memory, and every path is checked before use.
import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import type { S3 } from '../api/s3.ts';
import { ManifestError, parseManifest, pathProblem } from './manifest.ts';
import type { UnpackedPackage } from './types.ts';

export const MANIFEST_NAME = 'agentic.marketplace.json';
const MiB = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * MiB;

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- storage

export interface ArtifactStore {
  has(sha256: string): Promise<boolean>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}

const SHA_RE = /^[0-9a-f]{64}$/;
const assertSha = (s: string) => { if (!SHA_RE.test(s)) throw new Error('invalid sha256'); };

export function memoryArtifactStore(): ArtifactStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async has(sha) { assertSha(sha); return blobs.has(sha); },
    async put(sha, bytes) { assertSha(sha); blobs.set(sha, new Uint8Array(bytes)); },
    async get(sha) { assertSha(sha); const b = blobs.get(sha); return b && new Uint8Array(b); },
  };
}

export const artifactKey = (sha256: string) => `marketplace/artifacts/${sha256}`;

export function s3ArtifactStore(s3: S3, bucket: string): ArtifactStore {
  return {
    async has(sha) { assertSha(sha); return (await s3.head(bucket, artifactKey(sha))) !== undefined; },
    async put(sha, bytes) { assertSha(sha); await s3.putBytes(bucket, artifactKey(sha), bytes); },
    async get(sha) { assertSha(sha); return s3.getBytes(bucket, artifactKey(sha), MAX_ARTIFACT_BYTES); },
  };
}

/**
 * Content-addressed and idempotent: the same bytes always land under the same key. An already-stored blob
 * is not re-verified here; openArtifact re-hashes whatever it reads, which is where integrity is enforced.
 */
export async function putArtifact(store: ArtifactStore, bytes: Uint8Array, maxSize = MAX_ARTIFACT_BYTES): Promise<{ sha256: string; size: number }> {
  if (bytes.byteLength > maxSize) throw new UnpackError('too-large', `artifact is ${bytes.byteLength} bytes, over the ${maxSize} limit`);
  const sha256 = sha256Hex(bytes);
  if (!(await store.has(sha256))) await store.put(sha256, bytes);
  return { sha256, size: bytes.byteLength };
}

// ---------------------------------------------------------------- secure retrieval

/** Anything with pg's `query` (a Client); a Pool is checked out so BEGIN/set_config share a connection. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  connect?: () => Promise<Queryable & { release(): void }>;
}

export class ArtifactCorruptError extends Error {
  readonly versionId: string; readonly expected: string; readonly actual: string;
  constructor(versionId: string, expected: string, actual: string) {
    super(`artifact for version ${versionId} is corrupt: expected sha256 ${expected}, stored bytes hash to ${actual}`);
    this.name = 'ArtifactCorruptError';
    this.versionId = versionId; this.expected = expected; this.actual = actual;
  }
}

/**
 * Returns the artifact bytes of a version, or undefined when the version does not exist or is not
 * visible to the actor (row-level security, evaluated as ao_app with app.user_id set). The bytes read
 * from the store are re-hashed; a mismatch throws ArtifactCorruptError and nothing is returned.
 * `db` must connect as the ao_app role.
 */
export async function openArtifact(db: Queryable, store: ArtifactStore, actor: { userId: string }, versionId: string): Promise<{ bytes: Uint8Array; sha256: string } | undefined> {
  // `db` must be a Pool (a connection is checked out and pinned for BEGIN/set_config) or a dedicated client;
  // never a Client shared across concurrent requests, whose transaction state would interleave.
  const c = 'totalCount' in db && db.connect ? await db.connect() : db;
  let sha: string | undefined, releaseErr: unknown;
  try {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [actor.userId]);
      const r = await c.query(
        `SELECT v.sha256 FROM marketplace_versions v JOIN marketplace_artifacts a ON a.sha256 = v.sha256 WHERE v.id = $1`, [versionId]);
      sha = r.rows[0]?.sha256;
    } finally {
      // a failed ROLLBACK leaves the connection in an unknown state: hand the error to release() so the pool destroys it
      await c.query('ROLLBACK').catch((e: unknown) => { releaseErr = e instanceof Error ? e : new Error(String(e)); });
    }
  } catch (e) { releaseErr ??= e instanceof Error ? e : new Error(String(e)); throw e; }
  finally { (c as any).release?.(releaseErr); }
  if (!sha) return undefined;
  const bytes = await store.get(sha);
  if (!bytes) throw new ArtifactCorruptError(versionId, sha, 'missing');
  const actual = sha256Hex(bytes);
  if (actual !== sha) throw new ArtifactCorruptError(versionId, sha, actual);
  return { bytes, sha256: sha };
}

// ---------------------------------------------------------------- unpacking

export type UnpackCode = 'zip-slip' | 'symlink' | 'too-large' | 'too-many-files' | 'missing-manifest' | 'bad-path' | 'bad-zip' | 'duplicate' | 'bad-manifest';
export class UnpackError extends Error {
  readonly code: UnpackCode;
  constructor(code: UnpackCode, message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = 'UnpackError'; this.code = code; }
}

interface CdEntry { name: string; mode: number; declared: number; crc: number; csize: number; method: number; flags: number; lho: number }

/**
 * Reads the central directory (names, unix mode, sizes, CRC, local-header offset). Names come ONLY from here.
 * Strict about the end-of-central-directory record: it must end exactly at the end of the file (so a signature
 * planted in the zip comment is skipped), be single-disk, and not be zip64.
 */
function readCentralDirectory(b: Uint8Array): CdEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--)
    if (dv.getUint32(i, true) === 0x06054b50 && i + 22 + dv.getUint16(i + 20, true) === b.length) { eocd = i; break; }
  if (eocd < 0) throw new UnpackError('bad-zip', 'not a zip archive (no end-of-central-directory record)');
  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) throw new UnpackError('bad-zip', 'zip64 archives are not accepted');
  if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0) throw new UnpackError('bad-zip', 'multi-disk archives are not accepted');
  const count = dv.getUint16(eocd + 10, true), size = dv.getUint32(eocd + 12, true);
  if (dv.getUint16(eocd + 8, true) !== count) throw new UnpackError('bad-zip', 'inconsistent entry counts');
  let off = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || off === 0xffffffff || size === 0xffffffff) throw new UnpackError('bad-zip', 'zip64 archives are not accepted');
  if (off + size > eocd) throw new UnpackError('bad-zip', 'central directory out of range');
  const out: CdEntry[] = [];
  const td = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) throw new UnpackError('bad-zip', 'corrupt central directory');
    const flags = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true), csize = dv.getUint32(off + 20, true), declared = dv.getUint32(off + 24, true);
    const nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    const attrs = dv.getUint32(off + 38, true), lho = dv.getUint32(off + 42, true);
    if (off + 46 + nl > b.length) throw new UnpackError('bad-zip', 'corrupt central directory');
    const raw = b.subarray(off + 46, off + 46 + nl);
    if (!(flags & 0x800) && raw.some((x) => x > 0x7f)) throw new UnpackError('bad-path', 'name must be UTF-8 with the UTF-8 flag (general-purpose bit 11)');
    let name: string;
    try { name = td.decode(raw); } catch { throw new UnpackError('bad-path', 'entry name is not valid UTF-8'); }
    out.push({ name, mode: (attrs >>> 16) & 0xffff, declared, crc, csize, method, flags, lho });
    off += 46 + nl + xl + cl;
  }
  return out;
}

/** Inflates one entry without ever producing more than its declared size (a lying entry fails fast). */
function extract(b: Uint8Array, e: CdEntry): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const bad = (why: string) => new UnpackError('bad-zip', `entry ${JSON.stringify(e.name)}: ${why}`);
  if (e.flags & 1) throw bad('encrypted entries are not accepted');
  if (e.lho + 30 > b.length || dv.getUint32(e.lho, true) !== 0x04034b50) throw bad('bad local header');
  const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true); // the local NAME is ignored
  if (start + e.csize > b.length) throw bad('data out of range');
  const comp = b.subarray(start, start + e.csize);
  let out: Uint8Array;
  if (e.method === 0) {
    if (e.csize !== e.declared) throw bad('stored size mismatch');
    out = new Uint8Array(comp);
  } else if (e.method === 8) {
    try { out = inflateRawSync(comp, { maxOutputLength: Math.max(1, e.declared) }); }
    catch { throw bad('inflates to more than its declared size, or is corrupt'); }
  } else throw bad(`unsupported compression method ${e.method}`);
  if (out.byteLength !== e.declared) throw bad('inflated size does not match the declared size');
  if (crc32(out) !== e.crc) throw bad('CRC-32 mismatch (corrupt or lying archive)');
  return out;
}

const S_IFMT = 0o170000, S_IFLNK = 0o120000;

function checkEntryPath(rel: string): void {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || rel.split('/').includes('..'))
    throw new UnpackError('zip-slip', `unsafe path in archive: ${JSON.stringify(rel)}`);
  const problem = pathProblem(rel);
  if (problem) throw new UnpackError('bad-path', `bad path ${JSON.stringify(rel)}: ${problem}`);
}

/**
 * Reads a package zip into memory. Throws UnpackError. Every check on names, modes, counts and declared sizes
 * runs on the central directory BEFORE any inflation; inflation is bounded per entry by its declared size.
 * Deferred (minor): full Unicode case folding for collision detection (NFC + toLowerCase only).
 */
export function unpack(bytes: Uint8Array, opts: { maxTotal?: number; maxFiles?: number } = {}): UnpackedPackage {
  const maxTotal = opts.maxTotal ?? MAX_ARTIFACT_BYTES, maxFiles = opts.maxFiles ?? 1000;
  const entries = readCentralDirectory(bytes);
  if (entries.length > maxFiles) throw new UnpackError('too-many-files', `archive has ${entries.length} entries, over the ${maxFiles} limit`);

  const seen = new Set<string>();
  const wanted: CdEntry[] = [];
  let declaredTotal = 0;
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const rel = isDir ? e.name.slice(0, -1) : e.name;
    checkEntryPath(rel);
    if ((e.mode & S_IFMT) === S_IFLNK) throw new UnpackError('symlink', `symlink entry in archive: ${JSON.stringify(e.name)}`);
    const key = rel.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new UnpackError('duplicate', `duplicate entry (or case/Unicode collision): ${JSON.stringify(e.name)}`);
    seen.add(key);
    if (isDir) continue;
    declaredTotal += e.declared;
    if (declaredTotal > maxTotal) throw new UnpackError('too-large', `archive declares more than ${maxTotal} bytes uncompressed`);
    wanted.push(e);
  }

  const files = new Map<string, Uint8Array>();
  let manifestRaw: Uint8Array | undefined;
  for (const e of wanted) {
    const data = extract(bytes, e);
    if (e.name === MANIFEST_NAME) manifestRaw = data; else files.set(e.name, data);
  }
  if (!manifestRaw) throw new UnpackError('missing-manifest', `${MANIFEST_NAME} not found at the package root`);
  try {
    const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRaw));
    return { files, manifest: parseManifest(json) };
  } catch (e) {
    const why = e instanceof ManifestError ? e.message : `${MANIFEST_NAME} is not valid JSON: ${(e as Error).message}`;
    throw new UnpackError('bad-manifest', why, e);
  }
}
