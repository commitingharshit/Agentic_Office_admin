// The public marketplace API (/v1/marketplace/*). Reads work without a token and see only public
// published things; every mutation needs a valid token. Authentication is the sync API's (Clerk
// session token or aod_ device token), handed in as `authenticate`. Visibility is decided by
// row-level security in Postgres (the store runs as ao_app with app.user_id set), never here.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { ArtifactCorruptError, openArtifact, type ArtifactStore } from '../marketplace/artifacts.ts';
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
}

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
const object = (v: unknown, what: string) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} must be an object.`); return v as Record<string, unknown>; };

export function marketplaceHandler(deps: MarketplaceDeps) {
  const limiter = deps.limiter ?? createLimiter();

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/v1/marketplace' && !url.pathname.startsWith('/v1/marketplace/')) return false;
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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
      if (mutating && !limiter.allow(uid)) throw new HttpError(429, 'Too many requests. Try again in a minute.');
      const q = <T>(fn: (c: pg.PoolClient) => Promise<T>) => store.withUser(deps.app, uid, fn);

      // ── catalog
      if (rest === 'listings' && m === 'GET') {
        const p = parseListParams(url.searchParams);
        if (p.installed !== null && !signedIn) throw new HttpError(401, 'Sign in to filter by installed.');
        return send(200, await q((c) => store.listListings(c, p))), true;
      }
      const lm = /^listings\/(.+?)(?:\/(favorite|review|versions))?$/.exec(rest);
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
        if (sub === 'favorite' && (m === 'PUT' || m === 'DELETE')) {
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            return store.setFavorite(c, uid, id, m === 'PUT');
          })), true;
        }
        if (sub === 'review' && (m === 'PUT' || m === 'DELETE')) {
          let stars = 0, body: string | null = null;
          if (m === 'PUT') {
            const d = await json(req, MAX_BODY);
            if (typeof d.stars !== 'number' || !Number.isInteger(d.stars) || d.stars < 1 || d.stars > 5) throw bad('stars must be an integer from 1 to 5.');
            stars = d.stars; body = text(d.body, 'body', 4000);
          }
          return send(200, await q(async (c) => {
            if (!(await store.listingVisible(c, id))) throw notFound();
            return m === 'PUT' ? store.putReview(c, uid, id, stars, body) : store.deleteReview(c, uid, id);
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

      // ── install acknowledgement and update discovery
      if (rest === 'installs/sync' && m === 'POST') {
        const d = await json(req, MAX_BODY);
        const deviceId = text(d.deviceId, 'deviceId', 80);
        if (!deviceId || !OPAQUE_ID.test(deviceId)) throw bad('deviceId is required.');
        if (!Array.isArray(d.items)) throw bad('items must be an array.');
        if (d.items.length > 200) throw bad('items has too many entries (200 at most).');
        const seen = new Set<string>();
        const items = d.items.map((raw, n): store.InstallItem => {
          const it = object(raw, `items[${n}]`);
          const listingId = text(it.listingId, 'listingId', 200);
          if (!listingId || !LISTING_ID.test(listingId)) throw bad(`items[${n}].listingId is not a valid listing id.`);
          if (seen.has(listingId)) throw bad(`items[${n}].listingId is repeated.`);
          seen.add(listingId);
          const versionId = text(it.versionId, 'versionId', 120);
          if (versionId !== null && !OPAQUE_ID.test(versionId)) throw bad(`items[${n}].versionId is not valid.`);
          if (it.enabled !== undefined && typeof it.enabled !== 'boolean') throw bad(`items[${n}].enabled must be a boolean.`);
          return {
            listingId, versionId, state: oneOf(it.state, store.INSTALL_STATES, `items[${n}].state`), enabled: it.enabled === true,
            scanVerdict: it.scanVerdict === undefined || it.scanVerdict === null ? null : oneOf(it.scanVerdict, store.SCAN_VERDICTS, `items[${n}].scanVerdict`),
            lastError: text(it.lastError, `items[${n}].lastError`, 500),
          };
        });
        return send(200, { updates: await q((c) => store.syncInstalls(c, uid, deviceId, items)) }), true;
      }

      // ── reports
      if (rest === 'reports' && m === 'POST') {
        const d = await json(req, MAX_BODY);
        const listingId = text(d.listingId, 'listingId', 200);
        if (!listingId || !LISTING_ID.test(listingId)) throw bad('listingId is not a valid listing id.');
        const versionId = text(d.versionId, 'versionId', 120);
        if (versionId !== null && !OPAQUE_ID.test(versionId)) throw bad('versionId is not valid.');
        const reason = oneOf(d.reason, store.REPORT_REASONS, 'reason');
        const details = text(d.details, 'details', 2000);
        return send(201, await q(async (c) => {
          if (!(await store.listingVisible(c, listingId))) throw notFound();
          return store.fileReport(c, uid, { listingId, versionId, reason, details });
        })), true;
      }
      throw notFound();
    } catch (e) {
      let status = 500, message = 'Server error.';
      if (e instanceof HttpError) { status = e.status; message = e.message; }
      else if (e instanceof BadQuery) { status = 400; message = e.message; }
      else if (e instanceof store.StoreError) { status = e.status; message = e.message; }
      else console.error(e instanceof ArtifactCorruptError ? `marketplace: ${e.message}` : e);
      if (res.headersSent) { res.end(); return true; }
      send(status, { error: message });
      return true;
    }
  };
}
