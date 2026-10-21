// The public marketplace API (/v1/marketplace/*). Reads work without a token and see only public
// published things; every mutation needs a valid token. Authentication is the sync API's (Clerk
// session token or aod_ device token), handed in as `authenticate`. Visibility is decided by
// row-level security in Postgres (the store runs as ao_app with app.user_id set), never here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { ArtifactCorruptError, extractOne, openArtifact, UnpackError, type ArtifactStore } from '../marketplace/artifacts.ts';
import { ByteLru } from '../marketplace/lru.ts';
import { createLimiter, type Limiter } from '../marketplace/ratelimit.ts';
import { BadQuery, parseListParams } from '../marketplace/search.ts';
import * as store from '../marketplace/store.ts';
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
  /** Preview/doc entries (shared; visibility is still checked per request). */
  cache?: ByteLru;
}

const MAX_PREVIEW = 2 * 1024 * 1024, MAX_DOC = 256 * 1024;

const LISTING_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_BODY = 64 * 1024;
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
  const cache = deps.cache ?? new ByteLru();

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
      const mutating = m !== 'GET' && m !== 'HEAD';
      // No Authorization header: an anonymous reader. A header that does not verify is a 401, never a downgrade.
      const signedIn = !!req.headers.authorization;
      if (mutating && !signedIn) throw new HttpError(401, 'Sign in first.');
      const uid = signedIn ? (await deps.authenticate(req)).uid : '';
      const lim = mutating ? limiter : readLimiter;
      const key = uid || `ip:${req.socket?.remoteAddress ?? '?'}`;
      if (!lim.allow(key)) throw new HttpError(429, 'Too many requests. Try again in a minute.', { retryAfter: lim.retryAfter(key) });
      const q = <T>(fn: (c: pg.PoolClient) => Promise<T>) => store.withUser(deps.app, uid, fn);

      // ── catalog
      if (rest === 'listings' && m === 'GET') {
        const p = parseListParams(url.searchParams);
        if (p.installed !== null && !signedIn) throw new HttpError(401, 'Sign in to filter by installed.');
        try { return send(200, await q((c) => store.listListings(c, p))), true; }
        catch (e: any) {
          // belt and braces: a data exception (SQLSTATE class 22) from a query that used the cursor is the caller's bad cursor
          if (p.cursor && typeof e?.code === 'string' && e.code.startsWith('22')) throw bad('invalid page cursor');
          throw e;
        }
      }
      const lm = /^listings\/([^/]+\/[^/]+)(?:\/(favorite|review|reviews|versions))?$/.exec(rest);
      if (lm) {
        const [, id, sub] = lm;
        if (!LISTING_ID.test(id)) throw notFound();
        if (!sub && m === 'GET') {
          const l = await q((c) => store.getListing(c, id));
          if (!l) throw notFound();
          return send(200, l), true;
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
        const a = await openArtifact(deps.app, deps.store, { userId: uid }, vid);
        if (!a) throw notFound();
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': a.bytes.length, 'x-content-sha256': a.sha256, 'cache-control': 'private, no-store' });
        res.end(Buffer.from(a.bytes.buffer, a.bytes.byteOffset, a.bytes.byteLength));
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
          const a = await openArtifact(deps.app, deps.store, { userId: uid }, vid);
          if (!a) throw notFound();
          try { file = extractOne(a.bytes, path, { maxBytes: cap }); }
          catch (e) {
            if (e instanceof UnpackError) throw e.code === 'too-large' ? new HttpError(413, 'That file is too large to preview.') : notFound();
            throw e;
          }
          if (!file) throw notFound();
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
      let status = 500, message = 'Server error.', extra: Record<string, string> = {};
      if (e instanceof HttpError) { status = e.status; message = e.message; if (status === 429) extra = { 'retry-after': String(e.extra?.retryAfter ?? 60) }; }
      else if (e instanceof BadQuery) { status = 400; message = e.message; }
      else if (e instanceof store.StoreError) { status = e.status; message = e.message; }
      else console.error(e instanceof ArtifactCorruptError ? `marketplace: ${e.message}` : e);
      if (res.headersSent) { res.end(); return true; }
      send(status, { error: message }, extra);
      return true;
    }
  };
}
