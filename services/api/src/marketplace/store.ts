// SQL access for the marketplace catalog. No HTTP here. Every function takes a client that already
// runs as ao_app inside withUser() (app.user_id set, '' for an anonymous reader), so row-level security
// decides what is visible: nothing in this file re-implements visibility.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { compareSemver } from './manifest.ts';
import { buildListQuery, encodeCursor, latestPublished, LIVE_INSTALL, type ListParams } from './search.ts';
import type { InstallState } from './types.ts';

export const INSTALL_STATES: readonly InstallState[] = ['requested', 'permission_review', 'installed', 'configured', 'enabled', 'disabled', 'update_available', 'failed', 'uninstalled'];
export const SCAN_VERDICTS = ['pending', 'clean', 'warnings', 'blocked'] as const;
export const REPORT_REASONS = ['malware', 'copyright', 'broken', 'misleading', 'other'] as const;

/** Distinct, so the handler can answer 404/400 without sniffing messages. */
export class StoreError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;

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
  latestVersion: r.latest_version ?? null, stats: statsOf(r),
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
const SHOWN = `(EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.listing_id = l.id AND v.state IN ('published','deprecated')) OR l.owner_user_id = current_setting('app.user_id', true))`;

export async function listingVisible(c: pg.PoolClient, id: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM marketplace_listings l WHERE l.id = $1 AND ${SHOWN}`, [id])).rowCount === 1;
}

export async function getListing(c: pg.PoolClient, id: string) {
  const r = (await c.query(`
    SELECT l.id, l.type, l.title, l.summary, l.tags, l.publisher_id, l.trust, l.visibility, l.created_at, l.updated_at,
           p.display_name AS publisher_name, p.verified AS publisher_verified,
           lv.id AS lv_id, lv.version AS latest_version, lv.scan_verdict, lv.published_at, lv.manifest, lv.sha256, lv.size,
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
  return {
    ...cardOf(r),
    tags: r.tags, createdAt: r.created_at, updatedAt: r.updated_at,
    publisherInfo: { id: r.publisher_id, displayName: r.publisher_name, verified: r.publisher_verified },
    manifest: r.lv_id ? {
      versionId: r.lv_id, version: r.latest_version, publishedAt: r.published_at, sha256: r.sha256, size: Number(r.size),
      license: m.license ?? null, compat: m.compat ?? {},
      permissions: Array.isArray(m.permissions) ? m.permissions : [], dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
    } : null,
    security: { scanVerdict: r.lv_id ? r.scan_verdict : null },
  };
}

export async function listVersions(c: pg.PoolClient, id: string) {
  return (await c.query(`
    SELECT v.id, v.version, v.state, v.scan_verdict, v.published_at, v.created_at, v.sha256, v.size
      FROM marketplace_versions v
     WHERE v.listing_id = $1   -- RLS: published/deprecated for everyone, every state for the owner
     ORDER BY v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, v.created_at DESC, v.id
     LIMIT 200`, [id])).rows.map((v) => ({
    id: v.id, version: v.version, state: v.state, scanVerdict: v.scan_verdict, publishedAt: v.published_at, createdAt: v.created_at, sha256: v.sha256, size: Number(v.size),
  }));
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
export interface InstallUpdate { listingId: string; installedVersion: string; latest?: string; state: string; reason?: string; detail?: string; revoked?: true }
export const MAX_UPDATES = 500;

async function applyInstall(c: pg.PoolClient, uid: string, deviceId: string, it: InstallItem) {
  const ex = (await c.query(`SELECT id, version_id, state FROM marketplace_installs WHERE user_id = $1 AND device_id = $2 AND listing_id = $3`, [uid, deviceId, it.listingId])).rows[0];
  if (it.versionId && it.versionId !== ex?.version_id
      && !(await c.query(`SELECT 1 FROM marketplace_versions WHERE id = $1 AND listing_id = $2`, [it.versionId, it.listingId])).rowCount) {
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
export async function syncInstalls(c: pg.PoolClient, uid: string, deviceId: string, entries: InstallEntry[]): Promise<{ results: InstallResult[]; updates: InstallUpdate[] }> {
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
    SELECT i.listing_id, i.state AS install_state, st.version AS installed_version, st.state AS version_state, st.reason, lv.version AS latest
      FROM marketplace_installs i
      JOIN marketplace_installed_status() st ON st.version_id = i.version_id AND st.listing_id = i.listing_id
      LEFT JOIN LATERAL ${latestPublished('i.listing_id')} lv ON true
     WHERE i.device_id = $1 AND i.user_id = $2 AND i.state IN ${LIVE_INSTALL}
     ORDER BY i.listing_id
     LIMIT ${MAX_UPDATES}`, [deviceId, uid])).rows;
  const updates = rows.flatMap((r): InstallUpdate[] => {
    const base = { listingId: r.listing_id, installedVersion: r.installed_version, ...(r.latest ? { latest: r.latest } : {}) };
    if (r.version_state === 'revoked' || r.version_state === 'quarantined') {
      return [{ ...base, state: 'update_available', reason: r.version_state, ...(r.reason ? { detail: r.reason } : {}), revoked: true }];
    }
    if (r.latest && compareSemver(r.latest, r.installed_version) > 0) return [{ ...base, state: 'update_available', reason: 'newer_version' }];
    return [];
  });
  return { results, updates };
}
