// Bundle format v1 (`bundle.json`). A bundle is a list of REFERENCES: exact pinned versions of other listings plus the
// sha256 of each member's published artifact. It carries no member content, no credentials, no documents, no memories.
// Hand-written, fail-closed parser: strict key allowlist, bounded before it is interpreted.
import { isSemver } from '../manifest.ts';
import { LISTING_TYPES, type ListingType } from '../types.ts';
import { checkBounded } from '../validate/advanced-common.ts';
import { findDuplicateKey } from '../blueprint/schema.ts';

export const BUNDLE_SCHEMA = 'agentic.bundle/1' as const;
export const BUNDLE_FILE = 'bundle.json';
export const BUNDLE_LIMITS = { maxItems: 50, maxClosure: 200, maxBytes: 32 * 1024, maxNotes: 2000, maxId: 120, maxTeamId: 64 } as const;
/** Bundles cannot contain bundles: the nesting depth limit is 0 (no cycles, no unbounded closure). */
export const MAX_NESTING_DEPTH = 0;

export interface BundleItem { id: string; type: ListingType; version: string; sha256: string }
export interface BundleV1 {
  schema: typeof BUNDLE_SCHEMA;
  items: BundleItem[];
  installOrder: string[];
  teamScope: { kind: 'none' | 'team'; teamId?: string };
  notes?: string;
}

export class BundleError extends Error {
  readonly path: string; readonly code: string;
  constructor(path: string, code: string, message: string) { super(`${path}: ${message}`); this.name = 'BundleError'; this.path = path; this.code = code; }
}
const fail = (path: string, code: string, message: string): never => { throw new BundleError(path, code, message); };

const ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const RESERVED_SLUGS = new Set(['versions', 'review', 'reviews', 'favorite']);
const HEX64 = /^[0-9a-f]{64}$/;
const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
type Obj = Record<string, unknown>;

export const isListingId = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= BUNDLE_LIMITS.maxId && ID_RE.test(v) && !RESERVED_SLUGS.has(v.split('/')[1]);

function obj(v: unknown, path: string, allowed: readonly string[]): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return fail(path, 'not_object', 'must be an object');
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return fail(path, 'not_plain', 'must be a plain object');
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`.replace(/^\./, ''), 'unknown_key', `unknown key ${JSON.stringify(k.slice(0, 40))}`);
  return o;
}

/** Normal form that makes confusable ids collide: hyphens are removed (`pdf-tool` and `pdftool` are one name to a reader). */
export const confusableKey = (id: string): string => id.replace(/-/g, '');

export function parseBundle(raw: unknown): BundleV1 {
  const b = checkBounded(raw, { maxBytes: BUNDLE_LIMITS.maxBytes, maxDepth: 6, maxKeys: 600 });
  if (!b.ok) fail('', 'unbounded', b.detail ?? 'out of bounds');
  const o = obj(raw, '', ['schema', 'items', 'installOrder', 'teamScope', 'notes']);
  if (o.schema !== BUNDLE_SCHEMA) fail('schema', 'schema', `must be ${BUNDLE_SCHEMA}`);
  if (!Array.isArray(o.items) || o.items.length < 1) fail('items', 'items', 'must be a non-empty array');
  const rawItems = o.items as unknown[];
  if (rawItems.length > BUNDLE_LIMITS.maxItems) fail('items', 'too_many_items', `at most ${BUNDLE_LIMITS.maxItems} items`);
  const seen = new Set<string>(), confusable = new Map<string, string>();
  const items = rawItems.map((it, i): BundleItem => {
    const p = `items[${i}]`;
    const x = obj(it, p, ['id', 'type', 'version', 'sha256']);
    if (!isListingId(x.id)) return fail(`${p}.id`, 'bad_id', 'must be publisher/slug, lowercase [a-z0-9-]');
    if (typeof x.type !== 'string' || !(LISTING_TYPES as readonly string[]).includes(x.type)) return fail(`${p}.type`, 'bad_type', 'unknown listing type');
    if (typeof x.version !== 'string' || !isSemver(x.version)) return fail(`${p}.version`, 'not_pinned', 'must be one exact semver version (no range)');
    if (typeof x.sha256 !== 'string' || !HEX64.test(x.sha256)) return fail(`${p}.sha256`, 'bad_sha256', 'must be 64 lowercase hex characters');
    if (seen.has(x.id)) return fail(`${p}.id`, 'duplicate', `duplicate item ${x.id}`);
    seen.add(x.id);
    const ck = confusableKey(x.id), prior = confusable.get(ck);
    if (prior) return fail(`${p}.id`, 'confusable_id', `${x.id} is confusable with ${prior}`);
    confusable.set(ck, x.id);
    return { id: x.id, type: x.type as ListingType, version: x.version, sha256: x.sha256 };
  });
  if (!Array.isArray(o.installOrder) || o.installOrder.length > BUNDLE_LIMITS.maxItems) fail('installOrder', 'install_order', 'must be an array of item ids');
  const installOrder = (o.installOrder as unknown[]).map((s, i) => (typeof s === 'string' ? s : fail(`installOrder[${i}]`, 'install_order', 'must be a string')));
  const ts = obj(o.teamScope, 'teamScope', ['kind', 'teamId']);
  if (ts.kind !== 'none' && ts.kind !== 'team') fail('teamScope.kind', 'team_scope', "must be 'none' or 'team'");
  if (ts.kind === 'team' && !(typeof ts.teamId === 'string' && TEAM_ID.test(ts.teamId))) fail('teamScope.teamId', 'team_scope', 'a team scope needs a teamId');
  if (ts.kind === 'none' && ts.teamId !== undefined) fail('teamScope.teamId', 'team_scope', 'teamId is only allowed with kind team');
  const teamScope: BundleV1['teamScope'] = ts.kind === 'team' ? { kind: 'team', teamId: ts.teamId as string } : { kind: 'none' };
  if (o.notes !== undefined && (typeof o.notes !== 'string' || o.notes.length > BUNDLE_LIMITS.maxNotes)) fail('notes', 'notes', `must be a string of at most ${BUNDLE_LIMITS.maxNotes} characters`);
  return { schema: BUNDLE_SCHEMA, items, installOrder, teamScope, ...(o.notes !== undefined ? { notes: o.notes as string } : {}) };
}

export function parseBundleText(text: string): BundleV1 {
  if (new TextEncoder().encode(text).length > BUNDLE_LIMITS.maxBytes) fail('', 'too_large', `bundle.json exceeds ${BUNDLE_LIMITS.maxBytes} bytes`);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return fail('', 'json', `not valid JSON: ${(e as Error).message}`); }
  const dup = findDuplicateKey(text);
  if (dup) fail(dup, 'duplicate_key', 'duplicate object key (parsers disagree about which value wins)');
  return parseBundle(raw);
}
