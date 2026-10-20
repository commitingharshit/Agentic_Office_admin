// The public marketplace API over HTTP against a REAL Postgres (embedded-postgres, real ao_app / ao_admin
// roles, RLS on). Fixtures are created through the ao_admin connection in before(): they exist only here.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { HttpError } from '../src/api/sync.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { memoryArtifactStore, putArtifact } from '../src/marketplace/artifacts.ts';
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
    assert.deepEqual(Object.keys(item).sort(), ['id', 'latestVersion', 'publisher', 'stats', 'summary', 'title', 'trust', 'type', 'viewer', 'visibility']);
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
      { listing_id: 'pa/unrated', version_id: null, state: 'failed', enabled: false, last_error: 'disk full' }]);
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
    const ok = { r: '0.5', u: '2026-01-01T00:00:00.123456+00:00', id: 'pa/open' };
    const forged = [
      { ...ok, r: '0x10' }, { ...ok, r: '' }, { ...ok, r: '1e' }, { ...ok, r: 'NaN' }, { ...ok, r: ' 1' },
      { ...ok, u: '' }, { ...ok, u: 'Jan 1 2020' }, { ...ok, u: '2026-13-45T00:00:00Z' }, { ...ok, u: 'now' },
      { ...ok, id: 'a\u0000b/c' }, { ...ok, id: '' }, { ...ok, id: 'NOT/ok!' }, { ...ok, id: 5 }, { ...ok, r: 1 },
    ];
    for (const c of forged) assert.equal((await call(`/v1/marketplace/listings?page=${b64(c)}`)).status, 400, JSON.stringify(c));
    for (const raw of ['null', '[]', '"x"', '{']) assert.equal((await call(`/v1/marketplace/listings?page=${Buffer.from(raw).toString('base64url')}`)).status, 400, raw);
    assert.equal((await call(`/v1/marketplace/listings?page=${b64(ok)}`)).status, 200);
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

  test('unknown_routes_are_404_json', async () => {
    const r = await call('/v1/marketplace/nothing-here');
    assert.equal(r.status, 404);
    assert.ok(r.json.error);
  });
});
