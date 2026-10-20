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
const NUM = '(0|[1-9]\\d*)';
const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const SEMVER_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?$`);
const HEX64 = /^[0-9a-f]{64}$/;

interface Sv { major: number; minor: number; patch: number; pre: string[] }
function parseSemver(v: string): Sv | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
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
interface Parsed { test: Cmp; pre: boolean }
const isX = (s: string) => s === 'x' || s === 'X' || s === '*';

/** One whitespace-free comparator, or null if invalid. */
function parseComparator(c: string): Parsed | null {
  if (isX(c)) return { test: () => true, pre: false };
  const op = /^(\^|~|>=|<=|<|>|=)?(.+)$/.exec(c);
  if (!op) return null;
  const [, o = '', rest] = op;
  const full = parseSemver(rest);
  if (full) {
    const pre = full.pre.length > 0;
    let test: Cmp;
    switch (o) {
      case '^': {
        const hi: Sv = full.major > 0 ? { major: full.major + 1, minor: 0, patch: 0, pre: [] }
          : full.minor > 0 ? { major: 0, minor: full.minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: full.patch + 1, pre: [] };
        test = v => cmpSv(v, full) >= 0 && cmpSv(v, hi) < 0; break;
      }
      case '~': {
        const hi: Sv = { major: full.major, minor: full.minor + 1, patch: 0, pre: [] };
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
    if (!new RegExp(`^${NUM}$`).test(p)) return null;
    nums.push(+p);
  }
  if (parts.slice(nums.length).some(p => !isX(p))) return null;
  if (nums.length === 3) return null; // handled by exact above
  return { test: v => nums.every((n, i) => [v.major, v.minor, v.patch][i] === n), pre: false };
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
 *  A prerelease version only satisfies a range that itself names a prerelease. */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const r = parseRange(range);
  if (!r) return false;
  if (v.pre.length && !r.some(c => c.pre)) return false;
  return r.every(c => c.test(v));
}

function isObj(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function str(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== 'string' || !v) throw new ManifestError(path, 'must be a non-empty string');
  return v;
}

function checkPath(p: unknown, path: string) {
  if (typeof p !== 'string' || !p) throw new ManifestError(path, 'must be a non-empty string');
  if (p.includes('\\')) throw new ManifestError(path, 'must not contain backslashes');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) throw new ManifestError(path, 'must be relative');
  for (const seg of p.split('/')) {
    if (seg === '' ) throw new ManifestError(path, 'must not contain empty segments');
    if (seg === '..' || seg === '.') throw new ManifestError(path, 'must not contain . or .. segments');
  }
}

export function parseManifest(raw: unknown): ManifestV1 {
  if (!isObj(raw)) throw new ManifestError('', 'manifest must be an object');
  if (raw.schema !== 'agentic.marketplace/1') throw new ManifestError('schema', "must be 'agentic.marketplace/1'");
  const id = str(raw, 'id', 'id');
  if (!ID_RE.test(id)) throw new ManifestError('id', 'must be publisher/slug, lowercase [a-z0-9-]');
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
  const dependencies = raw.dependencies.map((d: unknown, i) => {
    const p = `dependencies[${i}]`;
    if (!isObj(d)) throw new ManifestError(p, 'must be an object');
    const did = str(d, 'id', `${p}.id`);
    if (!ID_RE.test(did)) throw new ManifestError(`${p}.id`, 'must be publisher/slug');
    const range = str(d, 'range', `${p}.range`);
    if (!isRange(range)) throw new ManifestError(`${p}.range`, 'must be a semver range');
    return { id: did, range };
  });

  if (!Array.isArray(raw.permissions)) throw new ManifestError('permissions', 'must be an array');
  const permissions = raw.permissions.map((q: unknown, i): PermissionRequest => {
    const p = `permissions[${i}]`;
    if (!isObj(q)) throw new ManifestError(p, 'must be an object');
    if (typeof q.capability !== 'string' || !CAPABILITIES.includes(q.capability)) throw new ManifestError(`${p}.capability`, `must be one of ${CAPABILITIES.join(', ')}`);
    return { capability: q.capability as PermissionRequest['capability'], scope: str(q, 'scope', `${p}.scope`), reason: str(q, 'reason', `${p}.reason`) };
  });

  if (!Array.isArray(raw.files)) throw new ManifestError('files', 'must be an array');
  const seen = new Set<string>();
  const files = raw.files.map((f: unknown, i) => {
    const p = `files[${i}]`;
    if (!isObj(f)) throw new ManifestError(p, 'must be an object');
    checkPath(f.path, `${p}.path`);
    const path = f.path as string;
    if (seen.has(path)) throw new ManifestError(`${p}.path`, `duplicate path ${path}`);
    seen.add(path);
    if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) throw new ManifestError(`${p}.sha256`, 'must be 64 lowercase hex chars');
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) throw new ManifestError(`${p}.size`, 'must be a non-negative integer');
    return { path, sha256: f.sha256, size: f.size };
  });

  if (!isObj(raw.payload)) throw new ManifestError('payload', 'must be an object');
  return { schema: 'agentic.marketplace/1', id, type: raw.type as ManifestV1['type'], version, title, summary, license, compat, dependencies, permissions, files, payload: raw.payload };
}
