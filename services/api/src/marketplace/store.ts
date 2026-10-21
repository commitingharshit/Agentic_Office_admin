// SQL access for the marketplace catalog. No HTTP here. Every function takes a client that already
// runs as ao_app inside withUser() (app.user_id set, '' for an anonymous reader), so row-level security
// decides what is visible: nothing in this file re-implements visibility.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { compareSemver, isRange, satisfies } from './manifest.ts';
import { evaluate, loadEffectivePolicy, type EffectivePolicy } from './policy.ts';
import { buildListQuery, encodeCursor, latestPublished, CAPABILITIES, LIVE_INSTALL, PREVIEW_COUNT, type ListParams } from './search.ts';
import type { InstallState } from './types.ts';

export const INSTALL_STATES: readonly InstallState[] = ['requested', 'permission_review', 'installed', 'configured', 'enabled', 'disabled', 'update_available', 'failed', 'uninstalled'];
export const SCAN_VERDICTS = ['pending', 'clean', 'warnings', 'blocked'] as const;
export const REPORT_REASONS = ['malware', 'copyright', 'broken', 'misleading', 'other'] as const;

/** Distinct, so the handler can answer 404/400 without sniffing messages. */
export class StoreError extends Error {
  readonly status: number;
  /** A stable machine-readable reason (e.g. `version_not_greater`), sent as `code`; `extra` is merged into the body. */
  readonly code?: string;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

export const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;

/** Runs fn as ao_app in a transaction with app.user_id = userId ('' = anonymous: sees public things only). */
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

export interface Stats { ratingAvg: number | null; ratingCount: number; favoriteCount: number; installCount: number }
const statsOf = (r: any): Stats => ({
  ratingAvg: r?.rating_avg === null || r?.rating_avg === undefined ? null : Number(r.rating_avg),
  ratingCount: Number(r?.rating_count ?? 0), favoriteCount: Number(r?.favorite_count ?? 0), installCount: Number(r?.install_count ?? 0),
});
const cardOf = (r: any) => ({
  id: r.id, type: r.type, title: r.title, summary: r.summary, publisher: r.publisher_id, trust: r.trust, visibility: r.visibility,
  latestVersion: r.latest_version ?? null, latestVersionId: r.latest_version_id ?? null, previews: Number(r.previews ?? 0), capabilities: (r.capabilities ?? []) as string[], stats: statsOf(r),
  viewer: { favorited: !!r.favorited, ...(r.installed_version ? { installedVersion: r.installed_version } : {}) },
});

export async function listListings(c: pg.PoolClient, p: ListParams) {
  const { text, values } = buildListQuery(p);
  const rows = (await c.query(text, values)).rows;
  const more = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(cardOf),
    nextPage: more && last ? encodeCursor({ r: last.rank_raw, u: last.updated_raw, id: last.id }) : null,
  };
}

/** A listing is shown when RLS lets the caller see it and it has a published/deprecated version (the owner always sees their own). */
export const SHOWN = `(EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.listing_id = l.id AND v.state IN ('published','deprecated')) OR l.owner_user_id = current_setting('app.user_id', true))`;

