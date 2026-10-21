// The marketplace admin API (/admin/marketplace/*): publishing, review, lifecycle, moderation, installs and
// analytics. Every route runs: authenticate admin -> check permission -> do the work -> write admin_audit, the
// audit row in the SAME transaction as the change. Everything runs as ao_admin (the `admin` pool); no SQL here
// interpolates a client value. Authentication is admin.ts's (`authenticate`, handed in); the role comes from
// `roleOf` (see permissions.ts: until the control-plane rbac.ts lands, every authenticated admin is a superadmin,
// exactly as admin.ts treats them today). Denied requests change nothing and are not audited.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { artifactKey, putArtifact, UnpackError, unpack, MAX_ARTIFACT_BYTES, type ArtifactStore } from '../marketplace/artifacts.ts';
import { can, type AdminRole, type MarketplacePermission } from '../marketplace/permissions.ts';
import { LIVE_INSTALL, latestPublished } from '../marketplace/search.ts';
import { INSTALL_STATES } from '../marketplace/store.ts';
import { TYPE_POLICY, maxTier, trustAtLeast } from '../marketplace/support.ts';
import { LISTING_TYPES, type ListingType, type ValidationReport, type UnpackedPackage, type VersionState, type Visibility } from '../marketplace/types.ts';
import { validateArtifact } from '../marketplace/validate/index.ts';

export interface MarketplaceAdminDeps {
  /** ao_admin. The only pool this module touches. */
  admin: pg.Pool;
  /** admin.ts's authenticate: resolves the bearer token to an admin id, or throws an error with a `status` (401/403). */
  authenticate(req: IncomingMessage): Promise<string>;
  /** The acting admin's role. FAILS CLOSED: without it every admin is an 'analyst' (read-only) until roles are configured (AO_MARKETPLACE_ROLES in main.ts). */
  roleOf?(adminId: string): AdminRole | Promise<AdminRole>;
  store: ArtifactStore;
  /** Validation with the real injected scanner/renderers; defaults to the global registry (validate/index.ts). */
  validate?(type: ListingType, pkg: UnpackedPackage): Promise<ValidationReport>;
  /** Package upload cap in bytes, enforced while reading; default 64 MiB. */
  maxSubmissionBytes?: number;
  /** False while the skill scanner is unavailable (startup self-check): skill submissions answer 503 scanner_unavailable. */
  scannerOk?: () => boolean;
}

export class ApiError extends Error {
  readonly status: number; readonly code: string; readonly extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) => new ApiError(status, code, message, extra);

// ───────────────────────────────────────────── the lifecycle state machine

export const ACTIONS = ['claim', 'approve', 'reject', 'publish', 'deprecate', 'quarantine', 'revoke'] as const;
export type Action = typeof ACTIONS[number];

/** The ONLY place version transitions are decided. Throws 409 invalid_transition for anything not listed. */
export function transition(from: VersionState, action: Action): VersionState {
  let to: VersionState | undefined;
  switch (action) {
    case 'claim': if (from === 'submitted') to = 'in_review'; break;
    case 'approve': if (from === 'submitted' || from === 'in_review') to = 'approved'; break;
    case 'reject': if (from === 'submitted' || from === 'in_review' || from === 'approved') to = 'rejected'; break;
    case 'publish': if (from === 'approved') to = 'published'; break;
    case 'deprecate': if (from === 'published') to = 'deprecated'; break;
    case 'quarantine': if (from === 'published' || from === 'approved' || from === 'deprecated') to = 'quarantined'; break;
    // any non-draft state; the pre-submission states (draft, validating, testing) have nothing to revoke, and revoked is final
    case 'revoke': if (!['draft', 'validating', 'testing', 'revoked'].includes(from)) to = 'revoked'; break;
  }
  if (!to) throw fail(409, 'invalid_transition', `Cannot ${action} a version that is ${from}.`);
  return to;
}
const ACTION_PERMISSION: Record<Action, MarketplacePermission> = {
  claim: 'marketplace.review', approve: 'marketplace.review', reject: 'marketplace.review', publish: 'marketplace.review',
  deprecate: 'marketplace.write', quarantine: 'marketplace.moderate', revoke: 'marketplace.moderate',
};
const EVENT: Record<Action, string> = { claim: 'claimed', approve: 'approved', reject: 'rejected', publish: 'published', deprecate: 'deprecated', quarantine: 'quarantined', revoke: 'revoked' };
const NEEDS_REASON: ReadonlySet<Action> = new Set(['reject', 'quarantine', 'revoke']);
const NEEDS_SCAN: ReadonlySet<Action> = new Set(['approve', 'publish']);

// ───────────────────────────────────────────── small validators and helpers

const LISTING_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const PUBLISHER_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_JSON = 64 * 1024;
export const MAX_SUBMISSION_BYTES = MAX_ARTIFACT_BYTES;   // 64 MiB, enforced while reading
export const PAGE_DEFAULT = 50, PAGE_MAX = 100;
const VISIBILITIES: readonly Visibility[] = ['public', 'org', 'team', 'private'];
const VERSION_STATES: readonly VersionState[] = ['draft', 'validating', 'testing', 'submitted', 'in_review', 'approved', 'published', 'rejected', 'deprecated', 'quarantined', 'revoked'];
const REPORT_STATES = ['open', 'triaged', 'actioned', 'dismissed'] as const;
const TRUSTS = ['official', 'verified', 'community'] as const;
const NOT_COLLECTED = ['invocations', 'workflow_completions', 'first_use_activation'];
const USER_NOTE = 'User emails and display names are not returned here: this API exposes user ids only (the users.read permission does not exist in this build).';

