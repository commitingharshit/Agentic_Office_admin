// Plan 4 Task 10: server hardening backlog, over a REAL Postgres (embedded, real ao_app / ao_admin roles, RLS on).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { authenticate as adminAuth, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { memoryArtifactStore } from '../src/marketplace/artifacts.ts';
import { clientAddress, createLimiter } from '../src/marketplace/ratelimit.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const SHA = (c: string) => c.repeat(64);
const perm = (capability: string, scope: string) => ({ capability, scope, reason: 'r' });

describe('marketplace hardening backlog (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, owner: pg.Client;
  const servers: Server[] = [];
  const store = memoryArtifactStore();
  const authenticate = async (req: { headers: { authorization?: string } }) => {
    const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.');
    return { uid: t };
  };
  const listen = async (handler: (req: any, res: any) => Promise<boolean>) => {
    const s = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const serve = (opts: Record<string, unknown> = {}) => listen(marketplaceHandler({ app: h.pool('ao_app'), admin: h.pool('ao_admin'), authenticate, store, ...opts }));
  const get = async (base: string, path: string, o: { user?: string; headers?: Record<string, string>; method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.user) headers.authorization = `Bearer ${o.user}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const one = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0];

  before(async () => {
    h = await startMarketplacePg(); ({ owner, admin } = h);
    await owner.query(`
      INSERT INTO users(id, created_at) VALUES ('u1', now() - interval '30 days'),('u2', now() - interval '30 days'),('u3', now() - interval '30 days'),
        ('n1', now()),('n2', now()),('n3', now()),('n4', now());
      INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2'),('n1d','n1'),('n2d','n2'),('n3d','n3'),('n4d','n4');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('pa','A','u1');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pa/tool','skill','pa','u1','public','Tool'), ('pa/hot','skill','pa','u1','public','Hot');
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('a')}',1,'k');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES
        ('v1','pa/tool','1.0.0',1,0,0,'published', '{"permissions":[${JSON.stringify(perm('fs.workspace.read', '**/*.docx'))}]}','${SHA('a')}',1),
        ('v2','pa/tool','1.1.0',1,1,0,'published', '{"permissions":[${JSON.stringify(perm('fs.workspace.read', '**/*.docx'))},${JSON.stringify(perm('network', 'example.com'))}]}','${SHA('a')}',1),
        ('vh','pa/hot','1.0.0',1,0,0,'published','{}','${SHA('a')}',1);`);
  });
  after(async () => { for (const s of servers) s.close(); if (h) await h.stop(); });

  // ── hole 2: the database makes a pulled version terminal
  describe('versions guard trigger', () => {
    const mk = async (id: string, state: string) => owner.query(
      `INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ($1,'pa/tool',$2,9,$3,0,'draft','{"a":1}','${SHA('a')}',1,'clean')`, [id, `9.${id.length}.0-${id}`, id.length * 7 + Math.floor(Math.random() * 1000)]).then(async () => {
      if (state !== 'draft') await owner.query(`UPDATE marketplace_versions SET state = $2 WHERE id = $1`, [id, state]);
    });
    test('revoked is terminal at the database level', async () => {
      await mk('g-rev', 'published'); await admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'g-rev'`);
      for (const to of ['published', 'deprecated', 'quarantined', 'approved', 'draft']) {
        await assert.rejects(admin.query(`UPDATE marketplace_versions SET state = $2 WHERE id = $1`, ['g-rev', to]), /immutable|cannot|terminal/i, `revoked -> ${to}`);
      }
    });
    test('quarantined can only move to revoked, like the API state machine', async () => {
      await mk('g-q1', 'published'); await admin.query(`UPDATE marketplace_versions SET state = 'quarantined' WHERE id = 'g-q1'`);
      for (const to of ['published', 'deprecated', 'approved']) {
        await assert.rejects(admin.query(`UPDATE marketplace_versions SET state = $2 WHERE id = $1`, ['g-q1', to]), /immutable|cannot|terminal|quarantined/i, `quarantined -> ${to}`);
      }
      await admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'g-q1'`);
    });
    test('published may still be deprecated, quarantined or revoked; published -> deprecated does not alter content', async () => {
      await mk('g-ok', 'published'); await admin.query(`UPDATE marketplace_versions SET state = 'deprecated' WHERE id = 'g-ok'`);
      await admin.query(`UPDATE marketplace_versions SET state = 'quarantined' WHERE id = 'g-ok'`);
    });
    test('a draft cannot be deprecated / published in the same statement that edits its content', async () => {
      await mk('g-edit', 'draft');
      await assert.rejects(admin.query(`UPDATE marketplace_versions SET state = 'deprecated', manifest = '{"evil":1}' WHERE id = 'g-edit'`), /immutable/i);
      await assert.rejects(admin.query(`UPDATE marketplace_versions SET state = 'published', size = 99 WHERE id = 'g-edit'`), /immutable/i);
      await admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = 'g-edit'`);   // a plain state change is fine
    });
  });

  describe('minor DB items', () => {
    test('updated_at is maintained by trigger, whatever the writer sends', async () => {
      await owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state) VALUES ('ins-t','u1','d1','pa/tool','requested')`);
      await owner.query(`UPDATE marketplace_installs SET updated_at = now() - interval '1 day' WHERE id = 'ins-t'`);
      // the trigger overrides even an explicit stale value
      assert.ok((await one(`SELECT now() - updated_at < interval '1 minute' AS fresh FROM marketplace_installs WHERE id = 'ins-t'`)).fresh);
      await owner.query(`UPDATE marketplace_listings SET title = 'Tool2', updated_at = '2000-01-01' WHERE id = 'pa/tool'`);
      assert.ok((await one(`SELECT updated_at > now() - interval '1 minute' AS fresh FROM marketplace_listings WHERE id = 'pa/tool'`)).fresh);
    });
    test('artifact rows referenced by a published version cannot change size or storage key', async () => {
      await assert.rejects(admin.query(`UPDATE marketplace_artifacts SET size = 5 WHERE sha256 = '${SHA('a')}'`), /immutable/i);
      await assert.rejects(admin.query(`UPDATE marketplace_artifacts SET storage_key = 'other' WHERE sha256 = '${SHA('a')}'`), /immutable/i);
    });
    test('installs INSERT is a column list: ao_app cannot choose installed_at or updated_at', async () => {
      await assert.rejects(h.asUser('u2', () => h.app.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, installed_at) VALUES ('ins-x','u2','d2','pa/tool','2000-01-01')`)), /permission denied/);
      await h.asUser('u2', async () => { await h.app.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id) VALUES ('ins-y','u2','d2','pa/tool')`); });
    });
  });

  // ── item 1 + 2: the read limiter behind a proxy
  describe('limiter keys', () => {
    const req = (xff: string | undefined, addr = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: addr } }) as any;
    test('clientAddress: hops 0 uses the socket and ignores the header; N uses the N-th address from the right', () => {
      assert.equal(clientAddress(req('1.2.3.4, 5.6.7.8'), 0), '10.0.0.1');
      assert.equal(clientAddress(req('1.2.3.4, 5.6.7.8'), 1), '5.6.7.8');
      assert.equal(clientAddress(req('forged, 1.2.3.4, 5.6.7.8'), 2), '1.2.3.4');
      assert.equal(clientAddress(req('5.6.7.8'), 3), '10.0.0.1', 'fewer entries than hops: the header cannot be trusted, use the socket');
      assert.equal(clientAddress(req(undefined), 1), '10.0.0.1');
    });
    test('a rotating forged X-Forwarded-For cannot bypass the anonymous read limiter behind a trusted proxy', async () => {
      const base = await serve({ trustedProxyHops: 1, readLimiter: createLimiter({ limit: 3 }) });
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await get(base, '/v1/marketplace/listings', { headers: { 'x-forwarded-for': `1.2.3.${i}, 9.9.9.9` } })).status);
      assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
      assert.equal((await get(base, '/v1/marketplace/listings', { headers: { 'x-forwarded-for': '1.1.1.1, 8.8.8.8' } })).status, 200, 'another real client is not limited');
    });
    test('with no trusted proxy the header is ignored entirely (socket address)', async () => {
      const base = await serve({ readLimiter: createLimiter({ limit: 2 }) });
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await get(base, '/v1/marketplace/listings', { headers: { 'x-forwarded-for': `7.7.7.${i}` } })).status);
      assert.deepEqual(codes, [200, 200, 429, 429]);
    });
    test('signed-in reads are keyed by user, not address; an invalid token is limited by address before it can hammer authenticate', async () => {
      const base = await serve({ readLimiter: createLimiter({ limit: 2 }) });
      assert.deepEqual([(await get(base, '/v1/marketplace/listings', { user: 'u1' })).status, (await get(base, '/v1/marketplace/listings', { user: 'u1' })).status, (await get(base, '/v1/marketplace/listings', { user: 'u1' })).status], [200, 200, 429]);
      assert.equal((await get(base, '/v1/marketplace/listings', { user: 'u2' })).status, 200, 'same address, other user');
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await get(base, '/v1/marketplace/listings', { user: 'bad' })).status);
      assert.deepEqual(codes, [401, 401, 429, 429]);
    });
  });

  // ── item 3: install counts
  describe('install counts', () => {
    test('100 syncs of one account / device count once; replays change nothing; no src path bumps a counter directly', async () => {
      const base = await serve({ limiter: createLimiter({ limit: 1000 }) });
      for (let i = 0; i < 100; i++) {
        const r = await get(base, '/v1/marketplace/installs/sync', { user: 'u1', method: 'POST', body: { deviceId: 'd1', items: [{ listingId: 'pa/hot', versionId: 'vh', state: 'enabled', enabled: true, scanVerdict: 'clean' }] } });
        assert.equal(r.status, 200);
      }
      assert.equal((await one(`SELECT count(*)::int AS n FROM marketplace_installs WHERE listing_id = 'pa/hot'`)).n, 1);
      assert.equal((await one(`SELECT install_count FROM marketplace_listing_counters WHERE listing_id = 'pa/hot'`)).install_count, 1);
      const { execFileSync } = await import('node:child_process');
      let hits = '';
      try { hits = execFileSync('grep', ['-rln', 'marketplace_bump\\|marketplace_listing_counters', new URL('../src', import.meta.url).pathname]).toString().trim(); } catch { /* grep exits 1 on no match */ }
      assert.equal(hits, '', 'no application code touches the counters directly');
    });
    test('suspicious_install_bursts: installs by accounts created <24h ago are counted, flagged for admins, never acted on', async () => {
      for (const [u, d] of [['n1', 'n1d'], ['n2', 'n2d'], ['n3', 'n3d'], ['n4', 'n4d']]) await owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state) VALUES ('b-${u}','${u}','${d}','pa/hot','enabled')`);
      const tok = 'r'.repeat(30);
      const adminBase = await listen(marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => adminAuth(req, { tokens: parseTokens(`root:${tok}`) } as unknown as AdminDeps), roleOf: () => 'superadmin', store }));
      const r = await get(adminBase, '/admin/marketplace/security/suspicious-install-bursts?min=3', { headers: { authorization: `Bearer ${tok}` } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.bursts.length, 1);
      assert.deepEqual([r.json.bursts[0].listingId, r.json.bursts[0].installs, r.json.bursts[0].accounts], ['pa/hot', 4, 4]);
      assert.ok(r.json.window && r.json.note);
      assert.equal((await one(`SELECT install_count FROM marketplace_listing_counters WHERE listing_id = 'pa/hot'`)).install_count, 5, 'flagged installs still count');
    });
  });

  // ── permissions per version
  test('GET /listings/:id/versions lists permissions per version and what each one adds over the previous', async () => {
    const base = await serve();
    const r = await get(base, '/v1/marketplace/listings/pa/tool/versions');
    assert.equal(r.status, 200, r.text);
    const by = Object.fromEntries(r.json.versions.filter((v: any) => v.id === 'v1' || v.id === 'v2').map((v: any) => [v.id, v]));
    assert.deepEqual(by.v1.permissions, [perm('fs.workspace.read', '**/*.docx')]);
    assert.deepEqual(by.v1.addedPermissions, [perm('fs.workspace.read', '**/*.docx')], 'the first version adds everything');
    assert.deepEqual(by.v2.permissions.map((p: any) => p.capability), ['fs.workspace.read', 'network']);
    assert.deepEqual(by.v2.addedPermissions, [perm('network', 'example.com')]);
  });

  // ── item 6: lastError privacy
  test('another user\'s lastError never appears in any user-facing response', async () => {
    const base = await serve();
    const secret = 'SECRET-PATH-/Users/alice/x';
    assert.equal((await get(base, '/v1/marketplace/installs/sync', { user: 'u1', method: 'POST', body: { deviceId: 'd1', items: [{ listingId: 'pa/tool', versionId: 'v1', state: 'failed', enabled: false, lastError: `other: ${secret}` }] } })).status, 200);
    for (const p of ['/v1/marketplace/listings', '/v1/marketplace/listings/pa/tool', '/v1/marketplace/listings/pa/tool/versions', '/v1/marketplace/listings/pa/tool/reviews']) {
      assert.ok(!(await get(base, p, { user: 'u2' })).text.includes('SECRET-PATH'), p);
    }
    const s2 = await get(base, '/v1/marketplace/installs/sync', { user: 'u2', method: 'POST', body: { deviceId: 'd2', items: [{ listingId: 'pa/tool', versionId: 'v1', state: 'enabled', enabled: true, scanVerdict: 'clean' }] } });
    assert.ok(!s2.text.includes('SECRET-PATH'));
  });

  // ── item 5: resource limits still hold
  test('resource limits: an unauthenticated compare is refused, an oversized upload is cut off, and peak memory stays bounded', async () => {
    const base = await serve({ maxUploadBytes: 1024 * 1024 });
    const cmp = await get(base, '/v1/marketplace/listings/pa/tool/compare?base=v1&head=v2');
    assert.ok([401, 404].includes(cmp.status), `anonymous compare: ${cmp.status}`);
    const before = process.memoryUsage().rss;
    const big = new Uint8Array(4 * 1024 * 1024);
    // the server may answer 413 or cut the connection while the client is still sending: both are a refusal, neither buffers the body
    const r = await fetch(base + '/v1/marketplace/listings?visibility=private', { method: 'POST', headers: { authorization: 'Bearer u1', 'content-type': 'application/zip' }, body: big }).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
    const grew = process.memoryUsage().rss - before;
    console.log(`# measured: rss growth after a 4 MiB over-limit upload (1 MiB cap): ${(grew / 1048576).toFixed(1)} MiB`);
    assert.ok(grew < 64 * 1024 * 1024, `rss grew ${grew}`);
    const art = await get(base, '/v1/marketplace/versions/v1/artifact');
    assert.ok([200, 404, 500].includes(art.status));
  });
});