export async function listingVisible(c: pg.PoolClient, id: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM marketplace_listings l WHERE l.id = $1 AND ${SHOWN}`, [id])).rowCount === 1;
}

export async function getListing(c: pg.PoolClient, id: string) {
  const r = (await c.query(`
    SELECT l.id, l.type, l.title, l.summary, l.tags, l.publisher_id, l.trust, l.visibility, l.created_at, l.updated_at, l.team_id, l.forked_from, l.forked_from_version, l.forked_base_sha256,
           p.display_name AS publisher_name, p.verified AS publisher_verified,
           lv.id AS lv_id, lv.id AS latest_version_id, ${PREVIEW_COUNT} AS previews, ${CAPABILITIES} AS capabilities, lv.version AS latest_version, lv.scan_verdict, lv.published_at, lv.manifest, lv.sha256, lv.size,
           s.rating_avg, s.rating_count, s.favorite_count, s.install_count,
           EXISTS (SELECT 1 FROM marketplace_favorites f WHERE f.listing_id = l.id) AS favorited,
           (SELECT st.version FROM marketplace_installs i JOIN marketplace_installed_status() st ON st.version_id = i.version_id AND st.listing_id = i.listing_id
             WHERE i.listing_id = l.id AND i.state IN ${LIVE_INSTALL} ORDER BY i.updated_at DESC LIMIT 1) AS installed_version
      FROM marketplace_listings l
      JOIN marketplace_publishers p ON p.id = l.publisher_id
      LEFT JOIN LATERAL ${latestPublished('l.id')} lv ON true
      LEFT JOIN marketplace_listing_stats s ON s.listing_id = l.id
     WHERE l.id = $1 AND ${SHOWN}`, [id])).rows[0];
  if (!r) return undefined;
  const m = r.manifest ?? {};
  const upstream = r.forked_from ? await upstreamOf(c, r) : null;
  return {
    ...cardOf(r),
    teamId: r.team_id ?? null,
    forkedFrom: upstream ? r.forked_from as string : null,
    upstream,
    tags: r.tags, createdAt: r.created_at, updatedAt: r.updated_at,
    publisherInfo: { id: r.publisher_id, displayName: r.publisher_name, verified: r.publisher_verified },
    manifest: r.lv_id ? {
      versionId: r.lv_id, version: r.latest_version, publishedAt: r.published_at, sha256: r.sha256, size: Number(r.size),
      license: m.license ?? null, compat: m.compat ?? {},
      files: Array.isArray(m.files) ? m.files.filter((f: any) => f && typeof f.path === 'string').map((f: any) => ({ path: f.path, sha256: f.sha256, size: f.size })) : [],
      permissions: Array.isArray(m.permissions) ? m.permissions : [], dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
    } : null,
    security: { scanVerdict: r.lv_id ? r.scan_verdict : null },
  };
}

/** What a fork needs to know about its upstream, from versions the CALLER can see only (RLS): undefined latest = no signal. */
async function upstreamOf(c: pg.PoolClient, r: any): Promise<{ listingId: string; latestVersion: string; newerThanBase: boolean } | null> {
  const up = (await c.query(`SELECT lv.version, lv.sha256 FROM marketplace_listings u JOIN LATERAL ${latestPublished('u.id')} lv ON true WHERE u.id = $1`, [r.forked_from])).rows[0];
  if (!up) return null;
  const base = r.forked_from_version ? (await c.query(`SELECT version FROM marketplace_versions WHERE id = $1`, [r.forked_from_version])).rows[0]?.version as string | undefined : undefined;
  // the recorded base version may no longer be visible (withdrawn): fall back to comparing artifact hashes
  const newer = base ? compareSemver(up.version, base) > 0 : up.sha256 !== r.forked_base_sha256;
  return { listingId: r.forked_from as string, latestVersion: up.version as string, newerThanBase: newer };
}

const permKey = (p: { capability?: string; scope?: string }) => `${p.capability}\u0000${p.scope ?? ''}`;
const permsOf = (manifest: any): Array<Record<string, unknown>> => (Array.isArray(manifest?.permissions) ? manifest.permissions.filter((p: any) => p && typeof p === 'object' && typeof p.capability === 'string') : []);

export async function listVersions(c: pg.PoolClient, id: string) {
  const rows = (await c.query(`
    SELECT v.id, v.version, v.state, v.scan_verdict, v.published_at, v.created_at, v.sha256, v.size, v.manifest
      FROM marketplace_versions v
     WHERE v.listing_id = $1   -- RLS: published/deprecated for everyone, every state for the owner
     ORDER BY v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, v.created_at DESC, v.id
     LIMIT 200`, [id])).rows;
  // Newest first. addedPermissions = what this version asks for that the next-older visible version did not, so a client can
  // show "this update adds ..." without downloading both artifacts (the client still recomputes it from the real manifests).
  return rows.map((v, i) => {
    const permissions = permsOf(v.manifest);
    const prev = new Set((rows[i + 1] ? permsOf(rows[i + 1].manifest) : []).map(permKey));
    return {
      id: v.id, version: v.version, state: v.state, scanVerdict: v.scan_verdict, publishedAt: v.published_at, createdAt: v.created_at, sha256: v.sha256, size: Number(v.size),
      permissions, addedPermissions: permissions.filter((p) => !prev.has(permKey(p as any))),
    };
  });
}

/** What a preview/doc request needs from a version, read as the caller (RLS decides whether the row exists). */
export async function versionForView(c: pg.PoolClient, versionId: string) {
  const r = (await c.query(`SELECT v.sha256, v.manifest, v.state, l.visibility FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id WHERE v.id = $1`, [versionId])).rows[0];
  return r ? { sha256: r.sha256 as string, manifest: (r.manifest ?? {}) as Record<string, any>, cacheable: r.state === 'published' && r.visibility === 'public' } : undefined;
}

/** 'ok' | 'gone' (revoked/quarantined, for the owner or someone who installed it) | 'missing'. */
export async function versionAccess(c: pg.PoolClient, versionId: string, signedIn: boolean): Promise<'ok' | 'gone' | 'missing'> {
  const v = (await c.query(`SELECT state FROM marketplace_versions WHERE id = $1`, [versionId])).rows[0];
  if (v) return v.state === 'revoked' || v.state === 'quarantined' ? 'gone' : 'ok';
  if (!signedIn) return 'missing';
  // RLS hides pulled versions from everyone but the owner; an installer is still told it is gone.
  const s = (await c.query(`SELECT 1 FROM marketplace_installed_status() WHERE version_id = $1 AND state IN ('revoked','quarantined')`, [versionId])).rowCount;
  return s ? 'gone' : 'missing';
}

/** True when the version may be downloaded for installation: published or deprecated (RLS already decided that the caller sees it). */
export async function versionInstallable(c: pg.PoolClient, versionId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM marketplace_versions WHERE id = $1 AND state IN ('published','deprecated')`, [versionId])).rowCount === 1;
}

