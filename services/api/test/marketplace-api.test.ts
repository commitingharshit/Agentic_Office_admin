// The public marketplace API over HTTP against a REAL Postgres (embedded-postgres, real ao_app / ao_admin
// roles, RLS on). Fixtures are created through the ao_admin connection in before(): they exist only here.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { HttpError } from '../src/api/sync.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { zipSync } from 'fflate';
import { memoryArtifactStore, putArtifact, sha256Hex } from '../src/marketplace/artifacts.ts';
import { createLimiter } from '../src/marketplace/ratelimit.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const SHA = (c: string) => c.repeat(64);
const BYTES = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 7) % 256));

describe('marketplace API (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, api: Server, base: string, limited: Server, limitedBase: string, readLimited: Server, readLimitedBase: string;
  const store = memoryArtifactStore();
  let artifactSha = '';

  const call = async (path: string, o: { user?: string; method?: string; body?: unknown; origin?: string } = {}) => {
    const r = await fetch((o.origin ?? base) + path, {
      method: o.method ?? 'GET',
      headers: { ...(o.user ? { authorization: `Bearer ${o.user}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, json: ct.includes('json') ? await r.json() as any : undefined, bytes: ct.includes('zip') ? new Uint8Array(await r.arrayBuffer()) : undefined };
  };
  const ids = (r: { json: any }) => (r.json.items as any[]).map((i) => i.id);

  // Test-only token verifier: the bearer token IS the user id.
  const authenticate = async (req: { headers: { authorization?: string } }) => {
    const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.');
    return { uid: t };
  };

  before(async () => {
    h = await startMarketplacePg();
    admin = h.admin;
    artifactSha = (await putArtifact(store, BYTES)).sha256;
    const app = h.pool('ao_app');
    const make = (limiter?: ReturnType<typeof createLimiter>) => {
      const handler = marketplaceHandler({ app, authenticate, store, limiter });
      return createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404).end(); } });
    };
    api = make(); limited = make(createLimiter({ limit: 3 }));
    { const handler = marketplaceHandler({ app, authenticate, store, readLimiter: createLimiter({ limit: 5 }) });
      readLimited = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); }); }
    await Promise.all([api, limited, readLimited].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    readLimitedBase = `http://127.0.0.1:${(readLimited.address() as AddressInfo).port}`;
    limitedBase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;

    await h.owner.query(`
      INSERT INTO users(id) VALUES ('u1'),('u2'),('u3'),('u4');
      INSERT INTO devices(id, user_id) VALUES ('d2','u2'),('d3','u3'),('d4','u4');`);
    await admin.query(`
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('pa','Pub A','u1',true),('pb','Pub B','u2',false),('pc','Pub C','u1',false);
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('a')}',1,'k'), ('${artifactSha}', ${BYTES.length}, 'k2');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary, tags) VALUES
        ('pa/open','skill','pa','u1','public','official','PDF Toolkit','Merge and split documents','{pdf,tools}'),
        ('pa/rated','skill','pa','u1','public','community','Rated thing','Gets stars','{}'),
        ('pa/unrated','template','pa','u1','public','community','Unrated thing','Nobody rated this yet','{}'),
        ('pa/draftonly','skill','pa','u1','public','community','Draft only listing','never published','{}'),
        ('pa/quar','skill','pa','u1','public','community','Quarantined listing','pulled','{}'),
        ('pa/secret','skill','pa','u1','private','private','Secret notes','only the owner','{}'),
        ('pb/agentx','agent','pb','u2','public','verified','Research agent','Finds sources','{research}'),
        ('pa/revoked','skill','pa','u1','public','community','Revoked thing','was fine once','{}'),
        ('pa/upg','skill','pa','u1','public','community','Upgradeable thing','newer exists','{}'),
        ('pa/dl','skill','pa','u1','public','community','Download thing','has bytes','{}');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES
        ('v_open','pa/open','1.0.0',1,0,0,'published','{"license":"MIT","compat":{"app":"*"},"permissions":[{"capability":"network","scope":"*","reason":"fetch"}],"dependencies":[{"id":"pa/rated","range":"^1.0.0"}]}','${SHA('a')}',1,'clean'),
        ('v_open2','pa/open','1.2.0',1,2,0,'published','{"license":"MIT","compat":{"app":"*"},"permissions":[{"capability":"network","scope":"*","reason":"fetch"}],"dependencies":[{"id":"pa/rated","range":"^1.0.0"}]}','${SHA('a')}',1,'warnings'),
        ('v_open_next','pa/open','2.0.0-beta.1',2,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_open_draft','pa/open','3.0.0',3,0,0,'draft','{}','${SHA('a')}',1,'pending'),
        ('v_open_dep','pa/open','0.9.0',0,9,0,'deprecated','{}','${SHA('a')}',1,'clean'),
        ('v_open_rev','pa/open','0.8.0',0,8,0,'revoked','{}','${SHA('a')}',1,'blocked'),
        ('v_rated','pa/rated','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_unrated','pa/unrated','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_draftonly','pa/draftonly','1.0.0',1,0,0,'draft','{}','${SHA('a')}',1,'pending'),
        ('v_quar','pa/quar','1.0.0',1,0,0,'quarantined','{}','${SHA('a')}',1,'blocked'),
        ('v_secret','pa/secret','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_agentx','pb/agentx','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_revoked','pa/revoked','1.0.0',1,0,0,'revoked','{}','${SHA('a')}',1,'blocked'),
        ('v_revoked_ok','pa/revoked','1.1.0',1,1,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_upg1','pa/upg','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_upg2','pa/upg','1.1.0',1,1,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_dl','pa/dl','1.0.0',1,0,0,'published','{}','${artifactSha}',${BYTES.length},'clean');
      INSERT INTO marketplace_release_events(listing_id, version_id, event, detail) VALUES ('pa/revoked','v_revoked','revoked','{"reason":"malware found"}');
      -- 30 listings for pagination
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, summary)
        SELECT 'pc/bulk-' || lpad(n::text, 2, '0'), 'template', 'pc', 'u1', 'public', 'Bulk template ' || n, 'bulkword filler' FROM generate_series(1, 30) n;
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size)
        SELECT 'v_bulk' || n, 'pc/bulk-' || lpad(n::text, 2, '0'), '1.0.0', 1, 0, 0, 'published', '{}', '${SHA('a')}', 1 FROM generate_series(1, 30) n;
      -- three raters for the exact-mean test, directly in the table
      INSERT INTO marketplace_reviews(id, listing_id, user_id, stars) VALUES ('r1','pa/rated','u2',5),('r2','pa/rated','u3',2),('r3','pa/rated','u4',2);`);
    // installs: d2 has the revoked version of pa/revoked and the old version of pa/upg
    await admin.query(`
      INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES
        ('i1','u2','d2','pa/revoked','v_revoked','enabled',true),
        ('i2','u2','d2','pa/upg','v_upg1','installed',false)`);
  });
  after(async () => { api?.close(); limited?.close(); readLimited?.close(); if (h) await h.stop(); });

  // ── auth
  test('mutations_require_a_token_and_a_bad_token_is_not_a_downgrade', async () => {
    assert.equal((await call('/v1/marketplace/listings/pa/open/review', { method: 'PUT', body: { stars: 4 } })).status, 401);
    assert.equal((await call('/v1/marketplace/listings/pa/open/favorite', { method: 'PUT' })).status, 401);
    assert.equal((await call('/v1/marketplace/installs/sync', { method: 'POST', body: { deviceId: 'd2', items: [] } })).status, 401);
    assert.equal((await call('/v1/marketplace/reports', { method: 'POST', body: { listingId: 'pa/open', reason: 'other' } })).status, 401);
    assert.equal((await call('/v1/marketplace/listings', { user: 'bogus' })).status, 401);
  });

  // ── ratings
  test('unrated_listing_has_null_average_and_zero_counts', async () => {
    const r = await call('/v1/marketplace/listings/pa/unrated');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.stats, { ratingAvg: null, ratingCount: 0, favoriteCount: 0, installCount: 0 });
  });

  test('rating_average_is_the_exact_mean_of_three_users', async () => {
    const r = await call('/v1/marketplace/listings/pa/rated');
    assert.equal(r.json.stats.ratingCount, 3);
    assert.equal(r.json.stats.ratingAvg, 3);   // (5 + 2 + 2) / 3 = 3
  });

  test('second_rate_by_the_same_user_updates_instead_of_adding', async () => {
    const first = await call('/v1/marketplace/listings/pa/open/review', { user: 'u2', method: 'PUT', body: { stars: 5, body: 'great' } });
    assert.equal(first.status, 200);
    assert.deepEqual([first.json.stats.ratingCount, first.json.stats.ratingAvg], [1, 5]);
    const second = await call('/v1/marketplace/listings/pa/open/review', { user: 'u2', method: 'PUT', body: { stars: 2 } });
    assert.deepEqual([second.json.stats.ratingCount, second.json.stats.ratingAvg], [1, 2]);
    const rows = await admin.query(`SELECT stars, body FROM marketplace_reviews WHERE listing_id = 'pa/open'`);
    assert.deepEqual(rows.rows, [{ stars: 2, body: null }]);
    const other = await call('/v1/marketplace/listings/pa/open/review', { user: 'u3', method: 'PUT', body: { stars: 4 } });
    assert.deepEqual([other.json.stats.ratingCount, other.json.stats.ratingAvg], [2, 3]);
    const del = await call('/v1/marketplace/listings/pa/open/review', { user: 'u3', method: 'DELETE' });
    assert.equal(del.json.stats.ratingCount, 1);
    await call('/v1/marketplace/listings/pa/open/review', { user: 'u2', method: 'DELETE' });
    assert.equal((await call('/v1/marketplace/listings/pa/open')).json.stats.ratingAvg, null);
  });

  test('review_input_is_validated', async () => {
    for (const body of [{ stars: 0 }, { stars: 6 }, { stars: 3.5 }, { stars: '4' }, {}, { stars: 3, body: 'x'.repeat(4001) }, { stars: 3, body: 7 }]) {
      assert.equal((await call('/v1/marketplace/listings/pa/open/review', { user: 'u2', method: 'PUT', body })).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal((await call('/v1/marketplace/listings/pa/secret/review', { user: 'u2', method: 'PUT', body: { stars: 3 } })).status, 404);
  });

  // ── visibility
  test('draft_quarantined_and_foreign_private_listings_are_hidden_but_the_owner_sees_private', async () => {
    const anon = await call('/v1/marketplace/listings?limit=100');
    assert.ok(ids(anon).includes('pa/open'));
    for (const hidden of ['pa/draftonly', 'pa/quar', 'pa/secret']) assert.ok(!ids(anon).includes(hidden), hidden);
    for (const hidden of ['pa/draftonly', 'pa/quar', 'pa/secret']) {
      assert.equal((await call(`/v1/marketplace/listings/${hidden}`)).status, 404, hidden);
      assert.equal((await call(`/v1/marketplace/listings/${hidden}`, { user: 'u2' })).status, 404, hidden);
      assert.equal((await call(`/v1/marketplace/listings/${hidden}/versions`, { user: 'u2' })).status, 404, hidden);
    }
    assert.equal((await call('/v1/marketplace/listings/pa/nope')).status, 404);
    assert.ok(!ids(await call('/v1/marketplace/listings?limit=100', { user: 'u2' })).includes('pa/secret'));
    assert.ok(ids(await call('/v1/marketplace/listings?limit=100', { user: 'u1' })).includes('pa/secret'));
    const own = await call('/v1/marketplace/listings/pa/secret', { user: 'u1' });
    assert.equal(own.status, 200);
    assert.equal(own.json.visibility, 'private');
  });

  // ── search and filters
  test('q_matches_title_summary_and_tags_and_filters_apply', async () => {
    const q = async (qs: string, user?: string) => ids(await call(`/v1/marketplace/listings?${qs}`, { user }));
    assert.deepEqual(await q('q=toolkit'), ['pa/open']);              // title
    assert.deepEqual(await q('q=split'), ['pa/open']);                // summary
    assert.deepEqual(await q('q=pdf'), ['pa/open']);                  // tag
    assert.deepEqual(await q('q=zzzznothing'), []);
    assert.deepEqual(await q('type=agent'), ['pb/agentx']);
    assert.deepEqual(await q('trust=verified'), ['pb/agentx']);
    assert.deepEqual(await q('trust=official'), ['pa/open']);
    assert.deepEqual(await q('publisher=pb'), ['pb/agentx']);
    assert.deepEqual(await q('type=skill&trust=community&q=rated'), ['pa/rated']);
  });

  test('bad_enum_or_parameter_is_400', async () => {
    for (const qs of ['type=wizard', 'trust=gold', 'installed=maybe', 'limit=0', 'limit=abc', 'publisher=BAD/ID', 'page=not-a-cursor']) {
      const r = await call(`/v1/marketplace/listings?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.ok(typeof r.json.error === 'string');
    }
  });

  test('pagination_returns_every_item_exactly_once', async () => {
    const seen: string[] = [];
    let page: string | null = null, pages = 0;
    do {
      const r: any = await call(`/v1/marketplace/listings?q=bulkword&limit=7${page ? `&page=${encodeURIComponent(page)}` : ''}`);
      assert.equal(r.status, 200);
      seen.push(...ids(r)); page = r.json.nextPage; pages++;
    } while (page && pages < 20);
    assert.equal(pages, 5);
    assert.equal(seen.length, 30);
    assert.equal(new Set(seen).size, 30);
    // default page size is 24, and the unfiltered catalog is paged too
    const first = await call('/v1/marketplace/listings');
    assert.equal(first.json.items.length, 24);
    assert.ok(first.json.nextPage);
    const all: string[] = []; page = null;
    do { const r: any = await call(`/v1/marketplace/listings${page ? `?page=${encodeURIComponent(page)}` : ''}`); all.push(...ids(r)); page = r.json.nextPage; } while (page);
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.length >= 30 + 5);
  });

  test('cards_carry_latest_published_version_stats_and_caller_state', async () => {
    const r = await call('/v1/marketplace/listings?q=toolkit', { user: 'u2' });
    const item = r.json.items[0];
    assert.equal(item.latestVersion, '1.2.0');          // stable beats the 2.0.0-beta.1, draft 3.0.0 is ignored
    assert.deepEqual(Object.keys(item).sort(), ['capabilities', 'id', 'latestVersion', 'latestVersionId', 'previews', 'publisher', 'stats', 'summary', 'title', 'trust', 'type', 'verification', 'viewer', 'visibility']);
    assert.deepEqual(item.verification, { verified: false, verdict: null, skipped: 0 });   // never verified: no badge
    assert.equal(item.publisher, 'pa');
    assert.equal(item.viewer.favorited, false);
    const inst = await call('/v1/marketplace/listings?installed=true', { user: 'u2' });
    assert.deepEqual(ids(inst).sort(), ['pa/revoked', 'pa/upg']);
    assert.ok((inst.json.items as any[]).every((i) => i.viewer.installedVersion === '1.0.0'));   // incl. the revoked one: installed_status sees it
    assert.ok(!ids(await call('/v1/marketplace/listings?installed=false&limit=100', { user: 'u2' })).includes('pa/upg'));
    assert.equal((await call('/v1/marketplace/listings?installed=true')).status, 401);
  });

  // ── detail and versions
  test('detail_has_publisher_manifest_summary_and_security', async () => {
    const r = await call('/v1/marketplace/listings/pa/open');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.publisherInfo, { id: 'pa', displayName: 'Pub A', verified: true });
    assert.equal(r.json.manifest.version, '1.2.0');
    assert.equal(r.json.manifest.permissions[0].capability, 'network');
    assert.deepEqual(r.json.manifest.dependencies, [{ id: 'pa/rated', range: '^1.0.0' }]);
    assert.deepEqual(r.json.security, { scanVerdict: 'warnings' });
    assert.deepEqual(r.json.tags, ['pdf', 'tools']);
  });

  test('versions_list_hides_revoked_and_draft_from_non_owners', async () => {
    const v = (await call('/v1/marketplace/listings/pa/open/versions')).json.versions as any[];
    assert.deepEqual(v.map((x) => x.version), ['2.0.0-beta.1', '1.2.0', '1.0.0', '0.9.0']);
    assert.ok(v.find((x) => x.version === '0.9.0').state === 'deprecated');
    const owner = (await call('/v1/marketplace/listings/pa/open/versions', { user: 'u1' })).json.versions as any[];
    assert.ok(owner.some((x) => x.state === 'revoked') && owner.some((x) => x.state === 'draft'));
  });

  // ── artifact bytes
  test('artifact_returns_exact_bytes_and_hash_404_invisible_410_revoked', async () => {
    const ok = await call('/v1/marketplace/versions/v_dl/artifact');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/zip');
    assert.equal(ok.headers.get('x-content-sha256'), artifactSha);
    assert.deepEqual(Buffer.from(ok.bytes!), Buffer.from(BYTES));
    assert.equal((await call('/v1/marketplace/versions/v_secret/artifact')).status, 404);          // private listing, anonymous
    assert.equal((await call('/v1/marketplace/versions/v_secret/artifact', { user: 'u2' })).status, 404);
    assert.equal((await call('/v1/marketplace/versions/v_open_draft/artifact', { user: 'u2' })).status, 404);
    assert.equal((await call('/v1/marketplace/versions/nope/artifact')).status, 404);
    // revoked / quarantined: 410 for the owner (can see it) and for someone who installed it; 404 for strangers
    assert.equal((await call('/v1/marketplace/versions/v_revoked/artifact', { user: 'u1' })).status, 410);
    assert.equal((await call('/v1/marketplace/versions/v_revoked/artifact', { user: 'u2' })).status, 410);
    assert.equal((await call('/v1/marketplace/versions/v_quar/artifact', { user: 'u1' })).status, 410);
    assert.equal((await call('/v1/marketplace/versions/v_revoked/artifact', { user: 'u3' })).status, 404);
  });

  // ── favorites
  test('favorite_is_idempotent_and_counted_once', async () => {
    const put = () => call('/v1/marketplace/listings/pa/unrated/favorite', { user: 'u3', method: 'PUT' });
    assert.equal((await put()).json.stats.favoriteCount, 1);
    const again = await put();
    assert.equal(again.status, 200);
    assert.equal(again.json.stats.favoriteCount, 1);
    assert.equal((await call('/v1/marketplace/listings/pa/unrated', { user: 'u3' })).json.viewer.favorited, true);
    assert.equal((await call('/v1/marketplace/listings/pa/unrated', { user: 'u2' })).json.viewer.favorited, false);
    assert.equal((await call('/v1/marketplace/listings/pa/unrated/favorite', { user: 'u2', method: 'PUT' })).json.stats.favoriteCount, 2);
    const del = () => call('/v1/marketplace/listings/pa/unrated/favorite', { user: 'u3', method: 'DELETE' });
    assert.equal((await del()).json.stats.favoriteCount, 1);
    assert.equal((await del()).json.stats.favoriteCount, 1);
    assert.equal((await call('/v1/marketplace/listings/pa/secret/favorite', { user: 'u3', method: 'PUT' })).status, 404);
  });

  // ── installs/sync
  test('install_sync_flags_revoked_versions_and_newer_releases', async () => {
    const r = await call('/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items: [] } });
    assert.equal(r.status, 200);
    const by = Object.fromEntries((r.json.updates as any[]).map((u) => [u.listingId, u]));
    assert.equal(by['pa/revoked'].state, 'update_available');
    assert.equal(by['pa/revoked'].reason, 'revoked');
    assert.equal(by['pa/revoked'].revoked, true);
    assert.equal(by['pa/revoked'].detail, 'malware found');
    assert.equal(by['pa/revoked'].installedVersion, '1.0.0');
    assert.equal(by['pa/revoked'].latest, '1.1.0');
    assert.equal(by['pa/upg'].state, 'update_available');
    assert.equal(by['pa/upg'].installedVersion, '1.0.0');
    assert.equal(by['pa/upg'].latest, '1.1.0');
    assert.equal(by['pa/upg'].revoked, undefined);
  });

  test('install_sync_acknowledges_installs_and_failures_and_rejects_foreign_devices', async () => {
    const ack = await call('/v1/marketplace/installs/sync', { user: 'u3', method: 'POST', body: {
      deviceId: 'd3', items: [{ listingId: 'pa/rated', versionId: 'v_rated', state: 'enabled', enabled: true, scanVerdict: 'clean' }, { listingId: 'pa/unrated', state: 'failed', enabled: false, lastError: 'disk full' }] } });
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.json.updates, []);
    const rows = (await admin.query(`SELECT listing_id, version_id, state, enabled, last_error FROM marketplace_installs WHERE user_id = 'u3' ORDER BY listing_id`)).rows;
    assert.deepEqual(rows, [
      { listing_id: 'pa/rated', version_id: 'v_rated', state: 'enabled', enabled: true, last_error: null },
      { listing_id: 'pa/unrated', version_id: null, state: 'failed', enabled: false, last_error: 'other: disk full' }]);
    assert.equal((await call('/v1/marketplace/listings/pa/rated')).json.stats.installCount, 1);   // a failure is not an install
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM marketplace_install_events WHERE user_id = 'u3'`)).rows[0].n, 2);
    // re-sending changes the same row; uninstall drops the count
    await call('/v1/marketplace/installs/sync', { user: 'u3', method: 'POST', body: { deviceId: 'd3', items: [{ listingId: 'pa/rated', state: 'uninstalled', enabled: false }] } });
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM marketplace_installs WHERE user_id = 'u3'`)).rows[0].n, 2);
    assert.equal((await call('/v1/marketplace/listings/pa/rated')).json.stats.installCount, 0);
    // a device that belongs to someone else
    const foreign = await call('/v1/marketplace/installs/sync', { user: 'u3', method: 'POST', body: { deviceId: 'd2', items: [{ listingId: 'pa/rated', state: 'installed', enabled: true }] } });
    assert.equal(foreign.status, 404);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM marketplace_installs WHERE device_id = 'd2' AND user_id = 'u3'`)).rows[0].n, 0);
    // validation
    // a malformed item is reported per item (the rest of the batch still applies)
    for (const item of [{ listingId: 'pa/rated', state: 'bogus' }, { listingId: 'pa/rated', state: 'failed', lastError: 'x'.repeat(501) }, { listingId: 'NOT AN ID', state: 'failed' }, { listingId: 'pa/rated', state: 'failed', scanVerdict: 'meh' }]) {
      const r = await call('/v1/marketplace/installs/sync', { user: 'u3', method: 'POST', body: { deviceId: 'd3', items: [item] } });
      assert.equal(r.status, 200, JSON.stringify(item));
      assert.equal(r.json.results[0].ok, false);
      assert.equal(r.json.results[0].code, 'invalid');
    }
    assert.equal((await call('/v1/marketplace/installs/sync', { user: 'u3', method: 'POST', body: { items: [] } })).status, 400);
  });

  // ── review round 1
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  test('forged_page_cursors_are_400_never_500', async () => {
    const ok = { r: '0.5', u: '2026-01-01T00:00:00.123456Z', id: 'pa/open' };
    const forged = [
      { ...ok, r: '1e999' }, { ...ok, r: '0.5e-400' }, { ...ok, r: '-1' }, { ...ok, u: '2026-02-31T00:00:00.000000Z' }, { ...ok, u: '0000-01-01T00:00:00Z' }, { ...ok, u: '2101-01-01T00:00:00Z' }, { ...ok, u: '2026-01-01T00:00:00+00' }, { ...ok, u: '2026-01-01 00:00:00.123456+00' }, { ...ok, r: '0x10' }, { ...ok, r: '' }, { ...ok, r: '1e' }, { ...ok, r: 'NaN' }, { ...ok, r: ' 1' },
      { ...ok, u: '' }, { ...ok, u: 'Jan 1 2020' }, { ...ok, u: '2026-13-45T00:00:00Z' }, { ...ok, u: 'now' },
      { ...ok, id: 'a\u0000b/c' }, { ...ok, id: '' }, { ...ok, id: 'NOT/ok!' }, { ...ok, id: 5 }, { ...ok, r: 1 },
    ];
    for (const c of forged) assert.equal((await call(`/v1/marketplace/listings?page=${b64(c)}`)).status, 400, JSON.stringify(c));
    for (const raw of ['null', '[]', '"x"', '{']) assert.equal((await call(`/v1/marketplace/listings?page=${Buffer.from(raw).toString('base64url')}`)).status, 400, raw);
    assert.equal((await call(`/v1/marketplace/listings?page=${b64(ok)}`)).status, 200);
    // well-formed cursor naming a listing that does not exist: a valid (here empty or later) page, never an error
    assert.equal((await call(`/v1/marketplace/listings?page=${b64({ ...ok, id: 'zz/nothing' })}`)).status, 200);
  });

  // The cursor must not depend on the Postgres session time zone (production runs UTC).
  for (const tz of ['UTC', 'Asia/Kolkata', 'Etc/GMT+8']) {
    test(`pagination_is_timezone_independent_${tz.replace(/\W/g, '_')}`, async () => {
      const pool = h.pool('ao_app', 2, { options: `-c TimeZone=${tz}` });
      const handler = marketplaceHandler({ app: pool, authenticate, store });
      const srv = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      try {
        const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
        assert.equal((await pool.query('SHOW TimeZone')).rows[0].TimeZone, tz);
        const seen: string[] = []; let page: string | null = null, pages = 0;
        do {
          const r: any = await call(`/v1/marketplace/listings?q=bulkword&limit=7${page ? `&page=${encodeURIComponent(page)}` : ''}`, { origin });
          assert.equal(r.status, 200, `page ${pages} in ${tz}`);
          seen.push(...ids(r)); page = r.json.nextPage; pages++;
        } while (page && pages < 20);
        assert.equal(seen.length, 30);
        assert.equal(new Set(seen).size, 30);
      } finally { srv.close(); }
    });
  }

  test('install_sync_survives_a_sql_error_in_one_item', async () => {
    // a NUL byte passes the code's validation but Postgres rejects it (22021) inside the item's savepoint
    const r = await call('/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items: [
      { listingId: 'pa/unrated', state: 'installed', enabled: true },
      { listingId: 'pa/rated', state: 'failed', lastError: 'bad \u0000 byte' },
      { listingId: 'pa/dl', versionId: 'v_dl', state: 'enabled', enabled: true },
    ] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, [{ listingId: 'pa/unrated', ok: true }, { listingId: 'pa/rated', ok: false, code: 'rejected' }, { listingId: 'pa/dl', ok: true }]);
    const rows = (await admin.query(`SELECT listing_id FROM marketplace_installs WHERE user_id = 'u2' AND device_id = 'd2' ORDER BY listing_id`)).rows.map((x) => x.listing_id);
    assert.deepEqual(rows, ['pa/dl', 'pa/revoked', 'pa/unrated', 'pa/upg']);
    assert.ok((r.json.updates as any[]).some((u) => u.listingId === 'pa/revoked' && u.revoked));
    await admin.query(`DELETE FROM marketplace_installs WHERE user_id = 'u2' AND listing_id IN ('pa/unrated','pa/dl')`);
  });

  test('non_object_json_bodies_are_400', async () => {
    const routes: Array<[string, string]> = [['/v1/marketplace/listings/pa/open/review', 'PUT'], ['/v1/marketplace/installs/sync', 'POST'], ['/v1/marketplace/reports', 'POST']];
    for (const [path, method] of routes) {
      for (const raw of ['null', '[]', '"str"', '7', '{', 'true']) {
        const r = await fetch(base + path, { method, headers: { authorization: 'Bearer u4', 'content-type': 'application/json' }, body: raw });
        assert.equal(r.status, 400, `${method} ${path} ${raw}`);
        assert.ok(typeof (await r.json() as any).error === 'string');
      }
    }
  });

  test('install_sync_is_per_item_and_still_delivers_revocations', async () => {
    const r = await call('/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items: [
      { listingId: 'pa/secret', state: 'installed', enabled: true },                       // invisible
      { listingId: 'pa/unrated', versionId: 'v_unrated', state: 'enabled', enabled: true }, // valid
      { listingId: 'pa/rated', versionId: 'v_agentx', state: 'installed' },                 // version of another listing
      { listingId: 'pa/nope', state: 'installed' },                                         // unknown
    ] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, [
      { listingId: 'pa/secret', ok: false, code: 'not_found' }, { listingId: 'pa/unrated', ok: true },
      { listingId: 'pa/rated', ok: false, code: 'not_found' }, { listingId: 'pa/nope', ok: false, code: 'not_found' }]);
    const row = (await admin.query(`SELECT state FROM marketplace_installs WHERE user_id = 'u2' AND listing_id = 'pa/unrated'`)).rows;
    assert.deepEqual(row, [{ state: 'enabled' }]);
    const revoked = (r.json.updates as any[]).find((u) => u.listingId === 'pa/revoked');
    assert.equal(revoked.reason, 'revoked');
    assert.equal(revoked.revoked, true);
    // updating the install of an already revoked version is allowed too (state change only)
    const upd = await call('/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items: [{ listingId: 'pa/revoked', state: 'disabled', enabled: false }] } });
    assert.deepEqual(upd.json.results, [{ listingId: 'pa/revoked', ok: true }]);
    assert.ok((upd.json.updates as any[]).some((u) => u.listingId === 'pa/revoked' && u.revoked));
    await admin.query(`DELETE FROM marketplace_installs WHERE user_id = 'u2' AND listing_id = 'pa/unrated'`);
  });

  test('install_sync_caps_items_at_200', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ listingId: `pc/bulk-${String(i % 30 + 1).padStart(2, '0')}`, state: 'installed' }));
    assert.equal((await call('/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items } })).status, 400);
  });

  test('route_regex_is_anchored_for_reserved_looking_slugs', async () => {
    await admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pa/versions','skill','pa','u1','public','Odd one')`);
    await admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES ('v_odd','pa/versions','1.0.0',1,0,0,'published','{}','${SHA('a')}',1)`);
    const r = await call('/v1/marketplace/listings/pa/versions');
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 'pa/versions');
    assert.equal((await call('/v1/marketplace/listings/pa/versions/versions')).json.versions.length, 1);
    await admin.query(`DELETE FROM marketplace_listings WHERE id = 'pa/versions'`);
  });

  test('429_carries_retry_after_and_reads_have_their_own_limiter', async () => {
    const put = () => call('/v1/marketplace/listings/pa/rated/favorite', { user: 'u3', method: 'PUT', origin: limitedBase });
    for (let i = 0; i < 3; i++) await put();
    const r = await put();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    for (let i = 0; i < 5; i++) assert.equal((await call('/v1/marketplace/listings', { origin: readLimitedBase })).status, 200);
    const blocked = await call('/v1/marketplace/listings', { origin: readLimitedBase });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  });

  // ── reports
  test('report_is_stored_and_validated', async () => {
    const r = await call('/v1/marketplace/reports', { user: 'u4', method: 'POST', body: { listingId: 'pa/open', versionId: 'v_open', reason: 'malware', details: 'it does bad things' } });
    assert.equal(r.status, 201);
    const row = (await admin.query(`SELECT listing_id, reporter_user_id, reason, state FROM marketplace_reports WHERE id = $1`, [r.json.id])).rows[0];
    assert.equal(row.listing_id, 'pa/open');
    assert.equal(row.reporter_user_id, 'u4');
    assert.equal(row.state, 'open');
    assert.equal(row.reason, 'malware');
    const extra = (await admin.query(`SELECT version_id, details FROM marketplace_reports WHERE id = $1`, [r.json.id])).rows[0];
    assert.deepEqual(extra, { version_id: 'v_open', details: 'it does bad things' });
    // the same (reporter, listing, reason) again is idempotent: 200, still one row
    const again = await call('/v1/marketplace/reports', { user: 'u4', method: 'POST', body: { listingId: 'pa/open', reason: 'malware', details: 'again' } });
    assert.equal(again.status, 200);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM marketplace_reports WHERE reporter_user_id = 'u4' AND listing_id = 'pa/open' AND reason = 'malware'`)).rows[0].n, 1);
    for (const body of [{ listingId: 'pa/open', reason: 'rude' }, { listingId: 'pa/open', reason: 'other', details: 'x'.repeat(2001) }, { reason: 'other' }]) {
      assert.equal((await call('/v1/marketplace/reports', { user: 'u4', method: 'POST', body })).status, 400);
    }
    assert.equal((await call('/v1/marketplace/reports', { user: 'u4', method: 'POST', body: { listingId: 'pa/secret', reason: 'other' } })).status, 404);
  });

  test('request_body_is_capped_at_64_KiB', async () => {
    const r = await call('/v1/marketplace/reports', { user: 'u4', method: 'POST', body: { listingId: 'pa/open', reason: 'other', details: 'x'.repeat(70_000) } });
    assert.equal(r.status, 413);
  });

  // ── rate limit
  test('mutating_routes_are_rate_limited_per_user', async () => {
    const put = (user: string) => call('/v1/marketplace/listings/pa/rated/favorite', { user, method: 'PUT', origin: limitedBase });
    assert.deepEqual([(await put('u4')).status, (await put('u4')).status, (await put('u4')).status], [200, 200, 200]);
    assert.equal((await put('u4')).status, 429);
    assert.equal((await put('u2')).status, 200);      // another user has their own window
    assert.equal((await call('/v1/marketplace/listings', { user: 'u4', origin: limitedBase })).status, 200);   // reads are not limited
  });


  // ── previews, docs, files, sort (read-only views into a version's package)
  describe('package views', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
    const enc = (t: string) => new TextEncoder().encode(t);
    const pkg = (type: string, id: string, files: Record<string, Uint8Array>, payload: Record<string, unknown>) => {
      const manifest = { schema: 'agentic.marketplace/1', id, type, version: '1.0.0', title: 'T', summary: 'S', license: 'MIT', compat: { app: '*' }, dependencies: [], permissions: [],
        files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload };
      const bytes = zipSync({ 'agentic.marketplace.json': enc(JSON.stringify(manifest)), ...files });
      return { manifest, bytes };
    };
    before(async () => {
      const tpl = pkg('template', 'pa/tpl', { 'doc.docx': enc('x'), 'p/one.png': PNG, 'p/fake.png': enc('<svg onload=alert(1)/>') }, { format: 'docx', file: 'doc.docx', previews: ['p/one.png', 'p/fake.png', 'missing.png'] });
      const skill = pkg('skill', 'pa/skl', { 'SKILL.md': enc('---\nname: skl\ndescription: d\n---\n# Hi\n') }, { name: 'skl', entry: 'SKILL.md' });
      const secret = pkg('template', 'pa/tplsecret', { 'p/one.png': PNG }, { format: 'docx', file: 'doc.docx', previews: ['p/one.png'] });
      for (const [id, p, vis, ver] of [['pa/tpl', tpl, 'public', 'v_tpl'], ['pa/skl', skill, 'public', 'v_skl'], ['pa/tplsecret', secret, 'private', 'v_tplsecret']] as const) {
        const { sha256, size } = await putArtifact(store, p.bytes);
        await admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,'k') ON CONFLICT DO NOTHING`, [sha256, size]);
        await admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, summary) VALUES ($1,$2,'pa','u1',$3,'Pkg ' || $1,'pkg view')`, [id, p.manifest.type, vis]);
        await admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ($1,$2,'1.0.0',1,0,0,'published',$3,$4,$5,'clean')`, [ver, id, JSON.stringify(p.manifest), sha256, size]);
      }
    });

    test('preview_serves_the_nth_image_with_a_type_from_the_magic_bytes', async () => {
      const r = await fetch(`${base}/v1/marketplace/versions/v_tpl/preview/0`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
    });
    test('preview_refuses_non_images_missing_files_and_out_of_range_indexes', async () => {
      for (const n of [1, 2, 3, 99]) assert.equal((await call(`/v1/marketplace/versions/v_tpl/preview/${n}`)).status, 404, `preview ${n}`);  // svg-looking bytes, missing path, past the end
      assert.equal((await call('/v1/marketplace/versions/v_skl/preview/0')).status, 404);                                                // a skill has no previews
    });
    test('preview_and_doc_follow_artifact_visibility', async () => {
      assert.equal((await call('/v1/marketplace/versions/v_tplsecret/preview/0')).status, 404);
      assert.equal((await call('/v1/marketplace/versions/v_tplsecret/preview/0', { user: 'u2' })).status, 404);
      assert.equal((await call('/v1/marketplace/versions/v_tplsecret/preview/0', { user: 'u1' })).status, 200);
      assert.equal((await call('/v1/marketplace/versions/v_revoked/preview/0', { user: 'u1' })).status, 410);
      assert.equal((await call('/v1/marketplace/versions/nope/doc')).status, 404);
    });
    test('doc_serves_the_skill_entry_as_markdown_and_404s_for_templates', async () => {
      const r = await fetch(`${base}/v1/marketplace/versions/v_skl/doc`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') ?? '', /^text\/markdown/);
      assert.match(await r.text(), /# Hi/);
      assert.equal((await call('/v1/marketplace/versions/v_tpl/doc')).status, 404);
    });
    test('cards_report_the_latest_version_id_and_the_declared_preview_count; detail lists file hashes', async () => {
      const list = await call('/v1/marketplace/listings?q=pkg');
      const tpl = (list.json.items as any[]).find((i) => i.id === 'pa/tpl');
      assert.equal(tpl.latestVersionId, 'v_tpl');
      assert.equal(tpl.previews, 3);
      assert.equal((list.json.items as any[]).find((i) => i.id === 'pa/skl').previews, 0);
      const d = await call('/v1/marketplace/listings/pa/tpl');
      assert.equal(d.json.manifest.files.length, 3);
      assert.deepEqual(Object.keys(d.json.manifest.files[0]).sort(), ['path', 'sha256', 'size']);
      assert.deepEqual((await call('/v1/marketplace/listings/pa/open')).json.manifest.files, []);   // a version whose stored manifest has no file list
    });

    test('preview_over_the_2MiB_cap_is_413_and_doc_cap_applies', async () => {
      const big = new Uint8Array(3 * 1024 * 1024); big.set(PNG);
      const p = pkg('template', 'pa/tplbig', { 'p/big.png': big }, { format: 'docx', file: 'doc.docx', previews: ['p/big.png'] });
      const { sha256, size } = await putArtifact(store, p.bytes);
      await admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,'k') ON CONFLICT DO NOTHING`, [sha256, size]);
      await admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, summary) VALUES ('pa/tplbig','template','pa','u1','public','Big','b')`);
      await admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ('v_tplbig','pa/tplbig','1.0.0',1,0,0,'published',$1,$2,$3,'clean')`, [JSON.stringify(p.manifest), sha256, size]);
      assert.equal((await call('/v1/marketplace/versions/v_tplbig/preview/0')).status, 413);
    });
    test('a cached preview is never served to someone who cannot see the version (RLS runs on every request)', async () => {
      const ok = await fetch(`${base}/v1/marketplace/versions/v_tplsecret/preview/0`, { headers: { authorization: 'Bearer u1' } });
      assert.equal(ok.status, 200);                                        // owner: fills the cache
      assert.equal(ok.headers.get('cache-control'), 'private, no-store');  // private listing: never cacheable by a browser
      assert.equal((await call('/v1/marketplace/versions/v_tplsecret/preview/0')).status, 404);
      assert.equal((await call('/v1/marketplace/versions/v_tplsecret/preview/0', { user: 'u2' })).status, 404);
      const pub = await fetch(`${base}/v1/marketplace/versions/v_tpl/preview/0`);
      assert.equal(pub.headers.get('cache-control'), 'private, max-age=3600, immutable');   // public + published
      assert.equal((await fetch(`${base}/v1/marketplace/versions/v_tpl/preview/0`)).status, 200); // second call: from the cache
    });
    test('reviews_are_capped_at_50_with_a_cursor_that_reaches_older_ones', async () => {
      await h.owner.query(`INSERT INTO users(id) SELECT 'rv' || n FROM generate_series(1, 60) n ON CONFLICT DO NOTHING`);
      await admin.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, created_at) SELECT 'rvw' || n, 'pa/dl', 'rv' || n, 1 + (n % 5), now() - (n || ' minutes')::interval FROM generate_series(1, 60) n`);
      const first = await call('/v1/marketplace/listings/pa/dl/reviews');
      assert.equal(first.json.reviews.length, 50);
      assert.ok(first.json.nextPage);
      const second = await call(`/v1/marketplace/listings/pa/dl/reviews?page=${first.json.nextPage}`);
      assert.equal(second.json.reviews.length, 10);
      assert.equal(second.json.nextPage, null);
      const all = [...first.json.reviews, ...second.json.reviews].map((r: any) => r.createdAt);
      assert.deepEqual([...all].sort().reverse(), all);                    // newest first across pages
      assert.equal(new Set(all).size, 60);
      for (const bad of ['!!', Buffer.from('{"t":"x","id":"y"}').toString('base64url')]) assert.equal((await call(`/v1/marketplace/listings/pa/dl/reviews?page=${bad}`)).status, 400);
    });
    test('cards_list_the_distinct_capabilities_of_the_latest_version', async () => {
      const open = (await call('/v1/marketplace/listings?q=toolkit')).json.items[0];
      assert.deepEqual(open.capabilities, ['network']);
      assert.deepEqual((await call('/v1/marketplace/listings?q=unrated')).json.items[0].capabilities, []);
    });
    test('reviews_list_is_newest_first_hides_identity_and_marks_the_callers_own', async () => {
      const anon = await call('/v1/marketplace/listings/pa/rated/reviews');
      assert.equal(anon.status, 200);
      assert.equal(anon.json.reviews.length, 3);
      assert.ok(anon.json.reviews.every((r: any) => r.mine === false && !('userId' in r) && !('user_id' in r)));
      const mine = await call('/v1/marketplace/listings/pa/rated/reviews', { user: 'u2' });
      assert.deepEqual(mine.json.reviews.filter((r: any) => r.mine).map((r: any) => r.stars), [5]);
      assert.equal((await call('/v1/marketplace/listings/pa/secret/reviews')).status, 404);
    });
    test('sort_updated_ignores_text_rank_and_pages_cleanly; a bad sort is 400', async () => {
      const seen: string[] = [];
      let page: string | null = null;
      do {
        const r = await call(`/v1/marketplace/listings?q=bulkword&sort=updated&limit=7${page ? `&page=${page}` : ''}`);
        assert.equal(r.status, 200);
        seen.push(...ids(r)); page = r.json.nextPage;
      } while (page);
      assert.equal(seen.length, 30);
      assert.equal(new Set(seen).size, 30);
      assert.equal((await call('/v1/marketplace/listings?sort=popular')).status, 400);
    });
  });

  test('cors_preflight_answers_without_a_token_and_every_response_allows_the_renderer_origin', async () => {
    const pre = await fetch(`${base}/v1/marketplace/listings/pa/open/review`, { method: 'OPTIONS', headers: { origin: 'vscode-file://vscode-app', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /PUT/);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
    for (const path of ['/v1/marketplace/listings', '/v1/marketplace/versions/v_dl/artifact', '/v1/marketplace/nothing-here']) {
      assert.equal((await fetch(base + path)).headers.get('access-control-allow-origin'), '*', path);
    }
    assert.equal((await fetch(`${base}/v1/marketplace/versions/v_dl/artifact`)).headers.get('access-control-expose-headers')?.includes('x-content-sha256'), true);
  });

  test('unknown_routes_are_404_json', async () => {
    const r = await call('/v1/marketplace/nothing-here');
    assert.equal(r.status, 404);
    assert.ok(r.json.error);
  });
});
