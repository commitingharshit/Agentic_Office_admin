import { LISTING_TYPES, type ManifestV1, type PermissionRequest } from './types.ts';

export class ManifestError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ManifestError';
    this.path = path;
  }
}

const CAPABILITIES = ['fs.workspace.read', 'fs.workspace.write', 'network', 'exec.script', 'tool.invoke', 'secrets.use'];
const ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
/** Slugs that would collide with the API's listing sub-routes (/listings/:id/versions, /review, /favorite). */
const RESERVED_SLUGS = new Set(['versions', 'review', 'reviews', 'favorite']);
const reservedSlug = (id: string) => RESERVED_SLUGS.has(id.split('/')[1]);
const NUM = '(0|[1-9]\\d*)';
const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const SEMVER_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`);
// Build metadata (`1.0.0+build`) is deliberately rejected: it is ignored by precedence, so two
// versions differing only in it would be indistinguishable.
const MAX_STR = 2000, MAX_FILES = 1000, MAX_LIST = 100, MAX_PATH = 240;
const HEX64 = /^[0-9a-f]{64}$/;

interface Sv { major: number; minor: number; patch: number; pre: string[] }
function parseSemver(v: string): Sv | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : [];
  const nums = [+m[1], +m[2], +m[3], ...pre.filter(x => /^\d+$/.test(x)).map(Number)];
  if (!nums.every(Number.isSafeInteger)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}
export function isSemver(v: unknown): v is string { return typeof v === 'string' && parseSemver(v) !== null; }

function cmpSv(a: Sv, b: Sv): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`invalid semver: ${x ? b : a}`);
  return cmpSv(x, y);
}

type Cmp = (v: Sv) => boolean;
interface Parsed { test: Cmp; pre: [number, number, number] | null }
const isX = (s: string) => s === 'x' || s === 'X' || s === '*';

/** One whitespace-free comparator, or null if invalid. */
function parseComparator(c: string): Parsed | null {
  if (isX(c)) return { test: () => true, pre: null };
  const op = /^(\^|~|>=|<=|<|>|=)?(.+)$/.exec(c);
  if (!op) return null;
  const [, o = '', rest] = op;
  const full = parseSemver(rest);
  if (full) {
    const pre: Parsed['pre'] = full.pre.length ? [full.major, full.minor, full.patch] : null;
    let test: Cmp;
    switch (o) {
      case '^': {
        const hi: Sv = full.major > 0 ? { major: full.major + 1, minor: 0, patch: 0, pre: ['0'] }
          : full.minor > 0 ? { major: 0, minor: full.minor + 1, patch: 0, pre: ['0'] }
          : { major: 0, minor: 0, patch: full.patch + 1, pre: ['0'] };
        test = v => cmpSv(v, full) >= 0 && cmpSv(v, hi) < 0; break;
      }
      case '~': {
        const hi: Sv = { major: full.major, minor: full.minor + 1, patch: 0, pre: ['0'] };
        test = v => cmpSv(v, full) >= 0 && cmpSv(v, hi) < 0; break;
      }
      case '>=': test = v => cmpSv(v, full) >= 0; break;
      case '<=': test = v => cmpSv(v, full) <= 0; break;
      case '<': test = v => cmpSv(v, full) < 0; break;
      case '>': test = v => cmpSv(v, full) > 0; break;
      default: test = v => cmpSv(v, full) === 0;
    }
    return { test, pre };
  }
  // x-ranges: 1, 1.x, 1.2, 1.2.x (no operator)
  if (o !== '' && o !== '=') return null;
  const parts = rest.split('.');
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (isX(p)) break;
    if (!new RegExp(`^${NUM}$`).test(p) || !Number.isSafeInteger(+p)) return null;
    nums.push(+p);
  }
  if (parts.slice(nums.length).some(p => !isX(p))) return null;
  if (nums.length === 3) return null; // handled by exact above
  return { test: v => nums.every((n, i) => [v.major, v.minor, v.patch][i] === n), pre: null };
}

function parseRange(range: string): Parsed[] | null {
  const parts = range.trim().split(/\s+/);
  if (!parts[0]) return null;
  const out: Parsed[] = [];
  for (const p of parts) { const c = parseComparator(p); if (!c) return null; out.push(c); }
  return out;
}
export function isRange(range: unknown): range is string { return typeof range === 'string' && parseRange(range) !== null; }

/** Subset of npm semver ranges: ^ ~ >= <= < > = exact, x/* ranges, space-separated AND.
 *  A prerelease version satisfies a range only if some comparator names a prerelease on the same
 *  major.minor.patch (npm rule). Unsupported syntax (`||`, hyphen ranges, partial versions with
 *  operators) is an invalid range, so satisfies() is false. */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const r = parseRange(range);
  if (!r) return false;
  if (v.pre.length && !r.some(c => c.pre && c.pre[0] === v.major && c.pre[1] === v.minor && c.pre[2] === v.patch)) return false;
  return r.every(c => c.test(v));
}

function isObj(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function str(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !v) throw new ManifestError(path, 'must be a non-empty string');
  if (v.length > MAX_STR) throw new ManifestError(path, `must be at most ${MAX_STR} characters`);
  return v;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Returns a problem description, or null if the relative path is safe on every platform we ship to. */
export function pathProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'must be a non-empty string';
  if (p.length > MAX_PATH) return `must be at most ${MAX_PATH} characters`;
  if (/[\x00-\x1f\x7f]/.test(p)) return 'must not contain control characters';
  if (p.includes('\\')) return 'must not contain backslashes';
  if (p.startsWith('/')) return 'must be relative';
  for (const seg of p.split('/')) {
    if (seg === '') return 'must not contain empty segments';
    if (seg === '..' || seg === '.') return 'must not contain . or .. segments';
    if (seg.includes(':')) return 'must not contain ":"';
    if (/[. ]$/.test(seg)) return 'segments must not end with "." or a space';
    if (RESERVED.test(seg.split('.')[0])) return 'must not use a reserved device name';
    if (seg.normalize('NFC').toLowerCase() === '.git') return 'must not contain a .git segment';
  }
  return null;
}
function checkPath(p: unknown, path: string) {
  const problem = pathProblem(p);
  if (problem) throw new ManifestError(path, problem);
}

export function parseManifest(raw: unknown): ManifestV1 {
  if (!isObj(raw)) throw new ManifestError('', 'manifest must be an object');
  if (raw.schema !== 'agentic.marketplace/1') throw new ManifestError('schema', "must be 'agentic.marketplace/1'");
  const id = str(raw, 'id', 'id');
  if (!ID_RE.test(id)) throw new ManifestError('id', 'must be publisher/slug, lowercase [a-z0-9-]');
  if (reservedSlug(id)) throw new ManifestError('id', 'the slug must not be versions, review or favorite (reserved)');
  if (!(LISTING_TYPES as readonly unknown[]).includes(raw.type)) throw new ManifestError('type', `must be one of ${LISTING_TYPES.join(', ')}`);
  const version = str(raw, 'version', 'version');
  if (!isSemver(version)) throw new ManifestError('version', 'must be valid semver');
  const title = str(raw, 'title', 'title'), summary = str(raw, 'summary', 'summary'), license = str(raw, 'license', 'license');

  if (!isObj(raw.compat)) throw new ManifestError('compat', 'must be an object');
  const app = str(raw.compat, 'app', 'compat.app');
  if (!isRange(app)) throw new ManifestError('compat.app', 'must be a semver range');
  const compat: ManifestV1['compat'] = { app };
  if (raw.compat.hermes !== undefined) {
    if (!isRange(raw.compat.hermes)) throw new ManifestError('compat.hermes', 'must be a semver range');
    compat.hermes = raw.compat.hermes;
  }

  if (!Array.isArray(raw.dependencies)) throw new ManifestError('dependencies', 'must be an array');
  if (raw.dependencies.length > MAX_LIST) throw new ManifestError('dependencies', `at most ${MAX_LIST} entries`);
  const depSeen = new Set<string>();
  const dependencies = raw.dependencies.map((d: unknown, i) => {
    const p = `dependencies[${i}]`;
    if (!isObj(d)) throw new ManifestError(p, 'must be an object');
    const did = str(d, 'id', `${p}.id`);
    if (!ID_RE.test(did)) throw new ManifestError(`${p}.id`, 'must be publisher/slug');
    if (reservedSlug(did)) throw new ManifestError(`${p}.id`, 'the slug must not be versions, review or favorite (reserved)');
    if (did === id) throw new ManifestError(`${p}.id`, 'a package cannot depend on itself');
    if (depSeen.has(did)) throw new ManifestError(`${p}.id`, `duplicate dependency ${did}`);
    depSeen.add(did);
    const range = str(d, 'range', `${p}.range`);
    if (!isRange(range)) throw new ManifestError(`${p}.range`, 'must be a semver range');
    return { id: did, range };
  });

  if (!Array.isArray(raw.permissions)) throw new ManifestError('permissions', 'must be an array');
  if (raw.permissions.length > MAX_LIST) throw new ManifestError('permissions', `at most ${MAX_LIST} entries`);
  const permissions = raw.permissions.map((q: unknown, i): PermissionRequest => {
    const p = `permissions[${i}]`;
    if (!isObj(q)) throw new ManifestError(p, 'must be an object');
    if (typeof q.capability !== 'string' || !CAPABILITIES.includes(q.capability)) throw new ManifestError(`${p}.capability`, `must be one of ${CAPABILITIES.join(', ')}`);
    return { capability: q.capability as PermissionRequest['capability'], scope: str(q, 'scope', `${p}.scope`), reason: str(q, 'reason', `${p}.reason`) };
  });

  if (!Array.isArray(raw.files)) throw new ManifestError('files', 'must be an array');
  if (raw.files.length > MAX_FILES) throw new ManifestError('files', `at most ${MAX_FILES} entries`);
  const seen = new Set<string>();
  const files = raw.files.map((f: unknown, i) => {
    const p = `files[${i}]`;
    if (!isObj(f)) throw new ManifestError(p, 'must be an object');
    checkPath(f.path, `${p}.path`);
    const path = f.path as string;
    const key = path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new ManifestError(`${p}.path`, `duplicate path ${path} (case/normalization-insensitive)`);
    seen.add(key);
    if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) throw new ManifestError(`${p}.sha256`, 'must be 64 lowercase hex chars');
    if (typeof f.size !== 'number' || !Number.isSafeInteger(f.size) || f.size < 0) throw new ManifestError(`${p}.size`, 'must be a non-negative integer');
    return { path, sha256: f.sha256, size: f.size };
  });

  if (!isObj(raw.payload)) throw new ManifestError('payload', 'must be an object');
  let payload: Record<string, unknown>;
  try { payload = structuredClone(raw.payload); } catch { throw new ManifestError('payload', 'must be plain JSON data'); }
  return { schema: 'agentic.marketplace/1', id, type: raw.type as ManifestV1['type'], version, title, summary, license, compat, dependencies, permissions, files, payload };
}