export const REVIEWS_PAGE = 50;
export interface ReviewCursor { t: string; id: string }
export const encodeReviewCursor = (c: ReviewCursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const REVIEW_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export function decodeReviewCursor(s: string): ReviewCursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (c && typeof c.t === 'string' && REVIEW_TIME.test(c.t) && !Number.isNaN(Date.parse(c.t.slice(0, 19) + 'Z')) && typeof c.id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(c.id)) return { t: c.t, id: c.id };
  } catch { /* fall through */ }
  throw new StoreError(400, 'page is not a valid cursor.');
}

/** Newest first, 50 per page with a keyset cursor. The reviewer's identity is never exposed: only whether a review is the caller's own. */
export async function listReviews(c: pg.PoolClient, uid: string, id: string, cursor: ReviewCursor | null = null) {
  const rows = (await c.query(
    `SELECT id, stars, body, created_at, (user_id = $2) AS mine, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_raw
       FROM marketplace_reviews WHERE listing_id = $1
        AND ($3::text IS NULL OR created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id > $4::text))
      ORDER BY created_at DESC, id ASC LIMIT ${REVIEWS_PAGE + 1}`, [id, uid, cursor?.t ?? null, cursor?.id ?? null])).rows;
  const page = rows.slice(0, REVIEWS_PAGE);
  const last = page[page.length - 1];
  return {
    reviews: page.map((r) => ({ stars: Number(r.stars), body: r.body as string | null, createdAt: r.created_at, mine: !!r.mine })),
    nextPage: rows.length > REVIEWS_PAGE && last ? encodeReviewCursor({ t: last.created_raw, id: last.id }) : null,
  };
}

export async function getStats(c: pg.PoolClient, id: string): Promise<Stats> {
  return statsOf((await c.query(`SELECT rating_avg, rating_count, favorite_count, install_count FROM marketplace_listing_stats WHERE listing_id = $1`, [id])).rows[0]);
}

