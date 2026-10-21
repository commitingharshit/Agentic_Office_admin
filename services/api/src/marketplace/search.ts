// Query building for the catalog listing: filters validated against the enums, a keyset cursor over
// (rank desc, updated_at desc, id), and one SQL statement. Visibility is NOT decided here: the query
// runs as ao_app with app.user_id set, and row-level security hides what the caller may not see.
import { LISTING_TYPES } from './types.ts';

export class BadQuery extends Error {}

export const TRUSTS = ['official', 'verified', 'community', 'private'] as const;
export const DEFAULT_PAGE = 24, MAX_PAGE = 100;
const PUBLISHER = /^[a-z0-9][a-z0-9-]*$/;

export interface ListParams {
  q: string | null; type: string | null; publisher: string | null; trust: string | null;
  installed: boolean | null; limit: number; cursor: Cursor | null;
  /** 'relevance' (default: text rank, then recency) or 'updated' (recency only, even when q is set). */
  sort: 'relevance' | 'updated';
  /** 'mine': only listings the caller owns (published or not); 'team': listings shared with `team`. */
  scope: 'mine' | 'team' | null; team: string | null;
}
interface Cursor { r: string; u: string; id: string }

export function encodeCursor(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
const CURSOR_RANK = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,17})?(?:e[+-]?\d{1,3})?$/;
// Always UTC with a Z (the query emits it that way), so it never depends on the session time zone.
const CURSOR_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const CURSOR_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
function validRank(r: string): boolean {
  if (!CURSOR_RANK.test(r)) return false;
  const n = Number(r);
  if (!Number.isFinite(n) || n > 1e6) return false;
  // an underflowing literal (0.5e-400) parses to 0 in JS but is out of range for float8
  return n !== 0 || /^0(?:\.0+)?$/.test(r);
}
function validTime(u: string): boolean {
  const m = CURSOR_TIME.exec(u);
  if (!m) return false;
  const year = +m[1];
  if (year < 1970 || year > 2100) return false;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  // Date rolls 2026-02-31 over to March: the round trip must give back the same calendar date and time
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (c && typeof c === 'object' && typeof c.r === 'string' && validRank(c.r) && typeof c.u === 'string' && validTime(c.u)
        && typeof c.id === 'string' && c.id.length <= 200 && CURSOR_ID.test(c.id)) return { r: c.r, u: c.u, id: c.id };
  } catch { /* fall through */ }
  throw new BadQuery('page is not a valid cursor.');
}

export function parseListParams(sp: URLSearchParams): ListParams {
  const one = (k: string) => { const v = sp.get(k); return v === null || v === '' ? null : v; };
  const q = one('q');
  if (q !== null && q.length > 200) throw new BadQuery('q is too long (200 characters at most).');
  const type = one('type');
  if (type !== null && !(LISTING_TYPES as readonly string[]).includes(type)) throw new BadQuery(`type must be one of: ${LISTING_TYPES.join(', ')}.`);
  const trust = one('trust');
  if (trust !== null && !(TRUSTS as readonly string[]).includes(trust)) throw new BadQuery(`trust must be one of: ${TRUSTS.join(', ')}.`);
  const publisher = one('publisher');
  if (publisher !== null && (publisher.length > 80 || !PUBLISHER.test(publisher))) throw new BadQuery('publisher is not a valid publisher id.');
  const inst = one('installed');
  if (inst !== null && inst !== 'true' && inst !== 'false') throw new BadQuery('installed must be true or false.');
  const lim = one('limit');
  let limit = DEFAULT_PAGE;
  if (lim !== null) {
    if (!/^\d{1,4}$/.test(lim) || +lim < 1) throw new BadQuery('limit must be a positive integer.');
    limit = Math.min(+lim, MAX_PAGE);
  }
  const sort = one('sort') ?? 'relevance';
  if (sort !== 'relevance' && sort !== 'updated') throw new BadQuery('sort must be relevance or updated.');
  const page = one('page');
  const scope = one('scope');
  if (scope !== null && scope !== 'mine' && scope !== 'team') throw new BadQuery('scope must be mine or team.');
  const team = one('team');
  if (team !== null && !/^team_[a-f0-9]{18}$/.test(team)) throw new BadQuery('team is not a valid team id.');
  if (scope === 'team' && team === null) throw new BadQuery('scope=team needs a team.');
  if (scope !== 'team' && team !== null) throw new BadQuery('team is only valid with scope=team.');
  return { q, type, publisher, trust, installed: inst === null ? null : inst === 'true', limit, cursor: page === null ? null : decodeCursor(page), sort, scope, team };
}

