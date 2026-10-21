// Creating, forking, comparing and privately sharing listings. No HTTP here.
//
// Who does what: the OWNER's rights are enforced by row-level security (the listing and the draft version are inserted
// as ao_app inside withUser, so an owner can only ever touch their own rows). The few things ao_app cannot do (register
// the artifact row, create a publisher or a team, set a version's final state and scan verdict, record the release) are
// done by the server through the ao_admin pool, and only after the checks that justify them. The validators and the
// scanner are the registry's (validate/index.ts), the same functions the admin submission path uses.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { openArtifact, putArtifact, rewriteManifest, sha256Hex, unpack, UnpackError, artifactKey, type ArtifactStore } from './artifacts.ts';
import { comparePackages } from './diff.ts';
import { compareSemver, ManifestError } from './manifest.ts';
import { createGate, defaultLimits, type Gate, type Limits } from './limits.ts';
import { latestPublished } from './search.ts';
import { newId, SHOWN, StoreError, withUser } from './store.ts';
import type { ListingType, ManifestV1, UnpackedPackage, ValidationReport } from './types.ts';
import { validateArtifact } from './validate/index.ts';

export const CREATOR_TYPES: readonly ListingType[] = ['skill', 'template'];
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TEAMS_OWNED = 20, MAX_TEAM_MEMBERS = 100;
const INT4 = 2_147_483_647;

export interface CreatorDeps { app: pg.Pool; admin: pg.Pool; store: ArtifactStore; limits: Limits; gate: Gate }
/** The handler builds one of these per process, so the ingest gate is process-wide. */
export function creatorDeps(app: pg.Pool, admin: pg.Pool, store: ArtifactStore, limits: Partial<Limits> = {}): CreatorDeps {
  const l = defaultLimits(limits);
  return { app, admin, store, limits: l, gate: createGate(l.ingestConcurrency, l.ingestQueue) };
}
const COMPARE_MAX_UNPACKED = 32 * 1024 * 1024;

const err = (status: number, code: string, message: string, extra?: Record<string, unknown>) => new StoreError(status, message, code, extra);

async function withAdmin<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/**
 * `u-<user id>` as a publisher id, injective over user ids: an id that is already a plain lowercase slug maps to `u-<id>`;
 * anything else (case, `_`, long ...) maps to `u-<slug>--<hash of the raw id>`. A plain slug never contains `--`, so the two
 * forms cannot meet, and two raw ids with the same slug differ in the hash.
 */
export function publisherIdFor(uid: string): string {
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(uid) && uid.length <= 60) return `u-${uid}`;
  const slug = uid.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `u-${slug}--${sha256Hex(new TextEncoder().encode(uid)).slice(0, 16)}`;
}

// ---------------------------------------------------------------- ingesting a package

export type Outcome = { state: 'published' | 'submitted' | 'rejected'; scan: 'clean' | 'pending' | 'blocked' };
/** Verified and ok: published to its (private) audience. A failed check: rejected. Ok but not verified (no scanner): submitted. */
export function outcomeOf(r: ValidationReport): Outcome {
  if (!r.ok) return { state: 'rejected', scan: 'blocked' };
  return r.verified ? { state: 'published', scan: 'clean' } : { state: 'submitted', scan: 'pending' };
}

export interface Ingested { pkg: UnpackedPackage; bytes: Uint8Array; report: ValidationReport }

/** Unpack (hardened) and validate. Hostile or malformed archives throw a 400 and nothing has been stored. */
export function ingest(d: Pick<CreatorDeps, 'gate'>, bytes: Uint8Array, expectType?: ListingType, precheck?: (m: ManifestV1) => Promise<void>): Promise<Ingested> {
  return d.gate.run(() => ingestNow(bytes, expectType, precheck));
}

