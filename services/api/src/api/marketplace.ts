// The public marketplace API (/v1/marketplace/*). Reads work without a token and see only public
// published things; every mutation needs a valid token. Authentication is the sync API's (Clerk
// session token or aod_ device token), handed in as `authenticate`. Visibility is decided by
// row-level security in Postgres (the store runs as ao_app with app.user_id set), never here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { ArtifactCorruptError, extractOne, openArtifact, UnpackError, type ArtifactStore } from '../marketplace/artifacts.ts';
import * as creator from '../marketplace/creator.ts';
import { ByteLru } from '../marketplace/lru.ts';
import { createGate, type Gate } from '../marketplace/limits.ts';
import { clientAddress, createLimiter, type Limiter } from '../marketplace/ratelimit.ts';
import { BadQuery, parseListParams } from '../marketplace/search.ts';
import * as store from '../marketplace/store.ts';
import { typeSupport } from '../marketplace/support.ts';
import { checkNoLiteralSecrets } from '../marketplace/validate/advanced-common.ts';
import { sha256Hex } from '../marketplace/artifacts.ts';
import { latestVerification, toView } from '../marketplace/verifyStore.ts';
import { HttpError, json } from './sync.ts';

export interface MarketplaceDeps {
  app: pg.Pool;
  /** Resolves the bearer token to our user id (sync's `authenticate`); throws HttpError(401) when it is invalid. */
  authenticate(req: IncomingMessage): Promise<{ uid: string }>;
  store: ArtifactStore;
  /** Mutating routes only; defaults to 60 requests per minute per user. */
  limiter?: Limiter;
  /** GET routes: per user, or per client address when anonymous; defaults to 300 requests per minute. */
  readLimiter?: Limiter;
  /** Reverse proxies in front of this server that append to X-Forwarded-For (default: env TRUSTED_PROXY_HOPS, else 0 = use the socket address). */
  trustedProxyHops?: number;
  /** Preview/doc entries (shared; visibility is still checked per request). */
  cache?: ByteLru;
  /** The ao_admin pool: used ONLY to register artifacts, create publishers/teams/members and finalize a creator's version
   *  (publish privately / reject). Without it the create, fork and team routes answer 503. */
  admin?: pg.Pool;
  /** Largest accepted package upload; defaults to 64 MiB. */
  maxUploadBytes?: number;
  /** Quotas and the ingest gate (marketplace/limits.ts); env-overridable defaults. */
  limits?: Partial<import('../marketplace/limits.ts').Limits>;
  /** Adding team members: 10 per minute per owner by default, to blunt user-id enumeration. */
  memberAddLimiter?: Limiter;
  /** Process-wide gate around compare, artifact downloads and preview/doc cache misses (default 4 at once, 16 queued, else 429 busy). */
  heavyGate?: Gate;
  /** Bytes of upload bodies allowed in flight at once across the process (default 256 MiB; AO_MKT_UPLOAD_BUDGET). */
  uploadBudgetBytes?: number;
  /** How long a request that does not fit the upload budget waits before the 429 (default 1500 ms). */
  uploadWaitMs?: number;
  /** False while the skill scanner is unavailable (startup self-check): creator uploads answer 503 scanner_unavailable. */
  scannerOk?: () => boolean;
}

const MAX_PREVIEW = 2 * 1024 * 1024, MAX_DOC = 256 * 1024;

const LISTING_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_BODY = 64 * 1024;
/** installs/sync fields that are opaque ids or enums (not scanned for secrets); every other field is scanned, and dropped when unknown. */
const SYNC_ID_FIELDS: ReadonlySet<string> = new Set(['listingId', 'versionId', 'state', 'enabled', 'scanVerdict']);
const MAX_UPLOAD = 64 * 1024 * 1024;
const TEAM_ID = /^team_[a-f0-9]{18}$/;
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const bad = (m: string) => new HttpError(400, m);
const notFound = () => new HttpError(404, 'Not found.');

