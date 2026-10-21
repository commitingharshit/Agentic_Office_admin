// The final-review fix wave over HTTP against a REAL Postgres (embedded, real ao_app / ao_admin roles, RLS on):
// revocation delivery, review-before-public, the scanner-unavailable 503 path, resource gates, error clamping,
// the creator -> admin handoff, owner withdraw/delete and the blob-delete race.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import type pg from 'pg';
import { authenticate as adminAuth, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { memoryArtifactStore, putArtifact, sha256Hex } from '../src/marketplace/artifacts.ts';
import { createGate } from '../src/marketplace/limits.ts';
import { skillScannerSelfCheck } from '../src/marketplace/selfcheck.ts';
import { clampLastError } from '../src/marketplace/store.ts';
import type { PermissionRequest } from '../src/marketplace/types.ts';
import { registerValidator, validateArtifact } from '../src/marketplace/validate/index.ts';
import { createSkillValidator, type SkillScanner } from '../src/marketplace/validate/skill.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const here = dirname(fileURLToPath(import.meta.url));
const seed = join(here, '..', 'scripts', 'dev-seed', 'docx-outline');
const enc = (s: string) => new TextEncoder().encode(s);
const SEED: Record<string, string> = {};
for (const rel of ['SKILL.md', 'references/styles.md', 'scripts/outline.py']) SEED[rel] = readFileSync(join(seed, rel), 'utf8');
const PERMS: PermissionRequest[] = [
  { capability: 'fs.workspace.read', scope: '**/*.docx', reason: 'Reads the Word files you ask it to outline.' },
  { capability: 'exec.script', scope: 'scripts/outline.py', reason: 'Runs the bundled script.' },
];
const scanner: SkillScanner = async (files) => {
  const findings = [...files].filter(([, b]) => /rm -rf \/|curl [^\n|]*\| *sh/.test(new TextDecoder().decode(b))).map(([file]) => ({ category: 'destructive', severity: 'critical', file }));
  return { verdict: findings.length ? 'dangerous' : 'safe', findings };
};
const withScanner = () => registerValidator('skill', createSkillValidator({ scanner }));
const withoutScanner = () => registerValidator('skill', createSkillValidator());
function pack(id: string, version = '1.0.0'): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(SEED)) files[k] = enc(v);
  const list = Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length }));
  const manifest = { schema: 'agentic.marketplace/1', id, type: 'skill', version, title: 'DOCX Outline', summary: 'Prints the heading outline.', license: 'MIT',
    compat: { app: '*' }, dependencies: [], permissions: PERMS, files: list, payload: { name: 'docx-outline', entry: 'SKILL.md' } };
  return zipSync({ 'agentic.marketplace.json': enc(JSON.stringify(manifest)), ...files });
}
const tok = (c: string) => c.repeat(30);
const TOKENS: Record<string, [string, 'superadmin' | 'engineer']> = { root: [tok('r'), 'superadmin'], eng: [tok('e'), 'engineer'] };
const ROLE_OF = Object.fromEntries(Object.entries(TOKENS).map(([k, [, r]]) => [k, r]));
const tokens = parseTokens(Object.entries(TOKENS).map(([k, [t]]) => `${k}:${t}`).join(','));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('marketplace fix wave (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client;
  const store = memoryArtifactStore();
  const servers: Server[] = [];
  let base = '', adminBase = '';

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
  const serveAdmin = (opts: Record<string, unknown> = {}) => listen(marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => adminAuth(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE_OF[id], store, ...opts }));

  const call = async (path: string, o: { user?: string; as?: string; method?: string; body?: unknown; zip?: Uint8Array; origin?: string; admin?: boolean } = {}) => {
    const headers: Record<string, string> = {};
    if (o.user) headers.authorization = `Bearer ${o.user}`;
    if (o.as) headers.authorization = `Bearer ${TOKENS[o.as][0]}`;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch((o.origin ?? (o.admin ? adminBase : base)) + path, { method: o.method ?? (body ? 'POST' : 'GET'), headers, body });
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, headers: r.headers };
  };
  const create = (user: string, id: string, version = '1.0.0', q = 'visibility=private') => call(`/v1/marketplace/listings?${q}`, { user, zip: pack(id, version) });
  const submit = (id: string, version: string, as: string, q = '') => call(`/admin/marketplace/submissions${q}`, { as, zip: pack(id, version), admin: true });
  const act = (vid: string, action: string, body: unknown = {}, as = 'root') => call(`/admin/marketplace/versions/${vid}/${action}`, { as, method: 'POST', body, admin: true });
  const one = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0];

  before(async () => {
    withScanner();
    h = await startMarketplacePg();
    admin = h.admin;
    await h.owner.query(`INSERT INTO users(id) VALUES ('u1'),('u2'),('u3'),('u4'),('u5'); INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2'),('d3','u3')`);
    base = await serve();
    adminBase = await serveAdmin();
  });
  after(async () => { for (const s of servers) s.close(); if (h) await h.stop(); });

  // ── M2 + M1c: review before public; revocation reaches a device with no install row and anonymous clients
  test('M2: an admin submit never changes visibility; the public flip needs every published version reviewed; ao_app cannot change visibility', async () => {
    withScanner();
    const c = await create('u1', 'u-u1/outline');
    assert.equal(c.status, 201, JSON.stringify(c.json)); assert.equal(c.json.state, 'published');
    const autoVid = c.json.versionId as string;
    const s = await submit('u-u1/outline', '1.1.0', 'root', '?visibility=public');
    assert.equal(s.status, 201, JSON.stringify(s.json));
    assert.equal((await one(`SELECT visibility FROM marketplace_listings WHERE id = 'u-u1/outline'`)).visibility, 'private');   // RED before the fix: flipped to public
    const v2 = s.json.versionId as string;
    assert.equal((await act(v2, 'approve', {}, 'eng')).status, 200);
    const blocked = await act(v2, 'publish', { visibility: 'public' }, 'eng');
    assert.equal(blocked.status, 409, JSON.stringify(blocked.json));
    assert.equal(blocked.json.code, 'unreviewed_versions');
    assert.deepEqual(blocked.json.versionIds, [autoVid]);
    assert.equal((await one(`SELECT visibility FROM marketplace_listings WHERE id = 'u-u1/outline'`)).visibility, 'private');
    assert.equal((await one('SELECT state FROM marketplace_versions WHERE id = $1', [v2])).state, 'approved');   // the failed publish rolled back
    assert.equal((await act(autoVid, 'quarantine', { reason: 'unreviewed upload pulled' }, 'root')).status, 200);
    const ok = await act(v2, 'publish', { visibility: 'public' }, 'eng');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const l = await one(`SELECT visibility, trust FROM marketplace_listings WHERE id = 'u-u1/outline'`);
    assert.equal(l.visibility, 'public'); assert.equal(l.trust, 'community');
    // DB backstop: the application role has no UPDATE on visibility, and cannot create a public listing either
    await assert.rejects(h.asUser('u1', () => h.app.query(`UPDATE marketplace_listings SET visibility = 'public' WHERE id = 'u-u1/outline'`)), /permission denied/);
    await assert.rejects(h.asUser('u1', () => h.app.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('u-u1/x','skill','u-u1','u1','public','t')`)), /only the server|row-level security/);
  });

  test('M2: the creator visibility route still works for private/team and refuses public', async () => {
    withScanner();
    assert.equal((await create('u2', 'u-u2/vis')).status, 201);
    const t = await call('/v1/marketplace/teams', { user: 'u2', body: { name: 'Vis' } });
    assert.equal((await call('/v1/marketplace/listings/u-u2/vis/visibility', { user: 'u2', method: 'PUT', body: { visibility: 'team', team: t.json.id } })).status, 200);
    assert.equal((await one(`SELECT visibility FROM marketplace_listings WHERE id = 'u-u2/vis'`)).visibility, 'team');
    assert.equal((await call('/v1/marketplace/listings/u-u2/vis/visibility', { user: 'u2', method: 'PUT', body: { visibility: 'private' } })).status, 200);
    assert.equal((await call('/v1/marketplace/listings/u-u2/vis/visibility', { user: 'u2', method: 'PUT', body: { visibility: 'public' } })).status, 403);
  });

  test('M1c: a device with no install row still learns a version was pulled; signed-out clients can ask too', async () => {
    const pulled = (await one(`SELECT id FROM marketplace_versions WHERE listing_id = 'u-u1/outline' AND state = 'quarantined'`)).id as string;
    const good = (await one(`SELECT id FROM marketplace_versions WHERE listing_id = 'u-u1/outline' AND state = 'published'`)).id as string;
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_installs WHERE user_id = $1', ['u3'])).n, 0);
    const r = await call('/v1/marketplace/installs/sync', { user: 'u3', body: { deviceId: 'd3', items: [{ listingId: 'u-u1/outline', versionId: pulled, state: 'installed', enabled: true }] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.results[0].ok, false); assert.equal(r.json.results[0].code, 'not_found');
    assert.deepEqual(r.json.updates.map((u: any) => ({ l: u.listingId, v: u.versionId, s: u.state, r: u.revoked, reason: u.reason })),
      [{ l: 'u-u1/outline', v: pulled, s: 'quarantined', r: true, reason: 'unreviewed upload pulled' }]);
    // anonymous
    const a = await call('/v1/marketplace/versions/status', { body: { versionIds: [pulled, good, 'nope_unknown'] } });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.deepEqual([...a.json.statuses].sort((x: any, y: any) => x.versionId.localeCompare(y.versionId)),
      [{ versionId: pulled, state: 'quarantined', reason: 'unreviewed upload pulled' }, { versionId: good, state: 'published' }].sort((x, y) => x.versionId.localeCompare(y.versionId)));
    assert.equal((await call('/v1/marketplace/versions/status', { body: { versionIds: Array.from({ length: 201 }, (_, i) => `v${i}`) } })).status, 400);
    assert.equal((await call('/v1/marketplace/versions/status', { body: { versionIds: 'x' } })).status, 400);
    // the function is not callable by PUBLIC and caps its input
    await assert.rejects(h.owner.query(`SET ROLE ao_readonly; SELECT * FROM marketplace_version_status(ARRAY['x'])`), /permission denied/).finally(() => h.owner.query('RESET ROLE'));
  });

  // ── M3/M4
  test('M4: the scanner self-check passes with a scanner, fails without one or with a broken validator', async () => {
    withScanner();
    assert.equal((await skillScannerSelfCheck()).ok, true);
    withoutScanner();
    const none = await skillScannerSelfCheck();
    assert.equal(none.ok, false); assert.match(none.detail ?? '', /security-scan/);
    const broken = await skillScannerSelfCheck(async () => { throw new Error('python3: not found'); });
    assert.equal(broken.ok, false); assert.match(broken.detail ?? '', /python3/);
    withScanner();
  });

  test('M4: with the scanner unavailable, creator uploads and admin skill submissions answer 503 scanner_unavailable while browsing works', async () => {
    const down = await serve({ scannerOk: () => false });
    const downAdmin = await serveAdmin({ scannerOk: () => false });
    const before_ = (await one('SELECT count(*)::int AS n FROM marketplace_versions')).n;
    const r = await call('/v1/marketplace/listings?visibility=private', { user: 'u4', zip: pack('u-u4/down'), origin: down });
    assert.equal(r.status, 503); assert.equal(r.json.code, 'scanner_unavailable');
    assert.equal((await call('/v1/marketplace/listings/u-u1/outline/versions', { user: 'u1', zip: pack('u-u1/outline', '9.0.0'), origin: down })).status, 503);
    const a = await call('/admin/marketplace/submissions', { as: 'root', zip: pack('acme/down'), origin: downAdmin });
    assert.equal(a.status, 503); assert.equal(a.json.code, 'scanner_unavailable');
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_versions')).n, before_);   // nothing stored as rejected
    assert.equal((await call('/v1/marketplace/listings', { origin: down })).status, 200);
  });

  // ── M5
  test('M5: compare needs a signed-in user', async () => {
    assert.equal((await call('/v1/marketplace/listings/u-u1/outline/compare?base=a&head=b')).status, 401);
  });

  test('M5: the heavy gate answers 429 + Retry-After past its cap (artifact downloads)', async () => {
    const slow = { ...store, get: async (sha: string) => { await sleep(300); return store.get(sha); } };
    const gated = await serve({ store: slow, heavyGate: createGate(1, 0) });
    const good = (await one(`SELECT id FROM marketplace_versions WHERE listing_id = 'u-u1/outline' AND state = 'published'`)).id as string;
    const rs = await Promise.all([0, 1, 2, 3].map(() => call(`/v1/marketplace/versions/${good}/artifact`, { origin: gated })));
    const codes = rs.map((x) => x.status).sort();
    assert.ok(codes.includes(200), codes.join());
    assert.ok(codes.includes(429), codes.join());
    assert.ok(rs.find((x) => x.status === 429)!.headers.get('retry-after'));
  });

  test('M5: the in-flight upload budget refuses a second big upload before buffering it', async () => {
    const tight = await serve({ uploadBudgetBytes: 3000, uploadWaitMs: 150 });
    const u = new URL(tight);
    const hold = httpRequest({ host: u.hostname, port: u.port, path: '/v1/marketplace/listings?visibility=private', method: 'POST', headers: { authorization: 'Bearer u5', 'content-type': 'application/zip', 'content-length': '2500' } });
    hold.on('error', () => {});
    hold.write(Buffer.alloc(100));   // the first upload is mid-flight
    await sleep(100);
    const second = await call('/v1/marketplace/listings?visibility=private', { user: 'u4', zip: new Uint8Array(2500).fill(1), origin: tight });
    assert.equal(second.status, 429, JSON.stringify(second.json)); assert.equal(second.json.code, 'busy');
    hold.destroy();
    await sleep(100);
    const third = await call('/v1/marketplace/listings?visibility=private', { user: 'u4', zip: new Uint8Array(2500).fill(1), origin: tight });
    assert.notEqual(third.status, 429);   // the budget was released (the garbage zip is a 400)
  });

  // ── I1
  test('I1: lastError is stored as a code plus a sanitized short detail', async () => {
    assert.equal(clampLastError('hash_mismatch'), 'hash_mismatch');
    assert.equal(clampLastError(''), null);
    assert.equal(clampLastError('download_failed: could not write /Users/harshit/Library/x/y.zip'), 'download_failed: could not write [path]');
    assert.equal(clampLastError('C:\\Users\\bob\\AppData\\x.zip failed'), 'other: [path] failed');
    assert.match(clampLastError('boom Bearer aod_abcdefghijklmnopqrstuv end') ?? '', /^other: boom \[redacted\] end$/);
    assert.ok((clampLastError('x'.repeat(500)) ?? '').length <= 'other: '.length + 120);
    const pubVid = (await one(`SELECT id FROM marketplace_versions WHERE listing_id = 'u-u1/outline' AND state = 'published'`)).id as string;
    const r = await call('/v1/marketplace/installs/sync', { user: 'u1', body: { deviceId: 'd1', items: [{ listingId: 'u-u1/outline', versionId: pubVid, state: 'failed', lastError: 'disk_error: no space at /home/harshit/.hermes/skills' }] } });
    assert.equal(r.json.results[0].ok, true, JSON.stringify(r.json));
    const row = await one(`SELECT last_error FROM marketplace_installs WHERE user_id = 'u1' AND listing_id = 'u-u1/outline'`);
    assert.equal(row.last_error, 'disk_error: no space at [path]');
  });

  // ── I2
  test('I2: a creator version left submitted (no scanner at upload) is approved and published after an admin rescan', async () => {
    withoutScanner();
    const c = await create('u4', 'u-u4/handoff');
    assert.equal(c.status, 201); assert.equal(c.json.state, 'submitted');
    const vid = c.json.versionId as string;
    const scan = await one(`SELECT scanner, verdict, findings FROM marketplace_security_scans WHERE version_id = $1`, [vid]);
    assert.equal(scan.scanner, 'validation'); assert.equal(scan.findings.ok, true); assert.equal(scan.findings.verified, false);
    assert.equal((await act(vid, 'approve')).json.code, 'scan_required');
    withScanner();
    const rs = await act(vid, 'rescan', {}, 'root');
    assert.equal(rs.status, 200, JSON.stringify(rs.json));
    assert.equal(rs.json.validation.verified, true);
    assert.equal((await act(vid, 'rescan', {}, 'eng')).status, 200);   // engineers have marketplace.write
    assert.equal((await act(vid, 'approve')).status, 200);
    assert.equal((await act(vid, 'publish')).status, 200);
    assert.equal((await one('SELECT state, scan_verdict FROM marketplace_versions WHERE id = $1', [vid])).state, 'published');
    assert.equal((await act(vid, 'rescan')).status, 409);   // not rescannable once published
  });

  // ── I4
  test('I4: an owner withdraws a version, and deletes a listing only when no other user installed it', async () => {
    withScanner();
    const c = await create('u5', 'u-u5/mine');
    const vid = c.json.versionId as string;
    const sha = (await one('SELECT sha256 FROM marketplace_versions WHERE id = $1', [vid])).sha256 as string;
    const w = await call(`/v1/marketplace/listings/u-u5/mine/versions/${vid}`, { user: 'u5', method: 'DELETE' });
    assert.equal(w.status, 200, JSON.stringify(w.json)); assert.equal(w.json.state, 'revoked');
    assert.equal((await one('SELECT state FROM marketplace_versions WHERE id = $1', [vid])).state, 'revoked');
    assert.equal((await one(`SELECT detail->>'reason' AS r FROM marketplace_release_events WHERE version_id = $1 AND event = 'revoked'`, [vid])).r, 'withdrawn by owner');
    assert.equal((await call(`/v1/marketplace/listings/u-u5/mine/versions/${vid}`, { user: 'u5', method: 'DELETE' })).json.code, 'already_withdrawn');
    assert.equal((await call(`/v1/marketplace/listings/u-u5/mine/versions/${vid}`, { user: 'u2', method: 'DELETE' })).status, 404);
    // delete with a foreign install -> 409; the owner's own install does not block
    const c2 = await create('u5', 'u-u5/shared', '1.0.0', 'visibility=team&team=');
    assert.equal(c2.status, 400);   // team is required
    const t = await call('/v1/marketplace/teams', { user: 'u5', body: { name: 'Del' } });
    const c3 = await create('u5', 'u-u5/shared', '1.0.0', `visibility=team&team=${t.json.id}`);
    assert.equal(c3.status, 201, JSON.stringify(c3.json));
    assert.equal((await call(`/v1/marketplace/teams/${t.json.id}/members`, { user: 'u5', body: { userId: 'u2' } })).status, 201);
    const inst = await call('/v1/marketplace/installs/sync', { user: 'u2', body: { deviceId: 'd2', items: [{ listingId: 'u-u5/shared', versionId: c3.json.versionId, state: 'installed', enabled: true }] } });
    assert.equal(inst.json.results[0].ok, true, JSON.stringify(inst.json));
    const d1 = await call('/v1/marketplace/listings/u-u5/shared', { user: 'u5', method: 'DELETE' });
    assert.equal(d1.status, 409); assert.equal(d1.json.code, 'has_installs');
    assert.equal((await call('/v1/marketplace/listings/u-u5/mine', { user: 'u2', method: 'DELETE' })).status, 404);
    const d2 = await call('/v1/marketplace/listings/u-u5/mine', { user: 'u5', method: 'DELETE' });
    assert.equal(d2.status, 200, JSON.stringify(d2.json));
    assert.equal((await one(`SELECT count(*)::int AS n FROM marketplace_listings WHERE id = 'u-u5/mine'`)).n, 0);
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_versions WHERE id = $1', [vid])).n, 0);
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_artifacts WHERE sha256 = $1', [sha])).n, 0);
    assert.equal(store.blobs.has(sha), false);
    // the quota is recovered
    assert.equal((await call('/v1/marketplace/listings/u-u5/public-one', { user: 'u5', method: 'DELETE' })).status, 404);
  });

  // ── I6
  test('I6: a failed upload never deletes a blob it did not write', async () => {
    withScanner();
    assert.equal((await create('u3', 'u-u3/race', '2.0.0')).status, 201);
    const older = pack('u-u3/race', '1.0.0');
    const sha = sha256Hex(older);
    await putArtifact(store, older);   // "another request" already stored identical bytes; no artifact row yet
    const r = await call('/v1/marketplace/listings/u-u3/race/versions', { user: 'u3', zip: older });
    assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.code, 'version_not_greater');
    assert.equal(store.blobs.has(sha), true);   // RED before the fix: the failure path deleted it
    // bytes this request did write are still cleaned up
    const fresh = pack('u-u3/race', '3.0.0');
    assert.equal((await call('/v1/marketplace/listings/u-u3/race/versions', { user: 'u3', zip: fresh })).status, 201);
  });
});