// Validation goes through the registry (validate/index.ts), whose skill validator carries the injected scanner: this path and
// the admin submission path share that one registration, nothing here wires or duplicates a scanner.
async function ingestNow(bytes: Uint8Array, expectType?: ListingType, precheck?: (m: ManifestV1) => Promise<void>): Promise<Ingested> {
  let pkg: UnpackedPackage;
  try { pkg = unpack(bytes); }
  catch (e) {
    if (e instanceof UnpackError) throw err(e.code === 'too-large' ? 413 : 400, 'bad_package', `The package was refused: ${e.message}`);
    throw e;
  }
  const type = pkg.manifest.type;
  if (!CREATOR_TYPES.includes(type)) throw err(400, 'type_not_supported', `Only ${CREATOR_TYPES.join(' and ')} packages can be created in this release (this one is ${type}).`);
  if (expectType && type !== expectType) throw err(400, 'manifest_mismatch', `The package is a ${type}, the listing is a ${expectType}.`);
  const parts = pkg.manifest.version.split('-')[0].split('.').map(Number);
  if (parts.some((n) => n > INT4)) throw err(400, 'bad_package', 'A version number component is too large.');
  if (precheck) await precheck(pkg.manifest);   // cheap ownership checks before the (possibly slow) scan
  return { pkg, bytes, report: await validateArtifact(type, pkg) };
}

// ---------------------------------------------------------------- publishers and teams

