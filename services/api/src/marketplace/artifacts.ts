// Artifact storage (content addressed, sha256-keyed) and safe unpacking of package zips.
// Nothing here writes to disk: unpack() returns bytes in memory, and every path is checked before use.
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import type { S3 } from '../api/s3.ts';
import { ManifestError, parseManifest, pathProblem } from './manifest.ts';
import type { UnpackedPackage } from './types.ts';

export const MANIFEST_NAME = 'agentic.marketplace.json';
const MiB = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 64 * MiB;

export const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- storage

export interface ArtifactStore {
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  get(sha256: string): Promise<Uint8Array | undefined>;
}

const SHA_RE = /^[0-9a-f]{64}$/;
const assertSha = (s: string) => { if (!SHA_RE.test(s)) throw new Error('invalid sha256'); };

export function memoryArtifactStore(): ArtifactStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(sha, bytes) { assertSha(sha); blobs.set(sha, new Uint8Array(bytes)); },
    async get(sha) { assertSha(sha); const b = blobs.get(sha); return b && new Uint8Array(b); },
  };
}

export const artifactKey = (sha256: string) => `marketplace/artifacts/${sha256}`;

export function s3ArtifactStore(s3: S3, bucket: string): ArtifactStore {
  return {
    async put(sha, bytes) { assertSha(sha); await s3.putBytes(bucket, artifactKey(sha), bytes); },
    async get(sha) { assertSha(sha); return s3.getBytes(bucket, artifactKey(sha)); },
  };
}

/** Content-addressed and idempotent: the same bytes always land under the same key. */
export async function putArtifact(store: ArtifactStore, bytes: Uint8Array, maxSize = MAX_ARTIFACT_BYTES): Promise<{ sha256: string; size: number }> {
  if (bytes.byteLength > maxSize) throw new UnpackError('too-large', `artifact is ${bytes.byteLength} bytes, over the ${maxSize} limit`);
  const sha256 = sha256Hex(bytes);
  if ((await store.get(sha256)) === undefined) await store.put(sha256, bytes);
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
  const c = 'totalCount' in db && db.connect ? await db.connect() : db; // a pg Pool: pin one connection
  let sha: string | undefined;
  try {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [actor.userId]);
      const r = await c.query(
        `SELECT v.sha256 FROM marketplace_versions v JOIN marketplace_artifacts a ON a.sha256 = v.sha256 WHERE v.id = $1`, [versionId]);
      sha = r.rows[0]?.sha256;
    } finally { await c.query('ROLLBACK').catch(() => {}); }
  } finally { (c as any).release?.(); }
  if (!sha) return undefined;
  const bytes = await store.get(sha);
  if (!bytes) throw new ArtifactCorruptError(versionId, sha, 'missing');
  const actual = sha256Hex(bytes);
  if (actual !== sha) throw new ArtifactCorruptError(versionId, sha, actual);
  return { bytes, sha256: sha };
}

// ---------------------------------------------------------------- unpacking

export type UnpackCode = 'zip-slip' | 'symlink' | 'too-large' | 'too-many-files' | 'missing-manifest' | 'bad-path' | 'bad-zip' | 'duplicate';
export class UnpackError extends Error {
  readonly code: UnpackCode;
  constructor(code: UnpackCode, message: string) { super(message); this.name = 'UnpackError'; this.code = code; }
}

interface CdEntry { name: string; mode: number; declared: number; crc: number }

/**
 * Reads only the central directory (names, unix mode, declared size) so the checks that fflate does not
 * expose (symlinks, duplicates, entry count) can run BEFORE anything is inflated. Extraction itself is fflate's.
 */
function readCentralDirectory(b: Uint8Array): CdEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new UnpackError('bad-zip', 'not a zip archive (no end-of-central-directory record)');
  const count = dv.getUint16(eocd + 10, true), size = dv.getUint32(eocd + 12, true);
  let off = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || off === 0xffffffff || size === 0xffffffff) throw new UnpackError('bad-zip', 'zip64 archives are not accepted');
  if (off + size > eocd) throw new UnpackError('bad-zip', 'central directory out of range');
  const out: CdEntry[] = [];
  const td = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || dv.getUint32(off, true) !== 0x02014b50) throw new UnpackError('bad-zip', 'corrupt central directory');
    const crc = dv.getUint32(off + 16, true), declared = dv.getUint32(off + 24, true), nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    const attrs = dv.getUint32(off + 38, true);
    if (off + 46 + nl > b.length) throw new UnpackError('bad-zip', 'corrupt central directory');
    let name: string;
    try { name = td.decode(b.subarray(off + 46, off + 46 + nl)); } catch { throw new UnpackError('bad-path', 'entry name is not valid UTF-8'); }
    out.push({ name, mode: (attrs >>> 16) & 0xffff, declared, crc });
    off += 46 + nl + xl + cl;
  }
  return out;
}

const S_IFMT = 0o170000, S_IFLNK = 0o120000;

function checkEntryPath(rel: string): void {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\') || rel.split('/').includes('..'))
    throw new UnpackError('zip-slip', `unsafe path in archive: ${JSON.stringify(rel)}`);
  const problem = pathProblem(rel);
  if (problem) throw new UnpackError('bad-path', `bad path ${JSON.stringify(rel)}: ${problem}`);
}

/** Reads a package zip into memory. Throws UnpackError (or ManifestError for an invalid manifest). */
export function unpack(bytes: Uint8Array, opts: { maxTotal?: number; maxFiles?: number } = {}): UnpackedPackage {
  const maxTotal = opts.maxTotal ?? MAX_ARTIFACT_BYTES, maxFiles = opts.maxFiles ?? 1000;
  const entries = readCentralDirectory(bytes);
  if (entries.length > maxFiles) throw new UnpackError('too-many-files', `archive has ${entries.length} entries, over the ${maxFiles} limit`);

  const seen = new Set<string>();
  const wanted = new Map<string, CdEntry>();
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
    wanted.set(e.name, e);
  }

  // fflate inflates into a buffer sized by the declared size, so memory is bounded by the (already checked)
  // declared total even if an entry lies; a lying entry comes out truncated, which the CRC-32 check below
  // (and the size re-sum) turns into a rejection. The filter re-checks the sizes it reads itself.
  let filterTotal = 0, raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted.has(f.name)) return false;
        filterTotal += f.originalSize;
        if (filterTotal > maxTotal) throw new UnpackError('too-large', `archive declares more than ${maxTotal} bytes uncompressed`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof UnpackError) throw e;
    throw new UnpackError('bad-zip', `cannot read archive: ${(e as Error).message ?? e}`);
  }

  let actual = 0;
  const files = new Map<string, Uint8Array>();
  let manifestRaw: Uint8Array | undefined;
  for (const [name, data] of Object.entries(raw)) {
    actual += data.byteLength;
    if (crc32(data) !== wanted.get(name)!.crc) throw new UnpackError('bad-zip', `entry ${JSON.stringify(name)} does not match its declared size/CRC (corrupt or lying archive)`);
    if (actual > maxTotal) throw new UnpackError('too-large', `archive inflates to more than ${maxTotal} bytes`);
    if (name === MANIFEST_NAME) manifestRaw = data; else files.set(name, data);
  }
  if (!manifestRaw) throw new UnpackError('missing-manifest', `${MANIFEST_NAME} not found at the package root`);
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRaw)); }
  catch (e) { throw new ManifestError('', `${MANIFEST_NAME} is not valid JSON: ${(e as Error).message}`); }
  return { files, manifest: parseManifest(json) };
}