/** Latest PUBLISHED version of the listing named by SQL expression `listingId`: stable beats pre-release, then highest semver. */
export const latestPublished = (listingId: string) => `(
  SELECT v.id, v.version, v.scan_verdict, v.published_at, v.manifest, v.sha256, v.size, v.compat FROM marketplace_versions v
   WHERE v.listing_id = ${listingId} AND v.state = 'published'
   ORDER BY (v.version LIKE '%-%') ASC, v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, v.published_at DESC, v.id ASC LIMIT 1)`;

/** Number of preview images a template's latest version declares (payload.previews); 0 for anything else. */
export const PREVIEW_COUNT = `(CASE WHEN jsonb_typeof(lv.manifest #> '{payload,previews}') = 'array' THEN jsonb_array_length(lv.manifest #> '{payload,previews}') ELSE 0 END)`;

/** The distinct capability names the latest version declares (manifest.permissions[].capability), sorted; empty for none. */
export const CAPABILITIES = `(SELECT coalesce(array_agg(DISTINCT x.p->>'capability' ORDER BY x.p->>'capability'), '{}') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(lv.manifest->'permissions') = 'array' THEN lv.manifest->'permissions' ELSE '[]'::jsonb END) AS x(p) WHERE jsonb_typeof(x.p) = 'object')`;

/** Live install states: the ones that count as "installed" (same set the counter trigger uses). */
export const LIVE_INSTALL = `('installed','configured','enabled','disabled','update_available')`;

export function buildListQuery(p: ListParams): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const qp = $(p.q);
  const where = [
    p.scope === 'mine' ? `l.owner_user_id = current_setting('app.user_id', true)`
      : `EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.listing_id = l.id AND v.state = 'published')`,
    `(${qp}::text IS NULL OR l.search @@ websearch_to_tsquery('simple', ${qp}::text))`,
  ];
  if (p.scope === 'team') where.push(`l.visibility = 'team' AND l.team_id = ${$(p.team)}`);
  if (p.type) where.push(`l.type = ${$(p.type)}`);
  if (p.trust) where.push(`l.trust = ${$(p.trust)}`);
  if (p.publisher) where.push(`l.publisher_id = ${$(p.publisher)}`);
  if (p.installed !== null) where.push(`${p.installed ? '' : 'NOT '}EXISTS (SELECT 1 FROM marketplace_installs i WHERE i.listing_id = l.id AND i.state IN ${LIVE_INSTALL})`);
  let after = '';
  if (p.cursor) {
    const r = $(p.cursor.r), u = $(p.cursor.u), id = $(p.cursor.id);
    after = `WHERE (b.rank < ${r}::float8 OR (b.rank = ${r}::float8 AND (b.updated_at < ${u}::timestamptz OR (b.updated_at = ${u}::timestamptz AND b.id > ${id}::text))))`;
  }
  const lim = $(p.limit + 1);
  const text = `
    WITH b AS (
      SELECT l.id, l.type, l.title, l.summary, l.publisher_id, l.trust, l.visibility, l.updated_at,
             CASE WHEN ${qp}::text IS NULL${p.sort === 'updated' ? ' OR TRUE' : ''} THEN 0::float8 ELSE ts_rank(l.search, websearch_to_tsquery('simple', ${qp}::text))::float8 END AS rank
        FROM marketplace_listings l WHERE ${where.join(' AND ')})
    SELECT b.id, b.type, b.title, b.summary, b.publisher_id, b.trust, b.visibility,
           b.rank::text AS rank_raw, to_char(b.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_raw,
           lv.version AS latest_version, lv.id AS latest_version_id, ${PREVIEW_COUNT} AS previews, ${CAPABILITIES} AS capabilities,
           s.rating_avg, s.rating_count, s.favorite_count, s.install_count,
           EXISTS (SELECT 1 FROM marketplace_favorites f WHERE f.listing_id = b.id) AS favorited,
           (SELECT st.version FROM marketplace_installs i JOIN marketplace_installed_status() st ON st.version_id = i.version_id AND st.listing_id = i.listing_id
             WHERE i.listing_id = b.id AND i.state IN ${LIVE_INSTALL} ORDER BY i.updated_at DESC LIMIT 1) AS installed_version
      FROM b
      LEFT JOIN LATERAL ${latestPublished('b.id')} lv ON true
      LEFT JOIN marketplace_listing_stats s ON s.listing_id = b.id
      ${after}
     ORDER BY b.rank DESC, b.updated_at DESC, b.id ASC
     LIMIT ${lim}`;
  return { text, values };
}