/** The publisher id the caller may use: one they own, or their own `u-<id>` (created on first use). Otherwise 403. */
export async function ensurePublisher(admin: pg.Pool, uid: string, wanted: string): Promise<string> {
  const owned = async () => (await admin.query(`SELECT 1 FROM marketplace_publishers WHERE id = $1 AND owner_user_id = $2`, [wanted, uid])).rowCount === 1;
  if (await owned()) return wanted;
  if (wanted !== publisherIdFor(uid)) throw err(403, 'publisher_not_owned', 'You do not own that publisher.');
  await admin.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ($1,$1,$2) ON CONFLICT (id) DO NOTHING`, [wanted, uid]);
  if (!(await owned())) throw err(403, 'publisher_not_owned', 'You do not own that publisher.');
  return wanted;
}

export async function requireTeamMember(app: pg.Pool, uid: string, team: string): Promise<void> {
  const role = await withUser(app, uid, async (c) => (await c.query(`SELECT 1 FROM marketplace_team_members WHERE team_id = $1`, [team])).rowCount);
  if (!role) throw err(403, 'not_team_member', 'You are not a member of that team.');
}

// ---------------------------------------------------------------- quotas and cleanup

const quota = (which: string, limit: number, what: string) => err(409, 'quota_exceeded', `Quota exceeded: ${what} (limit ${limit}).`, { quota: which, limit });

/** Counts the caller's own rows (RLS shows owners everything of theirs). `listingId` null = a new listing is being added. */
async function checkQuota(d: CreatorDeps, uid: string, listingId: string | null, addBytes: number): Promise<void> {
  const r = await withUser(d.app, uid, async (c) => ({
    listings: Number((await c.query(`SELECT count(*) n FROM marketplace_listings WHERE owner_user_id = current_setting('app.user_id', true)`)).rows[0].n),
    bytes: Number((await c.query(`SELECT coalesce(sum(v.size), 0) n FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id WHERE l.owner_user_id = current_setting('app.user_id', true)`)).rows[0].n),
    versions: listingId ? Number((await c.query(`SELECT count(*) n FROM marketplace_versions WHERE listing_id = $1`, [listingId])).rows[0].n) : 0,
  }));
  if (listingId === null && r.listings >= d.limits.maxListings) throw quota('listings', d.limits.maxListings, 'too many listings');
  if (listingId !== null && r.versions >= d.limits.maxVersionsPerListing) throw quota('versions', d.limits.maxVersionsPerListing, 'too many versions on this listing');
  if (r.bytes + addBytes > d.limits.maxBytesPerUser) throw quota('bytes', d.limits.maxBytesPerUser, 'too much stored package data');
}

/**
 * Best effort: after a failed insert, drop the artifact row and the blob unless some version still references the sha. A
 * REJECTED version keeps its blob on purpose: the version row references it (and the owner can still diff it); its size
 * counts against the owner's byte quota, which is what bounds garbage.
 */
async function cleanupBlob(d: CreatorDeps, sha256: string): Promise<void> {
  try {
    await d.admin.query(`DELETE FROM marketplace_artifacts a WHERE a.sha256 = $1 AND NOT EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.sha256 = a.sha256)`, [sha256]);
    if (!(await d.admin.query(`SELECT 1 FROM marketplace_artifacts WHERE sha256 = $1`, [sha256])).rowCount) await d.store.delete?.(sha256);
  } catch (e) { console.error(`marketplace: could not clean up orphan artifact ${sha256}:`, e); }
}

// ---------------------------------------------------------------- committing a version

interface NewListing {
  id: string; type: ListingType; publisherId: string; visibility: 'private' | 'team'; teamId: string | null; title: string; summary: string;
  fork?: { from: string; versionId: string; sha256: string };
}
export interface Committed { listingId: string; versionId: string; version: string; state: Outcome['state']; scanVerdict: Outcome['scan']; installable: boolean; validation: ValidationReport }

/**
 * 1. the artifact bytes go to the blob store and the artifact row is registered (admin);
 * 2. as the owner (RLS): `prepare` runs its checks, then the listing (when new) and the DRAFT version are inserted;
 * 3. the server finalizes (admin): state, scan verdict, the scan record, trust 'private' for a new listing, and the
 *    release event. A private audience needs no reviewer, so a verified version is published here; a failed required
 *    check is stored 'rejected'; an unverified one stays 'submitted'. Neither is installable.
 */
async function commit(d: CreatorDeps, uid: string, ing: Ingested, listing: NewListing | { id: string },
  prepare?: (c: pg.PoolClient) => Promise<void>): Promise<Committed> {
  const m = ing.pkg.manifest, out = outcomeOf(ing.report);
  const { sha256, size } = await putArtifact(d.store, ing.bytes);
  await d.admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,$3) ON CONFLICT (sha256) DO NOTHING`, [sha256, size, artifactKey(sha256)]);
  const versionId = newId('ver'), isNew = 'type' in listing;
  const [major, minor, patch] = m.version.split('-')[0].split('.').map(Number);
  try {
    await withUser(d.app, uid, async (c) => {
      if (prepare) await prepare(c);
      if ('type' in listing) {
        await c.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, title, summary, tags, forked_from, forked_from_version, forked_base_sha256)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,$11)`,
          [listing.id, listing.type, listing.publisherId, uid, listing.visibility, listing.teamId, listing.title, listing.summary, listing.fork?.from ?? null, listing.fork?.versionId ?? null, listing.fork?.sha256 ?? null]);
      }
      await c.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, manifest, sha256, size, compat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [versionId, listing.id, m.version, major, minor, patch, JSON.stringify(m), sha256, size, JSON.stringify(m.compat)]);
      for (const dep of m.dependencies) await c.query(`INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) VALUES ($1,$2,$3)`, [versionId, dep.id, dep.range]);
    });
  } catch (e: any) {
    await cleanupBlob(d, sha256);
    if (e?.code === '23505') {
      if (/versions_listing_id_version_key/.test(e.constraint ?? '')) throw err(409, 'version_not_greater', `Version ${m.version} already exists.`);
      throw err(409, 'listing_exists', `${listing.id} already exists.`);
    }
    throw e;
  }
  try {
    await withAdmin(d.admin, async (c) => {
      await c.query(`UPDATE marketplace_versions SET state = $2, scan_verdict = $3 WHERE id = $1`, [versionId, out.state, out.scan]);
      await c.query(`INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict, findings) VALUES ($1,$2,'creator-validation',$3,$4)`,
        [newId('scan'), versionId, out.scan, JSON.stringify(ing.report.checks)]);
      if (isNew) await c.query(`UPDATE marketplace_listings SET trust = 'private' WHERE id = $1`, [listing.id]);
      await c.query(`UPDATE marketplace_listings SET updated_at = now() WHERE id = $1`, [listing.id]);
      if (out.state === 'published') {
        await c.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ($1,$2,'published',$3,$4)`,
          [listing.id, versionId, uid, JSON.stringify({ auto: true, audience: 'owner-or-team' })]);
      }
    });
  } catch (e) {
    // do not leave a half-made draft (or listing) behind
    await d.admin.query(isNew ? `DELETE FROM marketplace_listings WHERE id = $1` : `DELETE FROM marketplace_versions WHERE id = $1 AND state = 'draft'`, [isNew ? listing.id : versionId]).catch(() => {});
    await cleanupBlob(d, sha256);
    throw e;
  }
  return { listingId: listing.id, versionId, version: m.version, state: out.state, scanVerdict: out.scan, installable: out.state === 'published', validation: ing.report };
}