function text(v: unknown, what: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad(`${what} must be a string.`);
  if (v.length > max) throw bad(`${what} is too long (${max} characters at most).`);
  return v;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw bad(`${what} must be one of: ${allowed.join(', ')}.`);
  return v as T;
}
/** A request body must be a JSON object: `null`, arrays, strings and numbers are a 400, not a TypeError. */
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const d: unknown = await json(req, MAX_BODY);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('Body must be a JSON object.');
  return d as Record<string, unknown>;
}
const object = (v: unknown, what: string) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} must be an object.`); return v as Record<string, unknown>; };

/** A package upload: a zip body (never JSON), read with a hard cap. An empty body is a 400, an oversized one a 413. */
async function zipBody(req: IncomingMessage, max: number, budget?: UploadBudget): Promise<Uint8Array> {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!ZIP_TYPES.includes(ct)) throw new HttpError(400, 'Send the package as application/zip.');
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, `The package is over the ${max} byte limit.`);
  // reserve BEFORE buffering a byte: the declared length, or the cap when the length is not declared (chunked)
  const release = budget ? await budget.reserve(declared > 0 ? declared : max) : () => {};
  try {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of req) {
      n += (c as Buffer).length;
      if (n > max) throw new HttpError(413, `The package is over the ${max} byte limit.`);
      chunks.push(c as Buffer);
    }
    if (!n) throw new HttpError(400, 'The body is empty.');
    return new Uint8Array(Buffer.concat(chunks));
  } finally { release(); }
}
/** A process-wide budget of upload bytes in flight. A request that does not fit waits briefly, then gets 429 `busy`. */
export interface UploadBudget { reserve(bytes: number): Promise<() => void> }
export function createUploadBudget(total: number, waitMs: number): UploadBudget {
  let used = 0;
  const waiters: Array<() => void> = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  return {
    async reserve(bytes) {
      const need = Math.min(bytes, total);   // a single request bigger than the whole budget can still go alone
      const deadline = Date.now() + waitMs;
      while (used > 0 && used + need > total) {
        const left = deadline - Date.now();
        if (left <= 0) throw new store.StoreError(429, 'The server is busy receiving other uploads. Try again shortly.', 'busy');
        await new Promise<void>((r) => { const t = setTimeout(r, left); waiters.push(() => { clearTimeout(t); r(); }); });
      }
      used += need;
      let done = false;
      return () => { if (!done) { done = true; used -= need; wake(); } };
    },
  };
}

/** image/png | jpeg | gif | webp by magic bytes; undefined for anything else. */
export function imageType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return undefined;
}

export function marketplaceHandler(deps: MarketplaceDeps) {
  const limiter = deps.limiter ?? createLimiter();
  const readLimiter = deps.readLimiter ?? createLimiter({ limit: 300 });
  const hops = Math.max(0, Math.floor(deps.trustedProxyHops ?? (Number(process.env.TRUSTED_PROXY_HOPS) || 0)));
  if (hops > 0 && Number(process.env.INSTANCES) > 1) console.warn('marketplace: rate limiters are per process; with INSTANCES>1 each instance keeps its own counters, so the effective limit is multiplied by the instance count.');
  const cache = deps.cache ?? new ByteLru();
  const maxUpload = deps.maxUploadBytes ?? MAX_UPLOAD;
  const memberAddLimiter = deps.memberAddLimiter ?? createLimiter({ limit: 10 });
  const heavy = deps.heavyGate ?? createGate(Number(process.env.AO_MKT_HEAVY_CONCURRENCY) || 4, Number(process.env.AO_MKT_HEAVY_QUEUE) || 16);
  const budget = createUploadBudget(deps.uploadBudgetBytes ?? (Number(process.env.AO_MKT_UPLOAD_BUDGET) || 256 * 1024 * 1024), deps.uploadWaitMs ?? 1500);
  const scannerOk = deps.scannerOk ?? (() => true);
  const creatorShared = deps.admin ? creator.creatorDeps(deps.app, deps.admin, deps.store, deps.limits) : undefined;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/v1/marketplace' && !url.pathname.startsWith('/v1/marketplace/')) return false;
    // The desktop renderer calls this API from the vscode-file:// origin, so the browser needs CORS. Credentials are a bearer
    // header (never cookies), so '*' lets no site act as a user. The preflight answers before any authentication.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'x-content-sha256, retry-after');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      res.end();
      return true;
    }
    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(payload));
    };
    try {
      const m = req.method ?? 'GET';
      let rest: string;
      try { rest = decodeURIComponent(url.pathname.slice('/v1/marketplace'.length)).replace(/^\/+/, ''); } catch { throw bad('Malformed path.'); }
      // POST versions/status is a READ (states only), open to signed-out clients so they too learn about revocations
      const anonStatus = m === 'POST' && rest === 'versions/status';
      const mutating = m !== 'GET' && m !== 'HEAD' && !anonStatus;
      // No Authorization header: an anonymous reader. A header that does not verify is a 401, never a downgrade.
      const signedIn = !!req.headers.authorization;
      if (mutating && !signedIn) throw new HttpError(401, 'Sign in first.');
      const lim = mutating ? limiter : readLimiter;
      const ipKey = `ip:${clientAddress(req, hops)}`;
      const limit = (key: string) => { if (!lim.allow(key)) throw new HttpError(429, 'Too many requests. Try again in a minute.', { retryAfter: lim.retryAfter(key) }); };
      // Anonymous requests are limited by address BEFORE anything else runs; a signed-in one by user id (address is the fallback
      // while the token does not verify, so a flood of bad tokens cannot hammer authenticate for free).
      if (!signedIn) limit(ipKey);
      let uid = '';
      if (signedIn) {
        try { uid = (await deps.authenticate(req)).uid; } catch (e) { limit(ipKey); throw e; }
        limit(uid);
      }
      const q = <T>(fn: (c: pg.PoolClient) => Promise<T>) => store.withUser(deps.app, uid, fn);
      const needAuth = () => { if (!signedIn) throw new HttpError(401, 'Sign in first.'); };
      const uploadsOpen = () => { if (!scannerOk()) throw new store.StoreError(503, 'Uploads are paused: the package security scanner is unavailable on this server.', 'scanner_unavailable'); };
      const cdeps = (): creator.CreatorDeps => {
        if (!creatorShared) throw new HttpError(503, 'Creating and sharing is not configured on this server.');
        return creatorShared;
      };

      if (anonStatus) {
        const d = await body(req);
        if (!Array.isArray(d.versionIds) || d.versionIds.length > 200) throw bad('versionIds must be an array of at most 200 ids.');
        if (!d.versionIds.every((v) => typeof v === 'string' && OPAQUE_ID.test(v))) throw bad('versionIds contains an invalid id.');
        const st = await q((c) => store.versionStatuses(c, d.versionIds as string[]));
        return send(200, { statuses: st.map((x) => ({ versionId: x.versionId, state: x.state, ...(x.reason && (x.state === 'revoked' || x.state === 'quarantined') ? { reason: x.reason } : {}) })) }), true;
      }

      // ── what is operational: the single source the nav, installer and publish gate read. Nothing user-specific; safe to cache briefly.
      if (rest === 'capabilities' && m === 'GET') {
        return send(200, { schema: 'agentic.marketplace.capabilities/1', types: typeSupport() }, { 'cache-control': 'public, max-age=60' }), true;
      }

      // ── catalog
      if (rest === 'listings' && m === 'GET') {
        const p = parseListParams(url.searchParams);
        if (p.installed !== null && !signedIn) throw new HttpError(401, 'Sign in to filter by installed.');
        if (p.scope !== null) needAuth();
        try {
          return send(200, await q(async (c) => {
            if (p.scope === 'team' && !(await store.teamRole(c, p.team!))) throw new store.StoreError(403, 'You are not a member of that team.', 'not_team_member');
            return store.listListings(c, p);
          })), true;
        }
        catch (e: any) {
          // belt and braces: a data exception (SQLSTATE class 22) from a query that used the cursor is the caller's bad cursor
          if (p.cursor && typeof e?.code === 'string' && e.code.startsWith('22')) throw bad('invalid page cursor');
          throw e;
        }
      }
      // ── creating: a package upload becomes a private (or team) listing
      if (rest === 'listings' && m === 'POST') {
        uploadsOpen();
        const cd = cdeps();
        const visibility = url.searchParams.get('visibility') ?? 'private';
        if (visibility === 'public' || visibility === 'org') throw new store.StoreError(403, 'Public and organization visibility are granted by review.', 'public_requires_review');
        if (visibility !== 'private' && visibility !== 'team') throw bad('visibility must be private or team.');
        const team = url.searchParams.get('team');
        if (team !== null && !TEAM_ID.test(team)) throw bad('team is not a valid team id.');
        await creator.precheckCreate(cd, uid, { visibility, team });   // team membership before the body is read
        const bytes = await zipBody(req, maxUpload, budget);
        return send(201, await creator.createListing(cd, uid, bytes, { visibility, team })), true;
      }
      if (rest === 'me' && m === 'GET') { needAuth(); return send(200, { userId: uid, publisherId: creator.publisherIdFor(uid) }), true; }
      if (rest === 'me/listings' && m === 'GET') { needAuth(); return send(200, { items: await q((c) => store.listMine(c)) }), true; }
      if (rest === 'me/teams' && m === 'GET') { needAuth(); return send(200, { items: await q((c) => store.listMyTeams(c)) }), true; }
      if (rest === 'teams' && m === 'POST') {
        const cd = cdeps();
        const d = await body(req);
        const name = text(d.name, 'name', 80)?.trim();
        if (!name) throw bad('name is required.');
        return send(201, await creator.createTeam(cd, uid, name)), true;
      }
      const tm = /^teams\/([^/]+)(?:\/(members|owner)(?:\/([^/]+))?)?$/.exec(rest);
      if (tm) {
        const [, tid, members, member] = tm;
        if (!TEAM_ID.test(tid)) throw notFound();
        if (!members && m === 'GET') { needAuth(); return send(200, await creator.getTeam(cdeps(), uid, tid)), true; }
        if (members === 'owner' && !member && m === 'POST') {
          const cd = cdeps();
          const d = await body(req);
          const userId = text(d.userId, 'userId', 120);
          if (!userId || !OPAQUE_ID.test(userId)) throw bad('userId is required.');
          return send(200, await creator.transferOwner(cd, uid, tid, userId)), true;
        }
        if (members === 'members' && !member && m === 'POST') {
          const cd = cdeps();
          if (!memberAddLimiter.allow(uid)) throw new HttpError(429, 'Too many member additions. Try again in a minute.', { retryAfter: memberAddLimiter.retryAfter(uid) });
          const d = await body(req);
          const userId = text(d.userId, 'userId', 120);
          if (!userId || !OPAQUE_ID.test(userId)) throw bad('userId is required.');
          const r = await creator.addMember(cd, uid, tid, userId);
          return send(r.created ? 201 : 200, { userId: r.userId, role: r.role }), true;
        }
        if (members === 'members' && member && m === 'DELETE') {
          const cd = cdeps();
          if (!OPAQUE_ID.test(member)) throw notFound();
          await creator.removeMember(cd, uid, tid, member);
          return send(200, { removed: member }), true;
        }
      }

      const wm = /^listings\/([^/]+\/[^/]+)\/versions\/([^/]+)$/.exec(rest);
      if (wm && m === 'DELETE') {
        if (!LISTING_ID.test(wm[1]) || !OPAQUE_ID.test(wm[2])) throw notFound();
        return send(200, await creator.withdrawVersion(cdeps(), uid, wm[1], wm[2])), true;
      }
      const lm = /^listings\/([^/]+\/[^/]+)(?:\/(favorite|review|reviews|versions|visibility|fork|compare))?$/.exec(rest);
      if (lm) {
        const [, id, sub] = lm;
        if (!LISTING_ID.test(id)) throw notFound();
        if (!sub && m === 'DELETE') return send(200, await creator.deleteListing(cdeps(), uid, id)), true;
        if (!sub && m === 'GET') {
          const l = await q((c) => store.getListing(c, id));
          if (!l) throw notFound();
          return send(200, l), true;
        }
        if (sub === 'versions' && m === 'POST') {
          uploadsOpen();
          const cd = cdeps();
          await creator.checkCanAddVersion(cd, uid, id);   // 404 / 403 before a byte of the body is read
          const bytes = await zipBody(req, maxUpload, budget);
          return send(201, await creator.addVersion(cd, uid, id, bytes)), true;
        }
        if (sub === 'visibility' && m === 'PUT') {
          const cd = cdeps();
          const d = await body(req);
          const team = text(d.team, 'team', 40);
          if (team !== null && !TEAM_ID.test(team)) throw bad('team is not a valid team id.');
          return send(200, await creator.setVisibility(cd, uid, id, typeof d.visibility === 'string' ? d.visibility : '', team)), true;
        }
        if (sub === 'fork' && m === 'POST') {
          uploadsOpen();
          const cd = cdeps();
          const d = await body(req);
          return send(201, await creator.forkListing(cd, uid, id, text(d.slug, 'slug', 64))), true;
        }
        if (sub === 'compare' && m === 'GET') {
          needAuth();
          const cd = cdeps();
          const opt = (k: string) => { const v = url.searchParams.get(k); if (v === null || v === '') return null; if (!OPAQUE_ID.test(v)) throw notFound(); return v; };
          return send(200, await heavy.run(() => creator.compareVersions(cd, uid, id, opt('base'), opt('head')))), true;
        }
        if (sub === 'versions' && m === 'GET') {
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            return { versions: await store.listVersions(c, id) };
          })), true;
        }
        if (sub === 'reviews' && m === 'GET') {
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            const p = url.searchParams.get('page');
            return store.listReviews(c, uid, id, p ? store.decodeReviewCursor(p) : null);
          })), true;
        }
        if (sub === 'favorite' && (m === 'PUT' || m === 'DELETE')) {
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            return store.setFavorite(c, uid, id, m === 'PUT');
          })), true;
        }
        if (sub === 'review' && (m === 'PUT' || m === 'DELETE')) {
          let stars = 0, reviewText: string | null = null;
          if (m === 'PUT') {
            const d = await body(req);
            if (typeof d.stars !== 'number' || !Number.isInteger(d.stars) || d.stars < 1 || d.stars > 5) throw bad('stars must be an integer from 1 to 5.');
            stars = d.stars; reviewText = text(d.body, 'body', 4000);
          }
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            return m === 'PUT' ? store.putReview(c, uid, id, stars, reviewText) : store.deleteReview(c, uid, id);
          })), true;
        }
      }

      // ── artifact bytes (a download is NOT an install: the device acknowledges through installs/sync)
      const am = /^versions\/([^/]+)\/artifact$/.exec(rest);
      if (am && m === 'GET') {
        const vid = am[1];
        if (!OPAQUE_ID.test(vid)) throw notFound();
        const access = await q((c) => store.versionAccess(c, vid, signedIn));
        if (access === 'missing') throw notFound();
        if (access === 'gone') throw new HttpError(410, 'This version was withdrawn and can no longer be downloaded.');
        // a draft, submitted or rejected version (a creator's own upload) is visible to its owner but is not installable
        if (!(await q((c) => store.versionInstallable(c, vid)))) throw new store.StoreError(409, 'This version is not published and cannot be installed.', 'not_installable');
        const a = await heavy.run(() => openArtifact(deps.app, deps.store, { userId: uid }, vid));
        if (!a) throw notFound();
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': a.bytes.length, 'x-content-sha256': a.sha256, 'cache-control': 'private, no-store' });
        res.end(Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength));
        return true;
      }

      // ── verification result for a version: the same visibility as the version itself (RLS), and ONE uniform 404 for "no such
      //    version", "not visible to you" and "visible but never verified", so the status code is no existence oracle.
      const vm = /^versions\/([^/]+)\/verification(?:\/evidence\/([^/]+))?$/.exec(rest);
      if (vm && m === 'GET') {
        const vid = vm[1], blobSha = vm[2];
        if (!OPAQUE_ID.test(vid) || (blobSha !== undefined && !/^[0-9a-f]{64}$/.test(blobSha))) throw notFound();
        const access = await q((c) => store.versionAccess(c, vid, signedIn));
        if (access === 'missing') throw notFound();
        if (access === 'gone') throw new HttpError(410, 'This version was withdrawn.');
        if (blobSha === undefined) {
          const sv = await q((c) => latestVerification(c, vid));
          if (!sv) throw notFound();
          return send(200, toView(sv)), true;
        }
        // evidence: only a blob referenced by a verification row the caller can see; never listed, never guessed
        const row = (await q((c) => c.query('SELECT stages FROM marketplace_verifications WHERE version_id = $1 AND $2 = ANY(evidence_shas) ORDER BY seq DESC LIMIT 1', [vid, blobSha]))).rows[0];
        const mime = row ? (row.stages as any[]).flatMap((st) => st.evidence ?? []).find((e: any) => e.blob?.sha256 === blobSha)?.blob?.mime : undefined;
        if (!mime) throw notFound();
        const bytes = await heavy.run(() => deps.store.get(blobSha));
        if (!bytes || sha256Hex(bytes) !== blobSha) throw notFound();
        res.writeHead(200, { 'content-type': mime, 'content-length': bytes.byteLength, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'attachment' });
        res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return true;
      }

      // ── read-only views into a version's package: a preview image and the skill's SKILL.md (same visibility as the artifact)
      const pm = /^versions\/([^/]+)\/(preview\/(\d{1,2})|doc)$/.exec(rest);
      if (pm && m === 'GET') {
        const vid = pm[1];
        if (!OPAQUE_ID.test(vid)) throw notFound();
        const access = await q((c) => store.versionAccess(c, vid, signedIn));
        if (access === 'missing') throw notFound();
        if (access === 'gone') throw new HttpError(410, 'This version was withdrawn.');
        // Visibility is decided here, as the caller, on EVERY request: the cache below is only a byte store.
        const view = await q((c) => store.versionForView(c, vid));
        if (!view) throw notFound();
        const payload = (view.manifest.payload ?? {}) as Record<string, unknown>;
        const isDoc = pm[2] === 'doc';
        let path: unknown;
        if (isDoc) path = view.manifest.type === 'skill' ? (typeof payload.entry === 'string' ? payload.entry : 'SKILL.md') : undefined;
        else path = Array.isArray(payload.previews) ? payload.previews[Number(pm[3])] : undefined;
        if (typeof path !== 'string') throw notFound();
        const cap = isDoc ? MAX_DOC : MAX_PREVIEW;
        const key = `${view.sha256}\0${path}`;
        let file = cache.get(key);
        if (!file) {
          file = await heavy.run(async () => {
            const a = await openArtifact(deps.app, deps.store, { userId: uid }, vid);
            if (!a) throw notFound();
            let f: Uint8Array | undefined;
            try { f = extractOne(a.bytes, path as string, { maxBytes: cap }); }
            catch (e) {
              if (e instanceof UnpackError) throw e.code === 'too-large' ? new HttpError(413, 'That file is too large to preview.') : notFound();
              throw e;
            }
            if (!f) throw notFound();
            return f;
          });
          cache.set(key, file);
        }
        const type = isDoc ? 'text/markdown; charset=utf-8' : imageType(file);
        if (!type) throw notFound();
        // a public, published version never changes: browsers may keep it; anything else is never stored
        const cc = view.cacheable ? 'private, max-age=3600, immutable' : 'private, no-store';
        res.writeHead(200, { 'content-type': type, 'content-length': file.byteLength, 'cache-control': cc, 'x-content-type-options': 'nosniff',
          ...(isDoc ? {} : { 'content-security-policy': "default-src 'none'" }) });
        res.end(Buffer.from(file.buffer, file.byteOffset, file.byteLength));
        return true;
      }

      // ── install acknowledgement and update discovery
      if (rest === 'installs/sync' && m === 'POST') {
        const d = await body(req);
        const deviceId = text(d.deviceId, 'deviceId', 80);
        if (!deviceId || !OPAQUE_ID.test(deviceId)) throw bad('deviceId is required.');
        if (!Array.isArray(d.items)) throw bad('items must be an array.');
        if (d.items.length > 200) throw bad('items has too many entries (200 at most).');
        // This endpoint carries install STATE only. Configuration, values and secrets never travel through it: unknown fields are dropped
        // below, and anything that looks like a credential in a field we do keep (or anywhere else in the body) refuses the whole request
        // so nothing is stored. (Ids are opaque and are not scanned.)
        const leak = checkNoLiteralSecrets({ top: Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'items' && k !== 'deviceId')),
          items: d.items.map((raw) => raw && typeof raw === 'object' && !Array.isArray(raw)
            ? Object.fromEntries(Object.entries(raw as object).filter(([k]) => !SYNC_ID_FIELDS.has(k))) : raw) }, new Set());
        if (!leak.ok) throw bad('installs/sync must not carry credentials or secrets; nothing was stored.');
        const seen = new Set<string>();
        const entries = d.items.map((raw, n): store.InstallEntry => {
          const it = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
          const listingId = typeof it?.listingId === 'string' ? it.listingId.slice(0, 200) : `#${n}`;
          try {
            if (!it) throw bad('item must be an object');
            if (!LISTING_ID.test(listingId) || listingId.length > 200) throw bad('listingId');
            if (seen.has(listingId)) throw bad('repeated');
            seen.add(listingId);
            const versionId = text(it.versionId, 'versionId', 120);
            if (versionId !== null && !OPAQUE_ID.test(versionId)) throw bad('versionId');
            if (it.enabled !== undefined && typeof it.enabled !== 'boolean') throw bad('enabled');
            return { listingId, item: {
              listingId, versionId, state: oneOf(it.state, store.INSTALL_STATES, 'state'), enabled: it.enabled === true,
              scanVerdict: it.scanVerdict === undefined || it.scanVerdict === null ? null : oneOf(it.scanVerdict, store.SCAN_VERDICTS, 'scanVerdict'),
              lastError: text(it.lastError, 'lastError', 500),
            } };
          } catch (e) { if (e instanceof HttpError) return { listingId, item: null }; throw e; }
        });
        return send(200, await q((c) => store.syncInstalls(c, uid, deviceId, entries))), true;
      }

      // ── reports
      if (rest === 'reports' && m === 'POST') {
        const d = await body(req);
        const listingId = text(d.listingId, 'listingId', 200);
        if (!listingId || !LISTING_ID.test(listingId)) throw bad('listingId is not a valid listing id.');
        const versionId = text(d.versionId, 'versionId', 120);
        if (versionId !== null && !OPAQUE_ID.test(versionId)) throw bad('versionId is not valid.');
        const reason = oneOf(d.reason, store.REPORT_REASONS, 'reason');
        const details = text(d.details, 'details', 2000);
        const rep = await q(async (c) => {
          if (!(await store.listingVisible(c, listingId))) throw notFound();
          return store.fileReport(c, uid, { listingId, versionId, reason, details });
        });
        return send(rep.created ? 201 : 200, { id: rep.id }), true;
      }
      throw notFound();
    } catch (e) {
      let status = 500, message = 'Server error.', extra: Record<string, string> = {}, fields: Record<string, unknown> = {};
      if (e instanceof HttpError) { status = e.status; message = e.message; if (status === 429) extra = { 'retry-after': String(e.extra?.retryAfter ?? 60) }; }
      else if (e instanceof BadQuery) { status = 400; message = e.message; }
      else if (e instanceof store.StoreError) { status = e.status; message = e.message; fields = { ...(e.code ? { code: e.code } : {}), ...e.extra }; }
      else if ((e as any)?.code === 'ECONNRESET' || (e as Error)?.message === 'aborted') status = 499;   // the client went away mid-upload: nothing to log
      else console.error(e instanceof ArtifactCorruptError ? `marketplace: ${e.message}` : e);
      // an upload refused for size may still be arriving: do not keep the connection waiting for the rest of it
      if (status === 413) extra = { ...extra, connection: 'close' };
      if (e instanceof store.StoreError && e.code === 'busy') extra = { ...extra, 'retry-after': '5' };
      if (res.headersSent) { res.end(); return true; }
      send(status, { error: message, ...fields }, extra);
      return true;
    }
  };
}