const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
const oneOf = <T extends string>(v: string | null, allowed: readonly T[], what: string): T | null => {
  if (v === null || v === '') return null;
  if (!(allowed as readonly string[]).includes(v)) throw fail(400, 'bad_request', `${what} must be one of: ${allowed.join(', ')}.`);
  return v as T;
};
const idParam = (v: string | null, re: RegExp, what: string): string | null => {
  if (v === null || v === '') return null;
  if (v.length > 200 || !re.test(v)) throw fail(400, 'bad_request', `${what} is not valid.`);
  return v;
};
function reasonOf(v: unknown, required: boolean): string | null {
  if (v === undefined || v === null || v === '') { if (required) throw fail(400, 'reason_required', 'A reason is required.'); return null; }
  if (typeof v !== 'string' || !v.trim()) throw fail(400, required ? 'reason_required' : 'bad_request', 'reason must be a non-empty string.');
  if (v.length > 1000) throw fail(400, 'bad_request', 'reason is too long (1000 characters at most).');
  return v.trim();
}
function day(v: string | null, what: string): string | null {
  if (v === null || v === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw fail(400, 'bad_request', `${what} must be a date like 2026-10-21.`);
  return v;
}
const clip = (s: unknown, n = 2000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);

async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw fail(413, 'too_large', `The package is over the ${max} byte limit.`);
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw fail(413, 'too_large', `The package is over the ${max} byte limit.`);   // cap enforced while reading
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const b = await readBytes(req, MAX_JSON);
  if (!b.length) return {};
  let d: unknown;
  try { d = JSON.parse(b.toString('utf8')); } catch { throw fail(400, 'bad_request', 'Body is not JSON.'); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw fail(400, 'bad_request', 'Body must be a JSON object.');
  return d as Record<string, unknown>;
}

// Keyset cursor {u: UTC timestamp, id}: strict, so a forged page can never reach SQL as anything but a valid pair.
const CURSOR_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const encodeCursor = (u: string, id: string) => Buffer.from(JSON.stringify({ u, id })).toString('base64url');
function decodeCursor(s: string | null, idRe: RegExp): { u: string; id: string } | null {
  if (s === null || s === '') return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    const m = typeof c?.u === 'string' ? CURSOR_TIME.exec(c.u) : null;
    if (m && +m[1] >= 1970 && +m[1] <= 2100 && new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString().slice(0, 19) === `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
        && typeof c.id === 'string' && c.id.length <= 200 && idRe.test(c.id)) return { u: c.u, id: c.id };
  } catch { /* fall through */ }
  throw fail(400, 'bad_request', 'page is not a valid cursor.');
}
const UTC = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function pageSize(sp: URLSearchParams): number {
  const v = sp.get('limit');
  if (v === null || v === '') return PAGE_DEFAULT;
  if (!/^\d{1,4}$/.test(v) || +v < 1) throw fail(400, 'bad_request', 'limit must be a positive integer.');
  return Math.min(+v, PAGE_MAX);
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

type Client = pg.PoolClient;
/** One client runs one statement at a time: run the thunks in order (Promise.all on a single client queues them with a deprecation warning). */
const series = async <T>(fns: Array<() => Promise<T>>): Promise<T[]> => { const out: T[] = []; for (const f of fns) out.push(await f()); return out; };
const semverParts = (v: string) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)!; return [+m[1], +m[2], +m[3]]; };

// ───────────────────────────────────────────── the handler

export function marketplaceAdminHandler(deps: MarketplaceAdminDeps) {
  const validate = deps.validate ?? validateArtifact;
  const pool = deps.admin;

  async function tx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
  const audit = (c: Client, adminId: string, action: string, target: string | null, detail: Record<string, unknown>) =>
    c.query('INSERT INTO admin_audit(admin_user_id, action, target_user_id, detail) VALUES ($1,$2,$3,$4)', [adminId, `marketplace.${action}`, target, JSON.stringify(detail)]);
  /** A read: the query and its audit row share one transaction. */
  const read = <T>(adminId: string, action: string, target: string | null, detail: Record<string, unknown>, fn: (c: Client) => Promise<T>) =>
    tx(async (c) => { const r = await fn(c); await audit(c, adminId, action, target, detail); return r; });

  async function ensureUser(c: Client, id: string) {
    await c.query('INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [id]);
  }
  /** Trust a new listing of this publisher starts with: community unless the publisher is verified (or already has official listings). */
  async function publisherTrust(c: Client, publisherId: string): Promise<'official' | 'verified' | 'community'> {
    const p = (await c.query('SELECT verified FROM marketplace_publishers WHERE id = $1', [publisherId])).rows[0];
    if (!p?.verified) return 'community';
    const o = await c.query(`SELECT 1 FROM marketplace_listings WHERE publisher_id = $1 AND trust = 'official' LIMIT 1`, [publisherId]);
    return o.rowCount ? 'official' : 'verified';
  }

  // ── submissions
  /** What a reviewer acknowledges: a stable hash over exactly what the version asks for. Computed server side from the stored manifest and artifact hash. */
  function summaryHash(manifest: any, artifactSha: string, tier: string | null): string {
    const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
    const perms = Array.isArray(manifest?.permissions) ? [...manifest.permissions].map(canon).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1) : [];
    return createHash('sha256').update(JSON.stringify(canon({ schema: 'agentic.marketplace.review-summary/1', id: manifest?.id, type: manifest?.type, version: manifest?.version,
      artifact: artifactSha, riskTier: tier, permissions: perms, dependencies: canon(manifest?.dependencies ?? []), payload: canon(manifest?.payload ?? {}) }))).digest('hex');
  }
  async function submit(adminId: string, role: AdminRole, req: IncomingMessage, sp: URLSearchParams) {
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/zip') throw fail(415, 'unsupported_media_type', 'Send the package as application/zip.');
    // A submission never changes an EXISTING listing's visibility (that is the publish action's job, after review). For a NEW listing
    // only a reviewer may ask for public/org; everyone else gets private or team.
    const canReview = can(role, 'marketplace.review');
    const visibility = oneOf(sp.get('visibility'), VISIBILITIES, 'visibility') ?? (canReview ? 'public' : 'private');
    if ((visibility === 'public' || visibility === 'org') && !canReview) throw fail(403, 'forbidden', 'Your role cannot create a public listing; submit it private or team and have a reviewer publish it.');
    const wantPublisher = idParam(sp.get('publisher'), PUBLISHER_ID, 'publisher');
    const teamId = idParam(sp.get('team'), OPAQUE_ID, 'team');
    if (visibility === 'team' && !teamId) throw fail(400, 'bad_request', 'visibility=team needs team=<id>.');
    const bytes = new Uint8Array(await readBytes(req, deps.maxSubmissionBytes ?? MAX_SUBMISSION_BYTES));
    if (!bytes.length) throw fail(400, 'bad_request', 'The package is empty.');
    let pkg: UnpackedPackage;
    try { pkg = unpack(bytes); }
    catch (e) {
      if (e instanceof UnpackError) throw fail(e.code === 'too-large' ? 413 : 400, `package_${e.code}`, e.message);
      throw e;
    }
    const m = pkg.manifest;
    const publisherId = m.id.split('/')[0];
    if (wantPublisher && wantPublisher !== publisherId) throw fail(400, 'publisher_mismatch', `The manifest id belongs to publisher ${publisherId}, not ${wantPublisher}.`);
    if (m.type === 'skill' && deps.scannerOk && !deps.scannerOk()) throw fail(503, 'scanner_unavailable', 'Skill submissions are paused: the package security scanner is unavailable on this server.');
    const report = await validate(m.type, pkg);
    const verified = report.verified === true && report.ok;
    const state: VersionState = report.ok ? 'submitted' : 'rejected';
    const verdict = !report.ok ? 'blocked' : verified ? 'clean' : 'pending';
    const policy = TYPE_POLICY[m.type];
    const riskTier = maxTier(policy?.riskTier ?? 'executable', report.riskTier ?? 'data');
    const stored = await putArtifact(deps.store, bytes);   // content addressed; the bytes never reach a log or an audit row
    const versionId = newId('ver');
    const [major, minor, patch] = semverParts(m.version);

    try {
      await tx(async (c) => {
        // serialize submissions of the same listing id (two first submissions of a new id would otherwise race on the listing insert)
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [m.id]);
        const ex = (await c.query('SELECT type, owner_user_id, visibility FROM marketplace_listings WHERE id = $1 FOR UPDATE', [m.id])).rows[0];
        if (ex && ex.type !== m.type) throw fail(409, 'type_mismatch', `${m.id} already exists as a ${ex.type}, not a ${m.type}.`);
        let owner: string;
        if (ex) owner = ex.owner_user_id;
        else {
          let pub = (await c.query('SELECT owner_user_id FROM marketplace_publishers WHERE id = $1', [publisherId])).rows[0];
          if (!pub) {
            // Separation of duties / anti-squatting: only a superadmin creates a publisher, and only for a package that validated.
            // (An auto-rejected package under an unknown publisher is not recorded: it would need a publisher row to hang on.)
            if (role !== 'superadmin' || !report.ok) {
              throw fail(400, 'unknown_publisher', role !== 'superadmin' ? `Publisher ${publisherId} does not exist; only a superadmin can create one.` : `Publisher ${publisherId} does not exist and the package failed validation.`,
                { validation: { ok: report.ok, verified, checks: report.checks } });
            }
            await ensureUser(c, SYSTEM_USER);
            await c.query('INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ($1,$2,$3,false) ON CONFLICT (id) DO NOTHING', [publisherId, publisherId, SYSTEM_USER]);
            pub = { owner_user_id: (await c.query('SELECT owner_user_id FROM marketplace_publishers WHERE id = $1', [publisherId])).rows[0].owner_user_id };
          }
          owner = pub.owner_user_id;
          // a publisher below the type's minimum trust cannot open a listing of that type (checked for a package that validated)
          if (report.ok && !trustAtLeast(await publisherTrust(c, publisherId), policy?.minPublisherTrust ?? 'official')) {
            throw fail(403, 'publisher_trust_insufficient', `${m.type} listings need a ${policy?.minPublisherTrust ?? 'official'} publisher; ${publisherId} is not.`);
          }
          if (teamId && !(await c.query('SELECT 1 FROM marketplace_teams WHERE id = $1', [teamId])).rowCount) throw fail(404, 'not_found', 'Unknown team.');
          await c.query(
            `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, trust, title, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            // Trust is only ever derived from the publisher row (verified/official), which only a superadmin can create or change
            // (POST publishers; new publishers start unverified). A submission can therefore never raise its own trust.
            [m.id, m.type, publisherId, owner, visibility, visibility === 'team' ? teamId : null, await publisherTrust(c, publisherId), m.title, m.summary]);
        }
        await c.query('INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,$3) ON CONFLICT (sha256) DO NOTHING', [stored.sha256, stored.size, artifactKey(stored.sha256)]);
        await c.query(
          `INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, compat, scan_verdict, risk_tier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [versionId, m.id, m.version, major, minor, patch, state, JSON.stringify(m), stored.sha256, stored.size, JSON.stringify(m.compat), verdict, riskTier]);
        for (const d of m.dependencies) await c.query('INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) VALUES ($1,$2,$3)', [versionId, d.id, d.range]);
        const checks = report.checks.map((k) => ({ name: k.name, ok: k.ok, skipped: k.skipped === true, required: k.required === true, ...(k.detail ? { detail: clip(k.detail) } : {}) }));
        for (const k of checks) {
          await c.query('INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict, findings) VALUES ($1,$2,$3,$4,$5)',
            [newId('scn'), versionId, k.name.slice(0, 120), !k.ok ? 'blocked' : k.skipped ? 'pending' : 'clean', JSON.stringify([k])]);
        }
        await c.query('INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict, findings) VALUES ($1,$2,$3,$4,$5)',
          [newId('scn'), versionId, OVERALL, verdict, JSON.stringify({ ok: report.ok, verified, checks })]);
        await c.query(`INSERT INTO marketplace_submissions(id, version_id, submitted_by, state, notes, decided_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [newId('sub'), versionId, owner, state, report.ok ? null : 'Rejected automatically: a required validation check failed.', report.ok ? null : new Date()]);
        await c.query('INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ($1,$2,$3,$4,$5)',
          [m.id, versionId, 'submitted', adminId, JSON.stringify({ state, ok: report.ok, verified, sha256: stored.sha256 })]);
        if (!report.ok) {
          await c.query('INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ($1,$2,$3,$4,$5)',
            [m.id, versionId, 'rejected', adminId, JSON.stringify({ reason: 'automatic: validation failed', failed: report.checks.filter((k) => !k.ok).map((k) => k.name) })]);
        }
        await audit(c, adminId, 'submit', null, { listingId: m.id, versionId, version: m.version, type: m.type, state, ok: report.ok, verified, sha256: stored.sha256, size: stored.size, visibility: ex ? ex.visibility : visibility });
      });
    } catch (e: any) {
      if (e?.code === '23505' && e?.constraint === 'marketplace_versions_listing_id_version_key') throw fail(409, 'version_exists', `${m.id} ${m.version} already exists.`);
      throw e;
    }
    return { status: 201, body: { listingId: m.id, versionId, state, riskTier, manualReview: policy?.manualReview ?? true, ...(report.ok && (policy?.manualReview ?? true) ? { summarySha256: summaryHash(m, stored.sha256, riskTier) } : {}), validation: { ok: report.ok, verified, checks: report.checks } } };
  }

  // ── lifecycle
  async function latestScan(c: Client, versionId: string) {
    return (await c.query(`SELECT verdict, findings FROM marketplace_security_scans WHERE version_id = $1 AND scanner = $2 ORDER BY at DESC, id DESC LIMIT 1`, [versionId, OVERALL])).rows[0];
  }
  async function requireScan(c: Client, versionId: string) {
    const s = await latestScan(c, versionId);
    if (!s) throw fail(409, 'scan_required', 'This version has no security scan on record.');
    if (s.findings?.ok !== true || s.verdict === 'blocked') throw fail(409, 'scan_failed', 'The latest security scan failed.');
    if (s.findings?.verified !== true) throw fail(409, 'scan_required', 'The latest scan is not verified (a required check, such as the skill security scan, did not run).');
  }
  async function act(adminId: string, role: AdminRole, versionId: string, action: Action, body: Record<string, unknown>) {
    const reason = reasonOf(body.reason, NEEDS_REASON.has(action));
    return tx(async (c) => {
      const v = (await c.query('SELECT id, listing_id, version, state, manifest, sha256, risk_tier FROM marketplace_versions WHERE id = $1 FOR UPDATE', [versionId])).rows[0];
      if (!v) throw fail(404, 'not_found', 'No such version.');
      const to = transition(v.state, action);
      // A type that needs manual review (unknown types count as needing it): NO role is exempt from separation of duties, and the
      // reviewer must acknowledge the exact permission summary the server computes from the stored version.
      const manual = TYPE_POLICY[v.manifest?.type as ListingType]?.manualReview ?? true;
      if (manual && (action === 'approve' || action === 'publish')) {
        const sub = (await c.query(`SELECT actor FROM marketplace_release_events WHERE version_id = $1 AND event = 'submitted' ORDER BY id LIMIT 1`, [versionId])).rows[0];
        const owner = (await c.query(`SELECT l.owner_user_id FROM marketplace_listings l WHERE l.id = $1`, [v.listing_id])).rows[0]?.owner_user_id;
        if (!sub || sub.actor === adminId || owner === adminId) throw fail(403, 'separation_of_duties', 'A version that needs manual review cannot be approved or published by its own submitter or publisher, whatever their role.');
      }
      let ack: string | undefined;
      if (manual && action === 'approve') {
        const want = summaryHash(v.manifest, v.sha256, v.risk_tier ?? null);
        const got = typeof body.ack_summary_sha256 === 'string' ? body.ack_summary_sha256.toLowerCase() : '';
        if (got !== want) throw fail(409, 'summary_ack_required', 'Approve with ack_summary_sha256 set to the permission summary hash of this exact version.', { expectedSummarySha256: want });
        ack = want;
      }
      if (!manual && (action === 'approve' || action === 'publish') && role !== 'superadmin') {
        // separation of duties: whoever submitted a version cannot approve or publish it (a superadmin can)
        const sub = (await c.query(`SELECT actor FROM marketplace_release_events WHERE version_id = $1 AND event = 'submitted' ORDER BY id LIMIT 1`, [versionId])).rows[0];
        if (sub?.actor === adminId) throw fail(409, 'self_review', 'You submitted this version; another admin must approve and publish it.');
      }
      if (NEEDS_SCAN.has(action)) await requireScan(c, versionId);
      try { await c.query('UPDATE marketplace_versions SET state = $2 WHERE id = $1', [versionId, to]); }
      catch (e: any) { if (typeof e?.code === 'string' && e.code.startsWith('23')) throw fail(409, 'invalid_transition', 'The database refused that transition (the version is immutable once published).'); throw e; }
      let madePublic = false;
      if (action === 'publish') {
        // the listing shows what the newly published version says about itself
        await c.query('UPDATE marketplace_listings SET title = $2, summary = $3, updated_at = now() WHERE id = $1', [v.listing_id, v.manifest?.title ?? '', v.manifest?.summary ?? '']);
        if (body.visibility !== undefined) {
          if (body.visibility !== 'public') throw fail(400, 'bad_request', 'visibility, when given on publish, must be "public".');
          // The ONLY way an existing listing becomes public. Every version that people can install from it must have been through an admin's
          // approval: a creator's auto-published (private-audience) versions have not, and would be exposed unreviewed.
          const l = (await c.query('SELECT visibility, publisher_id FROM marketplace_listings WHERE id = $1 FOR UPDATE', [v.listing_id])).rows[0];
          if (l.visibility !== 'public') {
            const unreviewed = (await c.query(`
              SELECT v2.id FROM marketplace_versions v2 WHERE v2.listing_id = $1 AND v2.state IN ('published','deprecated')
                 AND NOT EXISTS (SELECT 1 FROM marketplace_release_events e WHERE e.version_id = v2.id AND e.event = 'approved' AND e.actor IS NOT NULL AND e.actor <> 'auto')
               ORDER BY v2.id`, [v.listing_id])).rows.map((r) => r.id as string);
            if (unreviewed.length) throw fail(409, 'unreviewed_versions', 'Some published versions of this listing were never reviewed by an admin; approve or quarantine them before making the listing public.', { versionIds: unreviewed });
            await c.query(`UPDATE marketplace_listings SET visibility = 'public', team_id = NULL, trust = $2, updated_at = now() WHERE id = $1`, [v.listing_id, await publisherTrust(c, l.publisher_id)]);
            madePublic = true;
          }
        }
      }
      const subState = action === 'claim' ? 'in_review' : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null;
      if (subState) {
        await c.query(`UPDATE marketplace_submissions SET state = $2::text, decided_at = CASE WHEN $2::text = 'in_review' THEN NULL ELSE now() END, notes = coalesce($3, notes)
                       WHERE version_id = $1 AND state IN ('submitted','in_review','approved')`, [versionId, subState, reason]);
      }
      await c.query('INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ($1,$2,$3,$4,$5)',
        [v.listing_id, versionId, EVENT[action], adminId, JSON.stringify({ reason, from: v.state, to, ...(ack ? { ackSummarySha256: ack } : {}) })]);
      await audit(c, adminId, action, null, { listingId: v.listing_id, versionId, version: v.version, from: v.state, to, reason, ...(madePublic ? { madePublic: true } : {}) });
      return { versionId, listingId: v.listing_id, state: to };
    });
  }

  /** Re-validates the STORED bytes with the configured scanner and writes a fresh 'validation' scan row, so a creator version left 'submitted' (no scanner at upload) can be approved. */
  async function rescan(adminId: string, versionId: string) {
    const v = (await pool.query('SELECT id, listing_id, state, sha256, manifest FROM marketplace_versions WHERE id = $1', [versionId])).rows[0];
    if (!v) throw fail(404, 'not_found', 'No such version.');
    if (!['submitted', 'in_review', 'approved'].includes(v.state)) throw fail(409, 'invalid_state', `Cannot rescan a version that is ${v.state}.`);
    const type = v.manifest?.type as ListingType;
    if (type === 'skill' && deps.scannerOk && !deps.scannerOk()) throw fail(503, 'scanner_unavailable', 'The package security scanner is unavailable on this server.');
    const bytes = await deps.store.get(v.sha256);
    if (!bytes) throw fail(409, 'artifact_missing', 'The stored artifact is missing.');
    let pkg: UnpackedPackage;
    try { pkg = unpack(bytes); } catch (e) { if (e instanceof UnpackError) throw fail(409, 'artifact_unreadable', e.message); throw e; }
    const report = await validate(type, pkg);
    const verified = report.verified === true && report.ok;
    const verdict = !report.ok ? 'blocked' : verified ? 'clean' : 'pending';
    const checks = report.checks.map((k) => ({ name: k.name, ok: k.ok, skipped: k.skipped === true, required: k.required === true, ...(k.detail ? { detail: clip(k.detail) } : {}) }));
    return tx(async (c) => {
      const cur = (await c.query('SELECT state FROM marketplace_versions WHERE id = $1 FOR UPDATE', [versionId])).rows[0];
      if (!cur || cur.state !== v.state) throw fail(409, 'invalid_state', 'The version changed while it was being rescanned.');
      await c.query('INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict, findings) VALUES ($1,$2,$3,$4,$5)',
        [newId('scn'), versionId, OVERALL, verdict, JSON.stringify({ ok: report.ok, verified, checks })]);
      await c.query('UPDATE marketplace_versions SET scan_verdict = $2 WHERE id = $1', [versionId, verdict]);
      await audit(c, adminId, 'rescan', null, { listingId: v.listing_id, versionId, ok: report.ok, verified, verdict });
      return { versionId, listingId: v.listing_id, state: v.state as string, validation: { ok: report.ok, verified, checks: report.checks } };
    });
  }

  // ── reads
  async function catalog(adminId: string, sp: URLSearchParams) {
    const type = oneOf(sp.get('type'), LISTING_TYPES, 'type');
    const visibility = oneOf(sp.get('visibility'), VISIBILITIES, 'visibility');
    const state = oneOf(sp.get('state'), VERSION_STATES, 'state');
    const publisher = idParam(sp.get('publisher'), PUBLISHER_ID, 'publisher');
    const q = sp.get('q')?.trim() || null;
    if (q !== null && q.length > 200) throw fail(400, 'bad_request', 'q is too long (200 characters at most).');
    const cur = decodeCursor(sp.get('page'), LISTING_ID);
    const limit = pageSize(sp);
    const values: unknown[] = [];
    const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
    const where: string[] = [];
    if (type) where.push(`l.type = ${$(type)}`);
    if (visibility) where.push(`l.visibility = ${$(visibility)}`);
    if (publisher) where.push(`l.publisher_id = ${$(publisher)}`);
    if (state) where.push(`lv.state = ${$(state)}`);
    if (q) { const a = $(q), b = $(`%${likeEscape(q.toLowerCase())}%`); where.push(`(l.search @@ websearch_to_tsquery('simple', ${a}::text) OR lower(l.id) LIKE ${b} OR lower(l.title) LIKE ${b})`); }
    if (cur) { const u = $(cur.u), id = $(cur.id); where.push(`(l.updated_at < ${u}::timestamptz OR (l.updated_at = ${u}::timestamptz AND l.id > ${id}::text))`); }
    const lim = $(limit + 1);
    return read(adminId, 'list_catalog', null, { q, type, visibility, publisher, state }, async (c) => {
      const rows = (await c.query(`
        SELECT l.id, l.title, l.type, l.publisher_id, l.visibility, l.trust, l.updated_at, ${UTC('l.updated_at')} AS updated_raw,
               lv.id AS latest_version_id, lv.version AS latest_version, lv.state AS version_state, lv.scan_verdict,
               (SELECT count(*) FROM marketplace_installs i WHERE i.listing_id = l.id AND i.state IN ${LIVE_INSTALL})::int AS installs,
               (SELECT count(*) FROM marketplace_installs i WHERE i.listing_id = l.id AND i.state IN ${LIVE_INSTALL} AND i.enabled)::int AS active_installs,
               s.rating_avg, s.rating_count
          FROM marketplace_listings l
          LEFT JOIN LATERAL (SELECT v.id, v.version, v.state, v.scan_verdict FROM marketplace_versions v WHERE v.listing_id = l.id
                              ORDER BY (v.version LIKE '%-%') ASC, v.semver_major DESC, v.semver_minor DESC, v.semver_patch DESC, v.created_at DESC, v.id ASC LIMIT 1) lv ON true
          LEFT JOIN marketplace_listing_stats s ON s.listing_id = l.id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY l.updated_at DESC, l.id ASC LIMIT ${lim}`, values)).rows;
      const page = rows.slice(0, limit), last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id, name: r.title, type: r.type, publisher: r.publisher_id, visibility: r.visibility, trust: r.trust, state: r.version_state ?? null,
          latestVersion: r.latest_version ?? null, latestVersionId: r.latest_version_id ?? null, installs: r.installs, activeInstalls: r.active_installs,
          ratingAvg: r.rating_avg === null ? null : Number(r.rating_avg), ratingCount: Number(r.rating_count ?? 0), updatedAt: r.updated_at, scanVerdict: r.scan_verdict ?? null,
        })),
        nextPage: rows.length > limit && last ? encodeCursor(last.updated_raw, last.id) : null,
      };
    });
  }

  async function versionDetail(adminId: string, id: string) {
    return read(adminId, 'view_version', null, { versionId: id }, async (c) => {
      const v = (await c.query(`SELECT id, listing_id, version, state, scan_verdict, sha256, size, compat, manifest, created_at, published_at FROM marketplace_versions WHERE id = $1`, [id])).rows[0];
      if (!v) throw fail(404, 'not_found', 'No such version.');
      const [scans, events, deps_, sub] = await series([
        () => c.query(`SELECT id, scanner, verdict, findings, at FROM marketplace_security_scans WHERE version_id = $1 ORDER BY at ASC, id ASC`, [id]),
        () => c.query(`SELECT id::text, event, actor, detail, at FROM marketplace_release_events WHERE version_id = $1 ORDER BY at ASC, id ASC`, [id]),
        () => c.query(`SELECT depends_on_listing AS id, range FROM marketplace_dependencies WHERE version_id = $1 ORDER BY 1`, [id]),
        () => c.query(`SELECT id, state, notes, created_at, decided_at FROM marketplace_submissions WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
      ]);
      const overall = scans.rows.filter((s) => s.scanner === OVERALL).pop();
      return {
        id: v.id, listingId: v.listing_id, version: v.version, state: v.state, scanVerdict: v.scan_verdict, sha256: v.sha256, size: Number(v.size), compat: v.compat,
        manifest: v.manifest, createdAt: v.created_at, publishedAt: v.published_at,
        validation: overall ? { ok: overall.findings?.ok === true, verified: overall.findings?.verified === true, verdict: overall.verdict } : null,
        scans: scans.rows.map((s) => ({ id: s.id, scanner: s.scanner, verdict: s.verdict, findings: s.findings, at: s.at })),
        events: events.rows, dependencies: deps_.rows, submission: sub.rows[0] ?? null,
      };
    });
  }

  async function queue(adminId: string, sp: URLSearchParams) {
    const state = oneOf(sp.get('state'), ['submitted', 'in_review'] as const, 'state');
    return read(adminId, 'list_submissions', null, { state }, async (c) => {
      const rows = (await c.query(`
        SELECT v.id, v.listing_id, v.version, v.state, v.scan_verdict, v.created_at, v.manifest, v.sha256, v.risk_tier, l.title, l.type, l.publisher_id,
               (SELECT s.findings FROM marketplace_security_scans s WHERE s.version_id = v.id AND s.scanner = $2 ORDER BY s.at DESC, s.id DESC LIMIT 1) AS overall
          FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
         WHERE v.state = ANY($1::text[]) ORDER BY v.created_at ASC, v.id ASC LIMIT ${PAGE_MAX}`, [state ? [state] : ['submitted', 'in_review'], OVERALL])).rows;
      return { items: rows.map((r) => ({ versionId: r.id, listingId: r.listing_id, name: r.title, type: r.type, publisher: r.publisher_id, version: r.version, state: r.state,
        scanVerdict: r.scan_verdict, verified: r.overall?.verified === true, submittedAt: r.created_at, riskTier: r.risk_tier ?? null,
        ...((TYPE_POLICY[r.type as ListingType]?.manualReview ?? true) ? { manualReview: true, summarySha256: summaryHash(r.manifest, r.sha256, r.risk_tier ?? null) } : {}) })) };
    });
  }

  const installSelect = `
    SELECT i.id, i.user_id, i.device_id, i.listing_id, i.version_id, v.version, v.state AS version_state, i.state, i.enabled, i.scan_verdict, i.last_error, i.scope,
           i.installed_at, i.updated_at, ${UTC('i.updated_at')} AS updated_raw
      FROM marketplace_installs i LEFT JOIN marketplace_versions v ON v.id = i.version_id`;
  const installOf = (r: any) => ({ id: r.id, userId: r.user_id, deviceId: r.device_id, listingId: r.listing_id, versionId: r.version_id, version: r.version ?? null,
    versionState: r.version_state ?? null, state: r.state, enabled: r.enabled, scanVerdict: r.scan_verdict, lastError: r.last_error, scope: r.scope, installedAt: r.installed_at, updatedAt: r.updated_at });

  async function installations(adminId: string, sp: URLSearchParams) {
    const user = idParam(sp.get('user'), OPAQUE_ID, 'user');
    const listing = idParam(sp.get('listing'), LISTING_ID, 'listing');
    const state = oneOf(sp.get('state'), INSTALL_STATES, 'state');
    const cur = decodeCursor(sp.get('page'), OPAQUE_ID);
    const limit = pageSize(sp);
    const values: unknown[] = [];
    const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
    const where: string[] = [];
    if (user) where.push(`i.user_id = ${$(user)}`);
    if (listing) where.push(`i.listing_id = ${$(listing)}`);
    if (state) where.push(`i.state = ${$(state)}`);
    if (cur) { const u = $(cur.u), id = $(cur.id); where.push(`(i.updated_at < ${u}::timestamptz OR (i.updated_at = ${u}::timestamptz AND i.id > ${id}::text))`); }
    const lim = $(limit + 1);
    return read(adminId, 'list_installations', user, { user, listing, state }, async (c) => {
      const rows = (await c.query(`${installSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.updated_at DESC, i.id ASC LIMIT ${lim}`, values)).rows;
      const page = rows.slice(0, limit), last = page[page.length - 1];
      return { items: page.map(installOf), nextPage: rows.length > limit && last ? encodeCursor(last.updated_raw, last.id) : null, note: USER_NOTE };
    });
  }

  async function userInstalls(adminId: string, userId: string) {
    return read(adminId, 'view_user_installs', userId, { userId }, async (c) => {
      if (!(await c.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) throw fail(404, 'not_found', 'No such user.');
      const [inst, fav, rev, teams] = await series([
        () => c.query(`${installSelect} WHERE i.user_id = $1 ORDER BY i.updated_at DESC, i.id ASC LIMIT 500`, [userId]),
        () => c.query(`SELECT listing_id, created_at FROM marketplace_favorites WHERE user_id = $1 ORDER BY created_at DESC, listing_id LIMIT 500`, [userId]),
        () => c.query(`SELECT id, listing_id, stars, body, created_at FROM marketplace_reviews WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 200`, [userId]),
        () => c.query(`SELECT team_id, role FROM marketplace_team_members WHERE user_id = $1 ORDER BY team_id`, [userId]),
      ]);
      return {
        userId, items: inst.rows.map(installOf),
        favorites: fav.rows.map((r) => ({ listingId: r.listing_id, createdAt: r.created_at })),
        reviews: rev.rows.map((r) => ({ id: r.id, listingId: r.listing_id, stars: r.stars, body: r.body, createdAt: r.created_at })),
        teams: teams.rows.map((r) => ({ teamId: r.team_id, role: r.role })),
        note: USER_NOTE,
      };
    });
  }

  async function reviews(adminId: string, sp: URLSearchParams) {
    const listing = idParam(sp.get('listing'), LISTING_ID, 'listing');
    const cur = decodeCursor(sp.get('page'), OPAQUE_ID);
    const limit = pageSize(sp);
    const values: unknown[] = [];
    const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
    const where: string[] = [];
    if (listing) where.push(`r.listing_id = ${$(listing)}`);
    if (cur) { const u = $(cur.u), id = $(cur.id); where.push(`(r.created_at < ${u}::timestamptz OR (r.created_at = ${u}::timestamptz AND r.id > ${id}::text))`); }
    const lim = $(limit + 1);
    return read(adminId, 'list_reviews', null, { listing }, async (c) => {
      const rows = (await c.query(`SELECT r.id, r.listing_id, r.user_id, r.stars, r.body, r.created_at, r.updated_at, ${UTC('r.created_at')} AS created_raw
        FROM marketplace_reviews r ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id ASC LIMIT ${lim}`, values)).rows;
      const page = rows.slice(0, limit), last = page[page.length - 1];
      return { items: page.map((r) => ({ id: r.id, listingId: r.listing_id, userId: r.user_id, stars: r.stars, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at })),
        nextPage: rows.length > limit && last ? encodeCursor(last.created_raw, last.id) : null, note: USER_NOTE };
    });
  }

  async function deleteReview(adminId: string, id: string) {
    return tx(async (c) => {
      const r = (await c.query('SELECT id, listing_id, user_id, stars, body FROM marketplace_reviews WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw fail(404, 'not_found', 'No such review.');
      await c.query('DELETE FROM marketplace_reviews WHERE id = $1', [id]);
      // a hard delete (the schema has no soft delete), so the audit row keeps what is needed to prove what was removed: never the text itself
      await audit(c, adminId, 'delete_review', r.user_id, { reviewId: id, listingId: r.listing_id, stars: r.stars,
        bodySha256: r.body == null ? null : createHash('sha256').update(r.body).digest('hex'), bodyLength: r.body == null ? 0 : r.body.length });
      return { deleted: true, id };
    });
  }

  async function reports(adminId: string, sp: URLSearchParams) {
    const state = oneOf(sp.get('state'), REPORT_STATES, 'state');
    const cur = decodeCursor(sp.get('page'), OPAQUE_ID);
    const limit = pageSize(sp);
    const values: unknown[] = [];
    const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
    const where: string[] = [];
    if (state) where.push(`r.state = ${$(state)}`);
    if (cur) { const u = $(cur.u), id = $(cur.id); where.push(`(r.created_at < ${u}::timestamptz OR (r.created_at = ${u}::timestamptz AND r.id > ${id}::text))`); }
    const lim = $(limit + 1);
    return read(adminId, 'list_reports', null, { state }, async (c) => {
      const rows = (await c.query(`SELECT r.id, r.listing_id, r.reporter_user_id, r.version_id, r.reason, r.details, r.state, r.created_at, r.resolved_at, ${UTC('r.created_at')} AS created_raw
        FROM marketplace_reports r ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.id ASC LIMIT ${lim}`, values)).rows;
      const page = rows.slice(0, limit), last = page[page.length - 1];
      return { items: page.map((r) => ({ id: r.id, listingId: r.listing_id, reporterUserId: r.reporter_user_id, versionId: r.version_id, reason: r.reason, details: r.details,
        state: r.state, createdAt: r.created_at, resolvedAt: r.resolved_at })), nextPage: rows.length > limit && last ? encodeCursor(last.created_raw, last.id) : null, note: USER_NOTE };
    });
  }

  async function resolveReport(adminId: string, id: string, body: Record<string, unknown>) {
    const to = oneOf(typeof body.state === 'string' ? body.state : null, ['triaged', 'actioned', 'dismissed'] as const, 'state');
    if (!to) throw fail(400, 'bad_request', 'state is required: triaged, actioned or dismissed.');
    const reason = reasonOf(body.reason, false);
    return tx(async (c) => {
      const r = (await c.query('SELECT id, listing_id, state FROM marketplace_reports WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!r) throw fail(404, 'not_found', 'No such report.');
      if (r.state === 'actioned' || r.state === 'dismissed') throw fail(409, 'already_resolved', `This report is already ${r.state}.`);
      if (r.state === to) throw fail(409, 'invalid_transition', `This report is already ${to}.`);
      await c.query('UPDATE marketplace_reports SET state = $2::text, resolved_at = CASE WHEN $2::text = \'triaged\' THEN NULL ELSE now() END WHERE id = $1', [id, to]);
      await audit(c, adminId, 'resolve_report', null, { reportId: id, listingId: r.listing_id, from: r.state, to, reason });
      return { id, state: to };
    });
  }

  async function publishers(adminId: string) {
    return read(adminId, 'list_publishers', null, {}, async (c) => {
      const rows = (await c.query(`SELECT p.id, p.display_name, p.owner_user_id, p.verified, p.created_at,
          (SELECT count(*) FROM marketplace_listings l WHERE l.publisher_id = p.id)::int AS listings,
          EXISTS (SELECT 1 FROM marketplace_listings l WHERE l.publisher_id = p.id AND l.trust = 'official') AS official
        FROM marketplace_publishers p ORDER BY p.id LIMIT 500`)).rows;
      return { items: rows.map((p) => ({ id: p.id, displayName: p.display_name, ownerUserId: p.owner_user_id, verified: p.verified,
        trust: p.official ? 'official' : p.verified ? 'verified' : 'community', listings: p.listings, createdAt: p.created_at })) };
    });
  }

  async function upsertPublisher(adminId: string, body: Record<string, unknown>) {
    const id = typeof body.id === 'string' ? idParam(body.id, PUBLISHER_ID, 'id') : null;
    if (!id) throw fail(400, 'bad_request', 'id is required (lowercase letters, digits and dashes).');
    if (typeof body.trust !== 'string') throw fail(400, 'bad_request', `trust must be one of: ${TRUSTS.join(', ')}.`);
    const trust = oneOf(body.trust, TRUSTS, 'trust')!;
    let displayName: string | null = null;
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 120) throw fail(400, 'bad_request', 'displayName must be 1 to 120 characters.');
      displayName = body.displayName.trim();
    }
    const owner = body.ownerUserId === undefined ? null : idParam(typeof body.ownerUserId === 'string' ? body.ownerUserId : '', OPAQUE_ID, 'ownerUserId');
    return tx(async (c) => {
      const ex = (await c.query('SELECT id, verified FROM marketplace_publishers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const verified = trust !== 'community';
      if (!ex) {
        if (owner && !(await c.query('SELECT 1 FROM users WHERE id = $1', [owner])).rowCount) throw fail(404, 'not_found', 'Unknown ownerUserId.');
        if (!owner) await ensureUser(c, SYSTEM_USER);
        await c.query('INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ($1,$2,$3,$4)', [id, displayName ?? id, owner ?? SYSTEM_USER, verified]);
      } else {
        await c.query('UPDATE marketplace_publishers SET verified = $2, display_name = coalesce($3, display_name) WHERE id = $1', [id, verified, displayName]);
      }
      // the publisher's trust is shown on its listings (private listings keep 'private')
      const upd = await c.query(`UPDATE marketplace_listings SET trust = $2 WHERE publisher_id = $1 AND trust <> 'private'`, [id, trust]);
      await audit(c, adminId, ex ? 'update_publisher' : 'create_publisher', null, { publisherId: id, trust, verified, was: ex ? { verified: ex.verified } : null, listingsUpdated: upd.rowCount ?? 0 });
      return { status: ex ? 200 : 201, body: { id, trust, verified, listingsUpdated: upd.rowCount ?? 0 } };
    });
  }

  async function analytics(adminId: string, sp: URLSearchParams) {
    const type = oneOf(sp.get('type'), LISTING_TYPES, 'type');
    const publisher = idParam(sp.get('publisher'), PUBLISHER_ID, 'publisher');
    const from = day(sp.get('from'), 'from'), to = day(sp.get('to'), 'to');
    if (from && to && from > to) throw fail(400, 'bad_request', 'from is after to.');
    // Each statement gets exactly the parameters it references (Postgres refuses unused ones).
    const build = (rangeCol?: string) => {
      const values: unknown[] = [];
      const $ = (v: unknown) => { values.push(v); return `$${values.length}`; };
      let lf = '', rg = '';
      if (type) lf += ` AND l.type = ${$(type)}`;
      if (publisher) lf += ` AND l.publisher_id = ${$(publisher)}`;
      if (rangeCol && from) rg += ` AND ${rangeCol} >= ${$(from)}::date`;
      if (rangeCol && to) rg += ` AND ${rangeCol} < ${$(to)}::date + 1`;
      return { lf, rg, values };
    };
    const IN_LIVE = `i.state IN ${LIVE_INSTALL}`;
    const PUBLISHED = `EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.listing_id = l.id AND v.state = 'published')`;
    return read(adminId, 'view_analytics', null, { type, publisher, from, to }, async (c) => {
      const run = async (rangeCol: string | undefined, sql: (x: { lf: string; rg: string }) => string) => {
        const x = build(rangeCol); return (await c.query(sql(x), x.values)).rows;
      };
      const [byType, inst, uninst, adopt, rating, cats, incidents, cov] = await series([
        () => run(undefined, (x) => `SELECT l.type, count(*)::int AS n FROM marketplace_listings l WHERE ${PUBLISHED}${x.lf} GROUP BY l.type ORDER BY l.type`),
        () => run('i.installed_at', (x) => `SELECT count(*) FILTER (WHERE i.state NOT IN ('requested','permission_review','failed')${x.rg})::int AS installs,
                  count(*) FILTER (WHERE i.state = 'failed'${x.rg})::int AS failed,
                  count(*) FILTER (WHERE ${IN_LIVE} AND i.enabled)::int AS active
             FROM marketplace_installs i JOIN marketplace_listings l ON l.id = i.listing_id WHERE true${x.lf}`),
        () => run('e.at', (x) => `SELECT count(*)::int AS n FROM marketplace_install_events e JOIN marketplace_listings l ON l.id = e.listing_id WHERE e.event = 'uninstalled'${x.lf}${x.rg}`),
        () => run(undefined, (x) => `SELECT count(*) FILTER (WHERE i.version_id IS NOT NULL)::int AS tracked, count(*) FILTER (WHERE i.version_id = lv.id)::int AS on_latest
             FROM marketplace_installs i JOIN marketplace_listings l ON l.id = i.listing_id LEFT JOIN LATERAL ${latestPublished('i.listing_id')} lv ON true
            WHERE ${IN_LIVE}${x.lf}`),
        () => run('r.created_at', (x) => `SELECT round(avg(r.stars)::numeric, 2) AS avg, count(*)::int AS n FROM marketplace_reviews r JOIN marketplace_listings l ON l.id = r.listing_id WHERE true${x.lf}${x.rg}`),
        () => run(undefined, (x) => `SELECT t.tag, count(DISTINCT l.id)::int AS listings, count(i.id) FILTER (WHERE ${IN_LIVE})::int AS installs
             FROM marketplace_listings l CROSS JOIN LATERAL unnest(l.tags) AS t(tag) LEFT JOIN marketplace_installs i ON i.listing_id = l.id
            WHERE ${PUBLISHED}${x.lf} GROUP BY t.tag ORDER BY installs DESC, listings DESC, t.tag LIMIT 10`),
        () => run('e.at', (x) => `SELECT count(*)::int AS n FROM marketplace_release_events e JOIN marketplace_listings l ON l.id = e.listing_id WHERE e.event IN ('quarantined','revoked')${x.lf}${x.rg}`),
        () => c.query(`SELECT (SELECT count(DISTINCT device_id) FROM marketplace_installs)::int AS reporting, (SELECT count(*) FROM devices)::int AS known`).then((r) => r.rows),
      ]);
      const installs = inst[0].installs, failed = inst[0].failed;
      const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
      return {
        filters: { type, publisher, from, to },
        publishedListingsByType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
        installs, uninstalls: uninst[0].n, activeInstalls: inst[0].active,
        updateAdoption: { onLatest: adopt[0].on_latest, installs: adopt[0].tracked, ratio: ratio(adopt[0].on_latest, adopt[0].tracked) },
        failedInstalls: failed, failureRate: ratio(failed, installs + failed),
        averageRating: rating[0].avg === null ? null : Number(rating[0].avg), ratingCount: rating[0].n,
        popularCategories: cats,
        securityIncidents: incidents[0].n,
        telemetryCoverage: { devicesReporting: cov[0].reporting, devicesKnown: cov[0].known, ratio: ratio(cov[0].reporting, cov[0].known) },
        notCollected: NOT_COLLECTED,
        notes: ['installs, failedInstalls, uninstalls, ratings and securityIncidents are limited to from/to; published listings, active installs, update adoption and categories are snapshots.',
          'telemetryCoverage is global (not filtered by type or publisher).'],
      };
    });
  }

  // ── routing
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/admin/marketplace' && !url.pathname.startsWith('/admin/marketplace/')) return false;
    const send = (status: number, payload: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 413 ? { connection: 'close' } : {}) });
      res.end(JSON.stringify(payload));
    };
    try {
      const adminId = await deps.authenticate(req);
      const role: AdminRole = deps.roleOf ? await deps.roleOf(adminId) : 'analyst';
      const need = (p: MarketplacePermission) => { if (!can(role, p)) throw fail(403, 'forbidden', `Your role (${role}) does not have ${p}.`); };
      let parts: string[];
      try { parts = url.pathname.slice('/admin/marketplace'.length).split('/').filter(Boolean).map(decodeURIComponent); } catch { throw fail(400, 'bad_request', 'Malformed path.'); }
      const m = req.method ?? 'GET';
      if (parts.length > 3) throw fail(404, 'not_found', 'Not found.');
      const [a, id, sub] = parts;
      const sp = url.searchParams;
      const vid = (v: string) => { if (!OPAQUE_ID.test(v)) throw fail(404, 'not_found', 'Not found.'); return v; };

      if (a === 'submissions' && !id && m === 'POST') { need('marketplace.write'); const r = await submit(adminId, role, req, sp); return send(r.status, r.body), true; }
      if (a === 'submissions' && !id && m === 'GET') { need('marketplace.read'); return send(200, await queue(adminId, sp)), true; }
      if (a === 'catalog' && !id && m === 'GET') { need('marketplace.read'); return send(200, await catalog(adminId, sp)), true; }
      if (a === 'versions' && id && !sub && m === 'GET') { need('marketplace.read'); return send(200, await versionDetail(adminId, vid(id))), true; }
      if (a === 'versions' && id && sub && m === 'POST' && (ACTIONS as readonly string[]).includes(sub)) {
        const action = sub as Action;
        need(ACTION_PERMISSION[action]);
        return send(200, await act(adminId, role, vid(id), action, await jsonBody(req))), true;
      }
      if (a === 'versions' && id && sub === 'rescan' && m === 'POST') { need('marketplace.write'); return send(200, await rescan(adminId, vid(id))), true; }
      if (a === 'installations' && !id && m === 'GET') { need('marketplace.read'); return send(200, await installations(adminId, sp)), true; }
      if (a === 'users' && id && sub === 'installs' && m === 'GET') { need('marketplace.read'); return send(200, await userInstalls(adminId, vid(id))), true; }
      if (a === 'reviews' && !id && m === 'GET') { need('marketplace.read'); return send(200, await reviews(adminId, sp)), true; }
      if (a === 'reviews' && id && !sub && m === 'DELETE') { need('marketplace.moderate'); return send(200, await deleteReview(adminId, vid(id))), true; }
      if (a === 'reports' && !id && m === 'GET') { need('marketplace.read'); return send(200, await reports(adminId, sp)), true; }
      if (a === 'reports' && id && sub === 'resolve' && m === 'POST') { need('marketplace.moderate'); return send(200, await resolveReport(adminId, vid(id), await jsonBody(req))), true; }
      if (a === 'publishers' && !id && m === 'GET') { need('marketplace.read'); return send(200, await publishers(adminId)), true; }
      if (a === 'publishers' && !id && m === 'POST') {
        if (role !== 'superadmin') throw fail(403, 'forbidden', 'Only a superadmin can create or verify publishers.');
        const r = await upsertPublisher(adminId, await jsonBody(req));
        return send(r.status, r.body), true;
      }
      if (a === 'analytics' && !id && m === 'GET') { need('marketplace.read'); return send(200, await analytics(adminId, sp)), true; }
      throw fail(404, 'not_found', 'Not found.');
    } catch (e: any) {
      if (e instanceof ApiError) send(e.status, { error: e.message, code: e.code, ...(e.extra ?? {}) });
      else if (typeof e?.status === 'number' && e.status < 500) send(e.status, { error: e.message });   // admin.ts HttpError (401/403/413/400)
      else { console.error(e); send(500, { error: 'Server error.' }); }
      return true;
    }
  };
}

/** Owner of publishers and listings that no real user owns yet (a plain users row nobody can sign in as: it has no Clerk id).
 *  RESERVED id: real user ids are `usr_` + 26 base36 chars from sync.ts's generator (no underscore after the prefix), so signup can never produce this one. */
export const SYSTEM_USER = 'usr_marketplace_system';
/** The scanner name of the per-version summary row in marketplace_security_scans (the per-check rows use the check names). */
const OVERALL = 'validation';