// ---------------------------------------------------------------- the operations

/** Cheap checks that need no body: the visibility ceiling and team membership. The handler runs this BEFORE reading the zip. */
export async function precheckCreate(d: CreatorDeps, uid: string, o: { visibility: 'private' | 'team'; team: string | null }): Promise<void> {
  if (o.visibility === 'team') { if (!o.team) throw err(400, 'team_required', 'team is required when visibility is team.'); await requireTeamMember(d.app, uid, o.team); }
}

export async function createListing(d: CreatorDeps, uid: string, bytes: Uint8Array, o: { visibility: 'private' | 'team'; team: string | null }): Promise<Committed> {
  await precheckCreate(d, uid, o);
  await checkQuota(d, uid, null, bytes.length);
  let publisherId = '';
  const ing = await ingest(d, bytes, undefined, async (mf) => {
    publisherId = await ensurePublisher(d.admin, uid, mf.id.split('/')[0]);
    if ((await d.admin.query(`SELECT 1 FROM marketplace_listings WHERE id = $1`, [mf.id])).rowCount) throw err(409, 'listing_exists', `${mf.id} already exists.`);
  });
  const m = ing.pkg.manifest;
  return commit(d, uid, ing, { id: m.id, type: m.type, publisherId, visibility: o.visibility, teamId: o.visibility === 'team' ? o.team : null, title: m.title, summary: m.summary });
}

/** The listing as its owner may extend it: 404 when invisible, 403 when not theirs or already public. */
async function ownedListing(app: pg.Pool, uid: string, id: string) {
  const l = await withUser(app, uid, async (c) => {
    const row = (await c.query(`SELECT l.id, l.type, l.owner_user_id, l.visibility, l.team_id FROM marketplace_listings l WHERE l.id = $1 AND ${SHOWN}`, [id])).rows[0];
    if (row && row.owner_user_id === uid && row.visibility === 'team')
      row.member = (await c.query(`SELECT 1 FROM marketplace_team_members WHERE team_id = $1`, [row.team_id])).rowCount === 1;
    return row;
  });
  if (!l) throw new StoreError(404, 'Not found.');
  if (l.owner_user_id !== uid) throw err(403, 'not_owner', 'Only the owner can change this listing.');
  if (l.visibility === 'public' || l.visibility === 'org') throw err(403, 'public_requires_review', 'Changes to a public listing go through review.');
  // a team listing is only controlled by someone who is CURRENTLY in the team
  if (l.visibility === 'team' && !l.member) throw err(403, 'not_a_member', 'You are no longer a member of this listing\'s team.');
  return l as { id: string; type: ListingType; visibility: string; team_id: string | null };
}

/** Cheap ownership/state checks, run BEFORE the request body is read. */
export async function checkCanAddVersion(d: CreatorDeps, uid: string, id: string): Promise<void> { await ownedListing(d.app, uid, id); }

export async function addVersion(d: CreatorDeps, uid: string, id: string, bytes: Uint8Array): Promise<Committed> {
  const l = await ownedListing(d.app, uid, id);
  await checkQuota(d, uid, id, bytes.length);
  const ing = await ingest(d, bytes, l.type, async (mf) => { if (mf.id !== id) throw err(400, 'manifest_mismatch', `The package id ${mf.id} is not ${id}.`); });
  const m = ing.pkg.manifest;
  return commit(d, uid, ing, { id }, async (c) => {
    // inside the insert transaction, over every state the owner can see (rejected ones count too)
    await c.query(`SELECT 1 FROM marketplace_listings WHERE id = $1 FOR UPDATE`, [id]);
    for (const r of (await c.query(`SELECT version FROM marketplace_versions WHERE listing_id = $1`, [id])).rows)
      if (compareSemver(m.version, r.version) <= 0) throw err(409, 'version_not_greater', `Version ${m.version} must be greater than ${r.version}.`);
  });
}