export async function setFavorite(c: pg.PoolClient, uid: string, id: string, on: boolean) {
  if (on) await c.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ($1,$2) ON CONFLICT (listing_id, user_id) DO NOTHING`, [id, uid]);
  else await c.query(`DELETE FROM marketplace_favorites WHERE listing_id = $1 AND user_id = $2`, [id, uid]);
  return { favorited: on, stats: await getStats(c, id) };
}

export async function putReview(c: pg.PoolClient, uid: string, id: string, stars: number, body: string | null) {
  // updated_at is outside ao_app's column grant, so the upsert sets only stars and body.
  await c.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, body) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (listing_id, user_id) DO UPDATE SET stars = excluded.stars, body = excluded.body`, [newId('rev'), id, uid, stars, body]);
  return { review: { stars, body }, stats: await getStats(c, id) };
}
export async function deleteReview(c: pg.PoolClient, uid: string, id: string) {
  await c.query(`DELETE FROM marketplace_reviews WHERE listing_id = $1 AND user_id = $2`, [id, uid]);
  return { review: null, stats: await getStats(c, id) };
}

export async function fileReport(c: pg.PoolClient, uid: string, r: { listingId: string; versionId: string | null; reason: string; details: string | null }) {
  if (r.versionId && !(await c.query(`SELECT 1 FROM marketplace_versions WHERE id = $1 AND listing_id = $2`, [r.versionId, r.listingId])).rowCount) {
    throw new StoreError(404, 'Version not found.');
  }
  // One report per (reporter, listing, reason): a repeat is a no-op that answers with the existing report.
  const ins = await c.query(`INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, version_id, reason, details) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (reporter_user_id, listing_id, reason) DO NOTHING RETURNING id`, [newId('rpt'), r.listingId, uid, r.versionId, r.reason, r.details]);
  if (ins.rows[0]) return { id: ins.rows[0].id as string, created: true };
  const ex = await c.query(`SELECT id FROM marketplace_reports WHERE reporter_user_id = $1 AND listing_id = $2 AND reason = $3`, [uid, r.listingId, r.reason]);
  return { id: ex.rows[0]?.id as string, created: false };
}

export interface InstallItem { listingId: string; versionId: string | null; state: InstallState; enabled: boolean; scanVerdict: string | null; lastError: string | null }
/** One entry per request item: a parsed item, or null when the item failed validation. */
export interface InstallEntry { listingId: string; item: InstallItem | null }
export interface InstallResult { listingId: string; ok: boolean; code?: 'not_found' | 'invalid' | 'rejected' }
export interface InstallUpdate { listingId: string; versionId?: string; installedVersion?: string; latest?: string; state: string; reason?: string; detail?: string; revoked?: true }
/** A team assignment whose pinned version was pulled (revoked or quarantined): reported to every member of the team. */
export interface BlockedAssignment { assignmentId: string; teamId: string; listingId: string; versionId: string; pinnedVersion: string; mode: string; state: string; reason: 'assignment_blocked'; detail?: string }
export const MAX_UPDATES = 500;