export async function setVisibility(d: CreatorDeps, uid: string, id: string, visibility: string, team: string | null): Promise<{ id: string; visibility: string; teamId: string | null }> {
  if (visibility === 'public' || visibility === 'org') throw err(403, 'public_requires_review', 'Public and organization visibility are granted by review.');
  if (visibility !== 'private' && visibility !== 'team') throw err(400, 'bad_visibility', 'visibility must be private or team.');
  if (visibility === 'team' && !team) throw err(400, 'team_required', 'team is required when visibility is team.');
  await ownedListing(d.app, uid, id);
  if (visibility === 'team') await requireTeamMember(d.app, uid, team!);
  const teamId = visibility === 'team' ? team : null;
  await withUser(d.app, uid, (c) => c.query(`UPDATE marketplace_listings SET visibility = $2, team_id = $3 WHERE id = $1`, [id, visibility, teamId]));
  return { id, visibility, teamId };
}

export async function forkListing(d: CreatorDeps, uid: string, id: string, slug: string | null): Promise<{ listingId: string; versionId: string; forkedFrom: string; base: { versionId: string; sha256: string }; state: string; installable: boolean; validation: ValidationReport }> {
  if (slug !== null && !SLUG.test(slug)) throw err(400, 'bad_slug', 'slug must be lowercase letters, digits and hyphens (64 characters at most).');
  const src = await withUser(d.app, uid, async (c) => (await c.query(
    `SELECT l.id, l.type, lv.id AS vid, lv.version, lv.sha256 FROM marketplace_listings l LEFT JOIN LATERAL ${latestPublished('l.id')} lv ON true WHERE l.id = $1 AND ${SHOWN}`, [id])).rows[0]);
  if (!src) throw new StoreError(404, 'Not found.');
  if (!CREATOR_TYPES.includes(src.type)) throw err(400, 'type_not_supported', `A ${src.type} cannot be forked in this release.`);
  if (!src.vid) throw err(409, 'no_published_version', 'There is no published version to fork.');
  const a = await openArtifact(d.app, d.store, { userId: uid }, src.vid);
  if (!a) throw new StoreError(404, 'Not found.');

  // Never trust upstream validation: unpack and validate the bytes as stored, before anything is copied.
  const fail = (report: ValidationReport) => err(422, 'fork_validation_failed', 'The upstream package fails validation and cannot be forked.', { validation: report });
  let up: UnpackedPackage;
  try { up = unpack(a.bytes); } catch (e) { if (e instanceof UnpackError) throw fail({ ok: false, verified: false, checks: [{ name: 'unpack', ok: false, detail: e.message }] }); throw e; }
  const upReport = await validateArtifact(src.type, up);
  if (!upReport.ok) throw fail(upReport);

  const publisherId = await ensurePublisher(d.admin, uid, publisherIdFor(uid));
  const forkId = `${publisherId}/${slug ?? id.split('/')[1]}`;
  if ((await d.admin.query(`SELECT 1 FROM marketplace_listings WHERE id = $1`, [forkId])).rowCount) throw err(409, 'listing_exists', `${forkId} already exists.`);
  const version = up.manifest.version.includes('-') ? `${up.manifest.version}.fork.1` : `${up.manifest.version}-fork.1`;
  let rewritten: Uint8Array;
  try { rewritten = rewriteManifest(up, { id: forkId, version }); }
  catch (e) {
    if (e instanceof UnpackError && e.code === 'too-large') throw err(413, 'too_large', 'The package is too large to fork.');
    if (e instanceof ManifestError) {
      if (e.path === 'id') throw err(400, 'bad_slug', `The fork id is not valid: ${e.message}`);
      if (e.path === 'version') throw err(400, 'bad_version', `The fork version is not valid: ${e.message}`);
      throw err(400, 'bad_package', `The package cannot be forked: ${e.message}`);
    }
    throw e;
  }
  await checkQuota(d, uid, null, rewritten.length);
  const ing = await ingest(d, rewritten, src.type);   // the copy is validated too: this is what gets stored
  if (!ing.report.ok) throw fail(ing.report);
  const m = ing.pkg.manifest;
  const r = await commit(d, uid, ing, { id: forkId, type: src.type, publisherId, visibility: 'private', teamId: null, title: m.title, summary: m.summary,
    fork: { from: id, versionId: src.vid, sha256: src.sha256 } });
  return { listingId: forkId, versionId: r.versionId, forkedFrom: id, base: { versionId: src.vid, sha256: src.sha256 }, state: r.state, installable: r.installable, validation: r.validation };
}

// ---------------------------------------------------------------- compare

export async function compareVersions(d: CreatorDeps, uid: string, id: string, baseId: string | null, headId: string | null) {
  const l = await withUser(d.app, uid, async (c) => (await c.query(
    `SELECT l.forked_from_version, lv.id AS latest FROM marketplace_listings l LEFT JOIN LATERAL ${latestPublished('l.id')} lv ON true WHERE l.id = $1 AND ${SHOWN}`, [id])).rows[0]);
  if (!l) throw new StoreError(404, 'Not found.');
  const base = baseId ?? l.forked_from_version, head = headId ?? l.latest;
  if (!base || !head) throw err(400, 'compare_needs_versions', 'Give base and head version ids (only a fork has defaults).');
  const side = async (vid: string) => {
    const v = await withUser(d.app, uid, async (c) => (await c.query(`SELECT id, listing_id, version, sha256 FROM marketplace_versions WHERE id = $1`, [vid])).rows[0]);
    if (!v) throw new StoreError(404, 'Version not found.');
    const a = await openArtifact(d.app, d.store, { userId: uid }, vid);
    if (!a) throw new StoreError(404, 'Version not found.');
    let pkg: UnpackedPackage;
    try { pkg = unpack(a.bytes, { maxTotal: COMPARE_MAX_UNPACKED }); }
    catch (e) {
      if (e instanceof UnpackError) throw e.code === 'too-large' ? err(413, 'too_large', `Version ${v.version} is too large to compare.`) : err(422, 'unreadable_artifact', `Version ${v.version} cannot be read: ${e.message}`);
      throw e;
    }
    return { info: { versionId: v.id as string, listingId: v.listing_id as string, version: v.version as string, sha256: v.sha256 as string }, pkg };
  };
  const [b, h] = [await side(base), await side(head)];
  const cmp = await comparePackages(b.pkg.files, h.pkg.files);
  const count = (s: string) => cmp.files.filter((f) => f.status === s).length;
  return { listingId: id, base: b.info, head: h.info, summary: { added: count('added'), removed: count('removed'), changed: count('changed'), unchanged: cmp.unchanged }, budgetLimited: cmp.budgetLimited, files: cmp.files };
}

// ---------------------------------------------------------------- teams

export async function createTeam(d: CreatorDeps, uid: string, name: string) {
  return withAdmin(d.admin, async (c) => {
    if (Number((await c.query(`SELECT count(*) n FROM marketplace_teams WHERE owner_user_id = $1`, [uid])).rows[0].n) >= MAX_TEAMS_OWNED) throw err(409, 'too_many_teams', `You can own ${MAX_TEAMS_OWNED} teams at most.`);
    const id = `team_${randomBytes(9).toString('hex')}`;
    await c.query(`INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ($1,$2,$3)`, [id, name, uid]);
    await c.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,$2,'owner')`, [id, uid]);
    return { id, name, role: 'owner' };
  });
}

/** The caller's role, 404 when they are not a member (a team they are not in does not exist for them), 403 when not the owner. */
async function ownerOf(d: CreatorDeps, uid: string, team: string): Promise<void> {
  const role = await withUser(d.app, uid, async (c) => (await c.query(`SELECT role FROM marketplace_team_members WHERE team_id = $1`, [team])).rows[0]?.role as string | undefined);
  if (!role) throw new StoreError(404, 'Not found.');
  if (role !== 'owner') throw err(403, 'owner_only', 'Only the team owner can manage members.');
}

export async function addMember(d: CreatorDeps, uid: string, team: string, userId: string): Promise<{ userId: string; role: string; created: boolean }> {
  await ownerOf(d, uid, team);
  return withAdmin(d.admin, async (c) => {
    if (Number((await c.query(`SELECT count(*) n FROM marketplace_team_members WHERE team_id = $1`, [team])).rows[0].n) >= MAX_TEAM_MEMBERS) throw err(409, 'team_full', `A team has ${MAX_TEAM_MEMBERS} members at most.`);
    // an unknown user id is a foreign-key violation (23503); one uniform answer for it
    const r = await c.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT (team_id, user_id) DO NOTHING RETURNING role`, [team, userId])
      .catch((e: any) => { throw e?.code === '23503' ? err(404, 'unknown_user', 'No such user.') : e; });
    return { userId, role: r.rows[0]?.role ?? (await c.query(`SELECT role FROM marketplace_team_members WHERE team_id = $1 AND user_id = $2`, [team, userId])).rows[0].role, created: r.rowCount === 1 };
  });
}