export const ERROR_CODES = ['download_failed', 'hash_mismatch', 'blocked_by_scan', 'unsupported_type', 'hermes_failed', 'permission_denied', 'disk_error', 'other'] as const;
/** Strips what must never be stored from a client-supplied error detail: absolute paths, home dirs, tokens. At most 120 characters. */
export function sanitizeErrorDetail(s: string): string {
  const out = s
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\b(?:aod|sk|pk|ghp|gho|xox[abp])_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[path]')
    .replace(/(?:~|\$HOME)(?:\/[^\s"']*)?/g, '[path]')
    .replace(/(?<![\w.])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '[path]')
    .replace(/(?<![\w.])\/(?:Users|home|root|var|tmp|etc|opt|private)\b[^\s"']*/g, '[path]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ').trim();
  return out.length > 120 ? out.slice(0, 117) + '...' : out;
}
/** `code` or `code: detail` with the code from a fixed list; old free text becomes `other: <sanitized text>`. */
export function clampLastError(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  const m = /^([a-z_]+)(?::\s*([\s\S]*))?$/.exec(raw.trim());
  const code = m && (ERROR_CODES as readonly string[]).includes(m[1]) ? m[1] : 'other';
  const detail = sanitizeErrorDetail(m && code === m[1] ? (m[2] ?? '') : raw);
  return detail ? `${code}: ${detail}` : code;
}

async function applyInstall(c: pg.PoolClient, uid: string, deviceId: string, raw: InstallItem) {
  const it = { ...raw, lastError: clampLastError(raw.lastError) };
  const ex = (await c.query(`SELECT id, version_id, state FROM marketplace_installs WHERE user_id = $1 AND device_id = $2 AND listing_id = $3`, [uid, deviceId, it.listingId])).rows[0];
  // a version that is not published (draft, submitted, rejected ...) is never installable, not even by its owner
  if (it.versionId && it.versionId !== ex?.version_id
      && !(await c.query(`SELECT 1 FROM marketplace_versions WHERE id = $1 AND listing_id = $2 AND state IN ('published','deprecated')`, [it.versionId, it.listingId])).rowCount) {
    throw new StoreError(404, `Version ${it.versionId} not found for ${it.listingId}.`);
  }
  if (ex) {
    await c.query(`UPDATE marketplace_installs SET version_id = coalesce($2, version_id), state = $3, enabled = $4, scan_verdict = $5, last_error = $6, updated_at = now() WHERE id = $1`,
      [ex.id, it.versionId, it.state, it.enabled, it.scanVerdict, it.lastError]);
  } else {
    if (!(await c.query(`SELECT 1 FROM marketplace_listings l WHERE l.id = $1 AND ${SHOWN}`, [it.listingId])).rowCount) throw new StoreError(404, `Listing ${it.listingId} not found.`);
    await c.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled, scan_verdict, last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId('ins'), uid, deviceId, it.listingId, it.versionId, it.state, it.enabled, it.scanVerdict, it.lastError]);
  }
  if (!ex || ex.state !== it.state || (it.versionId && it.versionId !== ex.version_id)) {
    await c.query(`INSERT INTO marketplace_install_events(id, user_id, device_id, listing_id, version_id, event, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('ie'), uid, deviceId, it.listingId, it.versionId ?? ex?.version_id ?? null, it.state, JSON.stringify(it.lastError ? { error: it.lastError } : {})]);
  }
}

/**
 * Applies each item inside its own savepoint, so one bad item never blocks the rest, then computes what the
 * device must do from the caller's existing install rows (never from the request). A device that is not the
 * caller's is the only whole-request failure.
 */
export async function syncInstalls(c: pg.PoolClient, uid: string, deviceId: string, entries: InstallEntry[]): Promise<{ results: InstallResult[]; updates: InstallUpdate[]; assignments: BlockedAssignment[] }> {
  if (!(await c.query(`SELECT 1 FROM devices WHERE id = $1 AND user_id = $2`, [deviceId, uid])).rowCount) throw new StoreError(404, 'Unknown device.');
  const results: InstallResult[] = [];
  for (const { listingId, item } of entries) {
    if (!item) { results.push({ listingId, ok: false, code: 'invalid' }); continue; }
    await c.query('SAVEPOINT item');
    try {
      await applyInstall(c, uid, deviceId, item);
      await c.query('RELEASE SAVEPOINT item');
      results.push({ listingId, ok: true });
    } catch (e: any) {
      await c.query('ROLLBACK TO SAVEPOINT item');
      if (e instanceof StoreError) results.push({ listingId, ok: false, code: 'not_found' });
      else if (typeof e?.code === 'string' && /^(22|23|42)/.test(e.code)) results.push({ listingId, ok: false, code: 'rejected' });
      else throw e;
    }
  }
  // What the device should do next, for every live install on it: pulled versions and newer releases.
  const rows = (await c.query(`
    SELECT i.listing_id, i.version_id, i.state AS install_state, st.version AS installed_version, st.state AS version_state, st.reason, lv.version AS latest,
           vis.id AS visible_listing, vis.type AS l_type, vis.publisher_id AS l_publisher, vis.trust AS l_trust, iv.scan_verdict AS v_scan
      FROM marketplace_installs i
      JOIN marketplace_installed_status() st ON st.version_id = i.version_id AND st.listing_id = i.listing_id
      LEFT JOIN marketplace_listings vis ON vis.id = i.listing_id
      LEFT JOIN marketplace_versions iv ON iv.id = i.version_id
      LEFT JOIN LATERAL ${latestPublished('i.listing_id')} lv ON true
     WHERE i.device_id = $1 AND i.user_id = $2 AND i.state IN ${LIVE_INSTALL}
     ORDER BY i.listing_id
     LIMIT ${MAX_UPDATES}`, [deviceId, uid])).rows;
  // Dependencies of what is installed (an agent's skills, a bundle's members): if every version that satisfies a dependency range was
  // pulled, the dependent is reported as revoked too, with the dependency's reason.
  const depProblem = await dependencyProblems(c, rows.filter((r) => r.version_state !== 'revoked' && r.version_state !== 'quarantined').map((r) => r.version_id as string));
  let policy: EffectivePolicy | undefined;
  try { policy = await loadEffectivePolicy(c, uid); } catch { policy = undefined; }   // a policy that cannot be read reports nothing; install-time refuses (fail closed there)
  const updates = rows.flatMap((r): InstallUpdate[] => {
    const base = { listingId: r.listing_id, versionId: r.version_id as string, installedVersion: r.installed_version, ...(r.latest ? { latest: r.latest } : {}) };
    if (r.version_state === 'revoked' || r.version_state === 'quarantined') {
      return [{ ...base, state: 'update_available', reason: r.version_state, ...(r.reason ? { detail: r.reason } : {}), revoked: true }];
    }
    // The caller's own view (row-level security) no longer shows the listing: a team they left, a listing made private again.
    if (!r.visible_listing) return [{ ...base, state: 'access_revoked', reason: 'access_revoked', detail: 'You no longer have access to this item.' }];
    const dep = depProblem.get(r.version_id as string);
    if (dep) return [{ ...base, state: 'update_available', reason: 'dependency_revoked', detail: dep, revoked: true }];
    if (policy) {
      let d: { allowed: boolean; reason?: string };
      try {
        d = evaluate(policy, { listingId: r.listing_id, publisherId: r.l_publisher ?? String(r.listing_id).split('/')[0], type: r.l_type, trust: r.l_trust ?? 'private', scanVerdict: r.v_scan ?? 'pending' });
      } catch (e) { d = { allowed: false, reason: `policy could not be evaluated: ${(e as Error).message}` }; }
      if (!d.allowed) return [{ ...base, state: 'update_available', reason: 'policy', ...(d.reason ? { detail: d.reason.slice(0, 300) } : {}) }];
    }
    if (r.latest && compareSemver(r.latest, r.installed_version) > 0) return [{ ...base, state: 'update_available', reason: 'newer_version' }];
    return [];
  });
  // A device with NO install row for a version it reports (its first sync failed, or it was rejected as not_found) still learns
  // that the version was pulled: the status comes from the versions themselves, not from the install rows.
  const reported = [...new Set(entries.flatMap((e) => (e.item?.versionId ? [e.item.versionId] : [])))];
  if (reported.length) {
    const covered = new Set(updates.filter((u) => u.revoked).map((u) => `${u.listingId}\0${u.versionId}`));
    for (const st of await versionStatuses(c, reported)) {
      if ((st.state !== 'revoked' && st.state !== 'quarantined') || covered.has(`${st.listingId}\0${st.versionId}`)) continue;
      if (!entries.some((e) => e.item?.versionId === st.versionId && e.item.listingId === st.listingId)) continue;
      updates.push({ listingId: st.listingId, versionId: st.versionId, state: st.state, revoked: true, ...(st.reason ? { reason: st.reason } : {}) });
    }
  }
  const blocked = (await c.query(`SELECT assignment_id, team_id, listing_id, version_id, pinned_version, mode, state, reason FROM marketplace_assignment_status() WHERE blocked ORDER BY team_id, listing_id LIMIT 200`)).rows;
  const assignments = blocked.map((a): BlockedAssignment => ({ assignmentId: a.assignment_id, teamId: a.team_id, listingId: a.listing_id, versionId: a.version_id,
    pinnedVersion: a.pinned_version, mode: a.mode, state: a.state, reason: 'assignment_blocked', ...(a.reason ? { detail: String(a.reason).slice(0, 300) } : {}) }));
  return { results, updates, assignments };
}

/** version id -> "dep-listing: reason" for installed versions with a dependency range that no longer has an installable version. */
async function dependencyProblems(c: pg.PoolClient, versionIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!versionIds.length) return out;
  const rows = (await c.query(`SELECT version_id, dep_listing, dep_range, dep_version, dep_state, reason FROM marketplace_dependency_status($1::text[])`, [versionIds.slice(0, 200)])).rows;
  const edges = new Map<string, typeof rows>();
  for (const r of rows) { const k = `${r.version_id}\u0000${r.dep_listing}\u0000${r.dep_range}`; (edges.get(k) ?? edges.set(k, []).get(k)!).push(r); }
  for (const [k, vs] of edges) {
    const [vid] = k.split('\u0000');
    if (out.has(vid)) continue;
    const range = vs[0].dep_range as string;
    if (!isRange(range)) continue;
    const sat = vs.filter((r) => { try { return satisfies(r.dep_version, range); } catch { return false; } });
    if (!sat.length || sat.some((r) => r.dep_state === 'published' || r.dep_state === 'deprecated')) continue;
    const worst = sat.find((r) => r.dep_state === 'revoked') ?? sat[0];
    out.set(vid, `${vs[0].dep_listing}: ${worst.reason ? String(worst.reason).slice(0, 200) : worst.dep_state}`);
  }
  return out;
}

/** Pull state of up to 200 version ids (marketplace_version_status: SECURITY DEFINER, states only). */
export async function versionStatuses(c: pg.PoolClient, ids: string[]): Promise<Array<{ versionId: string; listingId: string; state: string; reason: string | null }>> {
  return (await c.query(`SELECT version_id, listing_id, state, reason FROM marketplace_version_status($1::text[])`, [ids.slice(0, 200)])).rows
    .map((r) => ({ versionId: r.version_id as string, listingId: r.listing_id as string, state: r.state as string, reason: (r.reason as string | null) ?? null }));
}

// ---------------------------------------------------------------- my creations and teams

/** Listings the caller owns, each with the version they uploaded last (any state). */
export async function listMine(c: pg.PoolClient) {
  const rows = (await c.query(`
    SELECT l.id, l.type, l.title, l.summary, l.visibility, l.team_id, l.trust, l.forked_from, l.created_at, l.updated_at,
           lv.id AS vid, lv.version, lv.state, lv.scan_verdict, lv.created_at AS vcreated,
           (SELECT count(*) FROM marketplace_versions x WHERE x.listing_id = l.id) AS versions
      FROM marketplace_listings l
      LEFT JOIN LATERAL (SELECT v.id, v.version, v.state, v.scan_verdict, v.created_at FROM marketplace_versions v WHERE v.listing_id = l.id ORDER BY v.created_at DESC, v.id DESC LIMIT 1) lv ON true
     WHERE l.owner_user_id = current_setting('app.user_id', true)
     ORDER BY l.updated_at DESC, l.id LIMIT 200`)).rows;
  return rows.map((r) => ({
    id: r.id as string, type: r.type as string, title: r.title as string, summary: r.summary as string, visibility: r.visibility as string,
    teamId: (r.team_id ?? null) as string | null, trust: r.trust as string, forkedFrom: (r.forked_from ?? null) as string | null,
    createdAt: r.created_at, updatedAt: r.updated_at, versionCount: Number(r.versions),
    latestVersion: r.vid ? { id: r.vid as string, version: r.version as string, state: r.state as string, scanVerdict: r.scan_verdict as string, installable: r.state === 'published', createdAt: r.vcreated } : null,
  }));
}

/** The caller's role in a team, or undefined when they are not a member (own membership rows only: RLS). */
export async function teamRole(c: pg.PoolClient, teamId: string): Promise<string | undefined> {
  return (await c.query(`SELECT role FROM marketplace_team_members WHERE team_id = $1`, [teamId])).rows[0]?.role;
}

export async function listMyTeams(c: pg.PoolClient) {
  return (await c.query(`SELECT t.id, t.name, m.role, t.created_at FROM marketplace_team_members m JOIN marketplace_teams t ON t.id = m.team_id ORDER BY t.created_at, t.id LIMIT 200`))
    .rows.map((r) => ({ id: r.id as string, name: r.name as string, role: r.role as string, createdAt: r.created_at }));
}