/** Moves every team listing `userId` owns back to private, in the caller's transaction: the team keeps no foreign-controlled content. */
const demoteListings = (c: pg.PoolClient, team: string, userId: string) =>
  c.query(`UPDATE marketplace_listings SET visibility = 'private', team_id = NULL, updated_at = now() WHERE team_id = $1 AND owner_user_id = $2`, [team, userId]);

/**
 * The owner removes anyone; a member may remove only themself (leave). The owner cannot leave while other members exist
 * (`transfer_ownership_first`) and cannot leave an empty-of-others team either (`last_owner`). Whoever goes, the team
 * listings they own are demoted to private in the same transaction.
 */
export async function removeMember(d: CreatorDeps, uid: string, team: string, userId: string): Promise<void> {
  const role = await withUser(d.app, uid, async (c) => (await c.query(`SELECT role FROM marketplace_team_members WHERE team_id = $1`, [team])).rows[0]?.role as string | undefined);
  if (!role) throw new StoreError(404, 'Not found.');
  if (role !== 'owner' && userId !== uid) throw err(403, 'owner_only', 'Only the team owner can remove other members.');
  await withAdmin(d.admin, async (c) => {
    const t = (await c.query(`SELECT role FROM marketplace_team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`, [team, userId])).rows[0];
    if (!t) throw new StoreError(404, 'Member not found.');
    if (t.role === 'owner') {
      const others = Number((await c.query(`SELECT count(*) n FROM marketplace_team_members WHERE team_id = $1 AND user_id <> $2`, [team, userId])).rows[0].n);
      throw others > 0 ? err(409, 'transfer_ownership_first', 'Transfer ownership before leaving the team.') : err(409, 'last_owner', 'The last owner cannot leave the team.');
    }
    await demoteListings(c, team, userId);
    await c.query(`DELETE FROM marketplace_team_members WHERE team_id = $1 AND user_id = $2`, [team, userId]);
  });
}

/** The owner hands the team to an existing member (single-owner model: the former owner becomes a member). */
export async function transferOwner(d: CreatorDeps, uid: string, team: string, userId: string): Promise<{ owner: string }> {
  await ownerOf(d, uid, team);
  await withAdmin(d.admin, async (c) => {
    if (!(await c.query(`SELECT 1 FROM marketplace_team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`, [team, userId])).rowCount) throw err(404, 'unknown_member', 'That user is not a member of the team.');
    await c.query(`UPDATE marketplace_team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [team, uid]);
    await c.query(`UPDATE marketplace_team_members SET role = 'owner' WHERE team_id = $1 AND user_id = $2`, [team, userId]);
    await c.query(`UPDATE marketplace_teams SET owner_user_id = $2 WHERE id = $1`, [team, userId]);
  });
  return { owner: userId };
}

/** Members see ids and roles only. A non-member gets 404. */
export async function getTeam(d: CreatorDeps, uid: string, team: string) {
  const mine = await withUser(d.app, uid, async (c) => (await c.query(`SELECT t.name, m.role FROM marketplace_team_members m JOIN marketplace_teams t ON t.id = m.team_id WHERE m.team_id = $1`, [team])).rows[0]);
  if (!mine) throw new StoreError(404, 'Not found.');
  const members = (await d.admin.query(`SELECT user_id, role FROM marketplace_team_members WHERE team_id = $1 ORDER BY created_at, user_id`, [team])).rows;
  return { id: team, name: mine.name as string, role: mine.role as string, members: members.map((r) => ({ userId: r.user_id as string, role: r.role as string })) };
}
