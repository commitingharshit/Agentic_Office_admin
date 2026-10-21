// The marketplace admin API over HTTP against a REAL Postgres (embedded-postgres, real ao_app / ao_admin roles,
// RLS on). Admin auth is admin.ts's real bearer-token path; roles are injected through `roleOf`. The public API
// handler runs against the same database as ao_app, to prove a publish is visible end to end.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type pg from 'pg';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler, transition, ACTIONS, type Action } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import { ADMIN_ROLES, MARKETPLACE_PERMISSIONS, can, parseRoleMap, permissionsOf, type AdminRole } from '../src/marketplace/permissions.ts';
import type { VersionState } from '../src/marketplace/types.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/marketplace/${n}`, import.meta.url)));
const PPTX = fx('board-update.pptx');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const tok = (c: string) => c.repeat(30);
const TOKENS: Record<string, [string, AdminRole]> = {
  root: [tok('r'), 'superadmin'], eng: [tok('e'), 'engineer'], ana: [tok('a'), 'analyst'], sup: [tok('s'), 'support'], fin: [tok('f'), 'finance'],
};
const ROLE_OF = Object.fromEntries(Object.entries(TOKENS).map(([k, [, r]]) => [k, r]));
const tokens = parseTokens(Object.entries(TOKENS).map(([k, [t]]) => `${k}:${t}`).join(','));

// ── package builders
function templateZip(o: { id?: string; version?: string; title?: string; pptx?: Uint8Array; deps?: { id: string; range: string }[] } = {}): Uint8Array {
  const pptx = o.pptx ?? PPTX;
  const files: Record<string, Uint8Array> = { 'template.pptx': pptx, 'previews/1.png': PNG };
  const manifest = {
    schema: 'agentic.marketplace/1', id: o.id ?? 'acme/board', type: 'template', version: o.version ?? '1.0.0', title: o.title ?? 'Board deck', summary: 'A board deck.', license: 'MIT',
    compat: { app: '^1.0.0' }, dependencies: o.deps ?? [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format: 'pptx', file: 'template.pptx', previews: ['previews/1.png'] },
  };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
function skillZip(id = 'acme/pdf-notes', version = '1.0.0'): Uint8Array {
  const name = id.split('/')[1];
  const files: Record<string, Uint8Array> = {
    'SKILL.md': strToU8(`---\nname: ${name}\ndescription: Summarize PDFs into notes.\n---\n\n# Hello\n\nSee [guide](references/guide.md).\n`),
    'references/guide.md': strToU8('# Guide\n'),
  };
  const manifest = {
    schema: 'agentic.marketplace/1', id, type: 'skill', version, title: 'PDF notes', summary: 'Notes.', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { entry: 'SKILL.md', name },
  };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
const macroPptx = (): Uint8Array => { const z = unzipSync(PPTX); z['ppt/vbaProject.bin'] = new Uint8Array([1, 2, 3]); return zipSync(z as Zippable); };

describe('permissions', () => {
  test('role table: superadmin all, engineer read+write+review, analyst read, support/finance none, moderate only superadmin', () => {
    assert.deepEqual([...permissionsOf('superadmin')], [...MARKETPLACE_PERMISSIONS]);
    assert.deepEqual([...permissionsOf('engineer')], ['marketplace.read', 'marketplace.write', 'marketplace.review']);
    assert.deepEqual([...permissionsOf('analyst')], ['marketplace.read']);
    assert.deepEqual([...permissionsOf('support')], []);
    assert.deepEqual([...permissionsOf('finance')], []);
    for (const r of ADMIN_ROLES) assert.equal(can(r, 'marketplace.moderate'), r === 'superadmin', r);
  });
});

describe('AO_MARKETPLACE_ROLES parsing', () => {
  test('valid entries, empty, unknown role and malformed entries', () => {
    assert.deepEqual([...parseRoleMap('alice:superadmin, bob@x.test:engineer')], [['alice', 'superadmin'], ['bob@x.test', 'engineer']]);
    assert.equal(parseRoleMap('').size, 0); assert.equal(parseRoleMap(undefined).size, 0);
    assert.throws(() => parseRoleMap('alice:root'), /unknown role/);
    assert.throws(() => parseRoleMap('alice'), /adminName:role/);
    assert.throws(() => parseRoleMap(':superadmin'), /adminName:role/);
  });
});

describe('transition()', () => {
  const STATES: VersionState[] = ['draft', 'validating', 'testing', 'submitted', 'in_review', 'approved', 'published', 'rejected', 'deprecated', 'quarantined', 'revoked'];
  const ALLOWED: Record<Action, Partial<Record<VersionState, VersionState>>> = {
    claim: { submitted: 'in_review' },
    approve: { submitted: 'approved', in_review: 'approved' },
    reject: { submitted: 'rejected', in_review: 'rejected', approved: 'rejected' },
    publish: { approved: 'published' },
    deprecate: { published: 'deprecated' },
    quarantine: { published: 'quarantined', approved: 'quarantined', deprecated: 'quarantined' },
    revoke: { submitted: 'revoked', in_review: 'revoked', approved: 'revoked', published: 'revoked', rejected: 'revoked', deprecated: 'revoked', quarantined: 'revoked' },
  };
  test('every (state, action) pair matches the table; everything else is a 409 invalid_transition', () => {
    for (const a of ACTIONS) for (const s of STATES) {
      const want = ALLOWED[a][s];
      if (want) assert.equal(transition(s, a), want, `${s} -> ${a}`);
      else assert.throws(() => transition(s, a), (e: any) => e.status === 409 && e.code === 'invalid_transition', `${s} -> ${a}`);
    }
  });
});

describe('marketplace admin API (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, api: Server, small: Server, pub: Server, base = '', smallBase = '', pubBase = '';
  const store = memoryArtifactStore();

  const call = async (path: string, o: { as?: string; method?: string; body?: unknown; zip?: Uint8Array | ReadableStream; ct?: string; origin?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as && TOKENS[o.as]) headers.authorization = `Bearer ${TOKENS[o.as][0]}`; else if (o.as) headers.authorization = `Bearer ${o.as}`;
    let body: any;
    if (o.zip) { headers['content-type'] = o.ct ?? 'application/zip'; body = o.zip; }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch((o.origin ?? base) + path, { method: o.method ?? (o.zip ? 'POST' : 'GET'), headers, body, ...(o.zip instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const submit = (zip: Uint8Array, q = '', as = 'root') => call(`/admin/marketplace/submissions${q}`, { as, zip });
  const act = (id: string, action: string, body: unknown = {}, as = 'root') => call(`/admin/marketplace/versions/${id}/${action}`, { as, method: 'POST', body });
  const one = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0];
  const counts = async () => (await one(`SELECT
      (SELECT count(*) FROM marketplace_versions)::int AS versions, (SELECT count(*) FROM marketplace_listings)::int AS listings, (SELECT count(*) FROM marketplace_artifacts)::int AS artifacts,
      (SELECT count(*) FROM marketplace_security_scans)::int AS scans, (SELECT count(*) FROM marketplace_release_events)::int AS events, (SELECT count(*) FROM admin_audit)::int AS audit,
      (SELECT count(*) FROM marketplace_publishers)::int AS publishers, (SELECT count(*) FROM marketplace_reviews)::int AS reviews, (SELECT count(*) FROM marketplace_reports)::int AS reports,
      (SELECT string_agg(id || ':' || state, ',' ORDER BY id) FROM marketplace_versions) AS states`));
  const vstate = async (id: string) => (await one('SELECT state FROM marketplace_versions WHERE id = $1', [id])).state;
  const events = async (id: string) => (await admin.query('SELECT event, actor, detail FROM marketplace_release_events WHERE version_id = $1 ORDER BY id', [id])).rows;
  const auditFor = async (versionId: string) => (await admin.query(`SELECT action, admin_user_id, detail FROM admin_audit WHERE detail->>'versionId' = $1 ORDER BY id`, [versionId])).rows;

  before(async () => {
    h = await startMarketplacePg();
    admin = h.admin;
    const adminPool = h.pool('ao_admin');
    const deps = { tokens } as unknown as AdminDeps;
    const mk = (extra: Record<string, unknown> = {}) => {
      const handler = marketplaceAdminHandler({ admin: adminPool, authenticate: (req) => authenticate(req, deps), roleOf: (id) => ROLE_OF[id], store, ...extra });
      return createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    };
    api = mk(); small = mk({ maxSubmissionBytes: 1024 });
    const publicHandler = marketplaceHandler({
      app: h.pool('ao_app'), store,
      authenticate: async (req) => { const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]; if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.'); return { uid: t }; },
    });
    pub = createServer(async (req, res) => { if (!(await publicHandler(req, res))) res.writeHead(404).end(); });
    await Promise.all([api, small, pub].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    base = url(api); smallBase = url(small); pubBase = url(pub);
    await h.owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'),('u2','u2@example.test'); INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2');`);
  });
  after(async () => { api?.close(); small?.close(); pub?.close(); if (h) await h.stop(); });

  // ── authentication and permissions
  test('no token is 401 and an unknown token is 403, for reads and writes, with no rows changed', async () => {
    const before_ = await counts();
    assert.equal((await call('/admin/marketplace/catalog')).status, 401);
    assert.equal((await call('/admin/marketplace/catalog', { as: 'not-an-admin-token-at-all-0123456789' })).status, 403);
    assert.equal((await submit(templateZip(), '', 'not-an-admin-token-at-all-0123456789')).status, 403);
    assert.deepEqual(await counts(), before_);
  });

  test('an analyst can read but publish/approve/submit are 403 and nothing changes', async () => {
    const r = await submit(templateZip({ id: 'acme/perm' }));
    assert.equal(r.status, 201);
    const vid = r.json.versionId;
    const before_ = await counts();
    assert.equal((await call('/admin/marketplace/catalog', { as: 'ana' })).status, 200);
    assert.equal((await submit(templateZip({ id: 'acme/perm2' }), '', 'ana')).status, 403);
    for (const a of ['claim', 'approve', 'publish', 'reject', 'deprecate', 'quarantine', 'revoke']) {
      const x = await act(vid, a, { reason: 'because' }, 'ana');
      assert.equal(x.status, 403, a);
      assert.equal(x.json.code, 'forbidden');
    }
    assert.equal((await call('/admin/marketplace/reviews/nope', { as: 'ana', method: 'DELETE' })).status, 403);
    assert.equal((await call('/admin/marketplace/publishers', { as: 'ana', method: 'POST', body: { id: 'x', trust: 'verified' } })).status, 403);
    // reads write an audit row (views are audited); everything else is unchanged
    const after_ = await counts();
    assert.deepEqual({ ...after_, audit: 0 }, { ...before_, audit: 0 });
    assert.equal(after_.audit, before_.audit + 1);
    assert.equal(await vstate(vid), 'submitted');
  });

  test('support and finance have no marketplace access at all; engineer cannot moderate', async () => {
    for (const as of ['sup', 'fin']) {
      assert.equal((await call('/admin/marketplace/catalog', { as })).status, 403, as);
      assert.equal((await call('/admin/marketplace/analytics', { as })).status, 403, as);
    }
    const vid = (await submit(templateZip({ id: 'acme/eng-mod' }))).json.versionId;
    const before_ = await counts();
    assert.equal((await act(vid, 'quarantine', { reason: 'x' }, 'eng')).status, 403);
    assert.equal((await act(vid, 'revoke', { reason: 'x' }, 'eng')).status, 403);
    assert.equal((await act(vid, 'approve', {}, 'eng')).status, 200);    // review is allowed
    assert.equal((await call('/admin/marketplace/reports/x/resolve', { as: 'eng', method: 'POST', body: { state: 'dismissed' } })).status, 403);
    assert.equal((await counts()).versions, before_.versions);
    assert.equal(await vstate(vid), 'approved');
  });

  // ── submissions
  test('a real template package lands as submitted with scan rows, artifact, release event and audit', async () => {
    const zip = templateZip({ id: 'acme/subm', deps: [{ id: 'acme/other', range: '^1.0.0' }] });
    const r = await submit(zip, '?visibility=private');
    assert.equal(r.status, 201, r.text);
    const { listingId, versionId, state, validation } = r.json;
    assert.equal(listingId, 'acme/subm'); assert.equal(state, 'submitted');
    assert.equal(validation.ok, true); assert.equal(validation.verified, true);
    assert.ok(validation.checks.some((c: any) => c.name === 'no-active-content' && c.ok));
    const v = await one('SELECT state, scan_verdict, sha256, size, version, semver_major FROM marketplace_versions WHERE id = $1', [versionId]);
    assert.equal(v.state, 'submitted'); assert.equal(v.scan_verdict, 'clean'); assert.equal(v.sha256, sha256Hex(zip)); assert.equal(Number(v.size), zip.length);
    assert.equal((await one('SELECT visibility, trust, type FROM marketplace_listings WHERE id = $1', [listingId])).visibility, 'private');
    const scans = (await admin.query('SELECT scanner, verdict, findings FROM marketplace_security_scans WHERE version_id = $1', [versionId])).rows;
    assert.equal(scans.length, validation.checks.length + 1);
    const overall = scans.find((s) => s.scanner === 'validation');
    assert.equal(overall.verdict, 'clean'); assert.equal(overall.findings.verified, true);
    assert.ok(scans.some((s) => s.scanner === 'officecli-open' && s.verdict === 'pending' && s.findings[0].skipped === true));
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_dependencies WHERE version_id = $1', [versionId])).n, 1);
    assert.ok(await store.has(sha256Hex(zip)));
    assert.equal((await one('SELECT 1 AS x FROM marketplace_artifacts WHERE sha256 = $1', [sha256Hex(zip)])).x, 1);
    const ev = await events(versionId);
    assert.deepEqual(ev.map((e) => [e.event, e.actor]), [['submitted', 'root']]);
    const au = await auditFor(versionId);
    assert.equal(au.length, 1); assert.equal(au[0].action, 'marketplace.submit'); assert.equal(au[0].admin_user_id, 'root');
    // never artifact bytes in the audit trail
    assert.ok(JSON.stringify(au[0].detail).length < 1000);
  });

  test('a package whose required check fails (macro-enabled pptx) lands rejected immediately and can never be published', async () => {
    const r = await submit(templateZip({ id: 'acme/macro', pptx: macroPptx() }));
    assert.equal(r.status, 201);
    assert.equal(r.json.state, 'rejected'); assert.equal(r.json.validation.ok, false);
    assert.ok(r.json.validation.checks.some((c: any) => c.name === 'no-active-content' && !c.ok));
    const vid = r.json.versionId;
    assert.equal((await one('SELECT scan_verdict FROM marketplace_versions WHERE id = $1', [vid])).scan_verdict, 'blocked');
    assert.equal((await one(`SELECT verdict FROM marketplace_security_scans WHERE version_id = $1 AND scanner = 'validation'`, [vid])).verdict, 'blocked');
    for (const a of ['approve', 'publish', 'claim']) assert.equal((await act(vid, a)).status, 409, a);
    assert.equal(await vstate(vid), 'rejected');
    assert.deepEqual((await events(vid)).map((e) => e.event), ['submitted', 'rejected']);
  });

  test('invalid packages are 400 with NOTHING stored (zip-slip, bad manifest, not a zip, empty), wrong content-type 415', async () => {
    const before_ = await counts(), blobs = store.blobs.size;
    const bad = { zipSlip: zipSync({ [MANIFEST_NAME]: strToU8('{}'), '../evil.txt': strToU8('x') }), badManifest: zipSync({ [MANIFEST_NAME]: strToU8('{"schema":"nope"}') }),
      notZip: strToU8('definitely not a zip'), noManifest: zipSync({ 'a.txt': strToU8('x') }) };
    const r1 = await submit(bad.zipSlip); assert.equal(r1.status, 400); assert.equal(r1.json.code, 'package_zip-slip');
    const r2 = await submit(bad.badManifest); assert.equal(r2.status, 400); assert.equal(r2.json.code, 'package_bad-manifest');
    const r3 = await submit(bad.notZip); assert.equal(r3.status, 400); assert.equal(r3.json.code, 'package_bad-zip');
    const r4 = await submit(bad.noManifest); assert.equal(r4.status, 400); assert.equal(r4.json.code, 'package_missing-manifest');
    assert.equal((await submit(new Uint8Array(0))).status, 400);
    assert.equal((await submit(templateZip(), '', 'root')).status, 201);   // sanity: a good one still works afterwards
    const r5 = await call('/admin/marketplace/submissions', { as: 'root', zip: templateZip({ id: 'acme/ct' }), ct: 'application/json' });
    assert.equal(r5.status, 415);
    assert.equal((await submit(templateZip({ id: 'acme/q1' }), '?visibility=bogus')).status, 400);
    assert.equal((await submit(templateZip({ id: 'acme/q2' }), '?publisher=other')).status, 400);
    assert.equal((await submit(templateZip({ id: 'acme/q3' }), '?visibility=team')).status, 400);
    const after_ = await counts();
    // only the one good submission (and its audit) was added
    assert.equal(after_.versions, before_.versions + 1); assert.equal(store.blobs.size, blobs + 1);
  });

  test('the 64 MiB cap is enforced while reading (declared length and chunked)', async () => {
    const before_ = await counts();
    const big = new Uint8Array(4096);
    const a = await call('/admin/marketplace/submissions', { as: 'root', zip: big, origin: smallBase });
    assert.equal(a.status, 413);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
    const b = await call('/admin/marketplace/submissions', { as: 'root', zip: stream, origin: smallBase });
    assert.equal(b.status, 413);
    assert.deepEqual(await counts(), before_);
  });

  test('a listing that exists with another type is 409 type_mismatch; a repeated version is 409 version_exists', async () => {
    assert.equal((await submit(templateZip({ id: 'acme/dupe' }))).status, 201);
    const before_ = await counts();
    const t = await submit(skillZip('acme/dupe'));
    assert.equal(t.status, 409); assert.equal(t.json.code, 'type_mismatch');
    const d = await submit(templateZip({ id: 'acme/dupe' }));
    assert.equal(d.status, 409); assert.equal(d.json.code, 'version_exists');
    assert.equal((await counts()).versions, before_.versions);
    assert.equal((await submit(templateZip({ id: 'acme/dupe', version: '1.1.0' }))).status, 201);   // a new version of the same listing is fine
  });

  // ── lifecycle, end to end through the PUBLIC api
  test('claim -> approve -> publish makes the listing visible in public search; quarantine then revoke hide it and flip an installed row', async () => {
    const search = async () => ((await call('/v1/marketplace/listings?q=flowzebra', { origin: pubBase })).json.items as any[]).map((i) => i.id);
    const r = await submit(templateZip({ id: 'acme/flow', title: 'Flowzebra deck' }));
    const vid = r.json.versionId;
    assert.deepEqual(await search(), []);
    assert.equal((await call('/admin/marketplace/submissions?state=submitted', { as: 'root' })).json.items.some((i: any) => i.versionId === vid && i.verified === true), true);
    assert.equal((await act(vid, 'claim')).json.state, 'in_review');
    assert.equal((await call('/admin/marketplace/submissions?state=submitted', { as: 'root' })).json.items.some((i: any) => i.versionId === vid), false);
    assert.equal((await call('/admin/marketplace/submissions?state=in_review', { as: 'root' })).json.items.some((i: any) => i.versionId === vid), true);
    assert.equal((await act(vid, 'approve', { reason: 'looks fine' })).json.state, 'approved');
    assert.deepEqual(await search(), []);                          // approved is not yet public
    assert.equal((await act(vid, 'publish')).json.state, 'published');
    assert.equal((await one('SELECT published_at IS NOT NULL AS p FROM marketplace_versions WHERE id = $1', [vid])).p, true);
    assert.deepEqual(await search(), ['acme/flow']);
    assert.equal((await call('/v1/marketplace/listings/acme/flow', { origin: pubBase })).json.trust, 'community');

    // an installed copy on u2's device d2
    await admin.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('i_flow','u2','d2','acme/flow',$1,'enabled',true)`, [vid]);
    const status = () => h.asUser('u2', async () => (await h.app.query(`SELECT state, reason FROM marketplace_installed_status() WHERE listing_id = 'acme/flow'`)).rows[0]);
    assert.equal((await status()).state, 'published');

    assert.equal((await act(vid, 'deprecate')).json.state, 'deprecated');
    assert.deepEqual(await search(), []);                           // search shows listings with a PUBLISHED version: a deprecated one drops out
    assert.equal((await act(vid, 'quarantine', {})).status, 400);    // reason required
    assert.equal((await act(vid, 'quarantine', { reason: 'suspicious network call' })).json.state, 'quarantined');
    assert.deepEqual(await search(), []);
    assert.deepEqual(await status(), { state: 'quarantined', reason: 'suspicious network call' });
    assert.equal((await act(vid, 'publish')).status, 409);          // no way back
    assert.equal((await act(vid, 'revoke', { reason: 'confirmed malicious' })).json.state, 'revoked');
    assert.deepEqual(await status(), { state: 'revoked', reason: 'confirmed malicious' });
    assert.equal((await act(vid, 'revoke', { reason: 'again' })).status, 409);

    // the installing device is told through the public sync endpoint
    const sync = await call('/v1/marketplace/installs/sync', { as: 'u2', method: 'POST', body: { deviceId: 'd2', items: [] }, origin: pubBase });
    assert.equal(sync.status, 200);
    assert.ok(sync.json.updates.some((u: any) => u.listingId === 'acme/flow' && u.revoked === true && u.detail === 'confirmed malicious'), sync.text);

    // every transition wrote a release event and an audit row naming the actor
    const ev = await events(vid);
    assert.deepEqual(ev.map((e) => [e.event, e.actor]), [['submitted', 'root'], ['claimed', 'root'], ['approved', 'root'], ['published', 'root'], ['deprecated', 'root'], ['quarantined', 'root'], ['revoked', 'root']]);
    assert.equal(ev[5].detail.reason, 'suspicious network call'); assert.equal(ev[5].detail.from, 'deprecated'); assert.equal(ev[5].detail.to, 'quarantined');
    const au = await auditFor(vid);
    assert.deepEqual(au.map((a) => a.action), ['marketplace.submit', 'marketplace.claim', 'marketplace.approve', 'marketplace.publish', 'marketplace.deprecate', 'marketplace.quarantine', 'marketplace.revoke']);
    assert.ok(au.every((a) => a.admin_user_id === 'root'));
  });

  test('the engineer is the actor recorded when the engineer approves and publishes', async () => {
    const vid = (await submit(templateZip({ id: 'acme/engflow' }), '', 'root')).json.versionId;
    assert.equal((await act(vid, 'approve', {}, 'eng')).status, 200);
    assert.equal((await act(vid, 'publish', {}, 'eng')).status, 200);
    assert.deepEqual((await events(vid)).map((e) => [e.event, e.actor]), [['submitted', 'root'], ['approved', 'eng'], ['published', 'eng']]);
    assert.equal((await act(vid, 'deprecate', {}, 'eng')).status, 200);   // deprecate needs only write
  });

  test('invalid transitions are 409 and change nothing; unknown ids are 404; reasons are validated', async () => {
    const vid = (await submit(templateZip({ id: 'acme/inv' }))).json.versionId;
    await admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, manifest, sha256, size)
      SELECT 'ver_draft', 'acme/inv', '0.0.1', 0, 0, 1, '{}', sha256, size FROM marketplace_versions WHERE id = $1`, [vid]);
    const before_ = await counts();
    for (const [id, a] of [[vid, 'publish'], [vid, 'deprecate'], ['ver_draft', 'revoke'], ['ver_draft', 'approve'], ['ver_draft', 'publish']] as const) {
      const r = await act(id, a, { reason: 'x' });
      assert.equal(r.status, 409, `${id} ${a}`); assert.equal(r.json.code, 'invalid_transition');
    }
    for (const reason of [undefined, '', '   ', 'x'.repeat(1001), 7]) {
      const r = await act(vid, 'reject', reason === undefined ? {} : { reason });
      assert.equal(r.status, 400, String(reason));
    }
    assert.equal((await act(vid, 'approve', { reason: 'x'.repeat(1001) })).status, 400);
    assert.deepEqual(await counts(), before_);
    assert.equal((await act('ver_missing', 'approve')).status, 404);
    assert.equal((await act('bad id!', 'approve')).status, 404);
    assert.equal((await call('/admin/marketplace/versions/ver_missing', { as: 'root' })).status, 404);
    assert.equal((await act(vid, 'explode')).status, 404);
    assert.equal((await act(vid, 'reject', { reason: 'x'.repeat(1000) })).status, 200);   // exactly the cap is fine
  });

  test('approval is impossible without a verified, clean scan: a skill with no scanner is 409 scan_required; a failed scan is 409 scan_failed', async () => {
    const r = await submit(skillZip('acme/noscan'));
    assert.equal(r.status, 201); assert.equal(r.json.state, 'submitted');
    assert.equal(r.json.validation.ok, true); assert.equal(r.json.validation.verified, false);
    const sc = r.json.validation.checks.find((c: any) => c.name === 'security-scan');
    assert.equal(sc.skipped, true); assert.equal(sc.required, true);
    const vid = r.json.versionId;
    const a = await act(vid, 'approve'); assert.equal(a.status, 409); assert.equal(a.json.code, 'scan_required');
    assert.equal(await vstate(vid), 'submitted');
    // force it to approved behind the API's back: publish must still refuse
    await assert.rejects(admin.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [vid]), /cannot become approved/);   // the DB backstop
    await admin.query(`UPDATE marketplace_versions SET state = 'approved', scan_verdict = 'clean' WHERE id = $1`, [vid]);
    const p = await act(vid, 'publish'); assert.equal(p.status, 409); assert.equal(p.json.code, 'scan_required');
    assert.equal(await vstate(vid), 'approved');
    // a newer, failed scan row wins ("latest")
    await admin.query(`INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict, findings, at) VALUES ('scn_bad',$1,'validation','blocked','{"ok":false,"verified":false,"checks":[]}', now() + interval '1 minute')`, [vid]);
    const f = await act(vid, 'publish'); assert.equal(f.status, 409); assert.equal(f.json.code, 'scan_failed');
    // and a version with no scan rows at all
    await admin.query(`DELETE FROM marketplace_security_scans WHERE version_id = $1`, [vid]);
    const n = await act(vid, 'publish'); assert.equal(n.status, 409); assert.equal(n.json.code, 'scan_required');
    assert.equal(await vstate(vid), 'approved');
  });

  test('a skill submission with an injected CLEAN scanner is verified and can be approved (validate is injectable)', async () => {
    const adminPool = h.pool('ao_admin');
    const { createSkillValidator } = await import('../src/marketplace/validate/skill.ts');
    const { validateArtifact, registerValidator } = await import('../src/marketplace/validate/index.ts');
    const handler = marketplaceAdminHandler({ admin: adminPool, authenticate: async () => 'root', roleOf: () => 'superadmin', store, validate: async (type, pkg) => {
      registerValidator('skill', createSkillValidator({ scanner: async () => ({ verdict: 'safe', findings: [] }) }));
      try { return await validateArtifact(type, pkg); } finally { registerValidator('skill', createSkillValidator()); }
    } });
    const s = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    try {
      const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      const r = await call('/admin/marketplace/submissions', { as: 'x', zip: skillZip('acme/scanned'), origin });
      assert.equal(r.status, 201, r.text); assert.equal(r.json.validation.verified, true);
      assert.equal((await call(`/admin/marketplace/versions/${r.json.versionId}/approve`, { as: 'x', method: 'POST', body: {}, origin })).status, 200);
    } finally { s.close(); }
  });

  test('GET /versions/:id returns manifest, scan rows and release events', async () => {
    const vid = (await submit(templateZip({ id: 'acme/detail' }))).json.versionId;
    const d = await call(`/admin/marketplace/versions/${vid}`, { as: 'ana' });
    assert.equal(d.status, 200);
    assert.equal(d.json.manifest.id, 'acme/detail'); assert.equal(d.json.state, 'submitted');
    assert.equal(d.json.validation.verified, true); assert.ok(d.json.scans.length > 5);
    assert.deepEqual(d.json.events.map((e: any) => e.event), ['submitted']);
    assert.equal(d.json.submission.state, 'submitted');
  });

  test('catalog: fields, filters, strict cursor, limit cap', async () => {
    await admin.query(`
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('cat','Cat','u1',false);
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${'c'.repeat(64)}',1,'k') ON CONFLICT DO NOTHING;
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, updated_at) VALUES
        ('cat/alpha','skill','cat','u1','public','Alpha catalog','2026-10-01T00:00:00Z'),('cat/beta','agent','cat','u1','private','Beta catalog','2026-10-02T00:00:00Z'),
        ('cat/gamma','skill','cat','u1','public','Gamma catalog','2026-10-03T00:00:00Z');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES
        ('cv_a1','cat/alpha','1.0.0',1,0,0,'published','{}','${'c'.repeat(64)}',1,'clean'), ('cv_a2','cat/alpha','1.1.0',1,1,0,'submitted','{}','${'c'.repeat(64)}',1,'pending'),
        ('cv_b1','cat/beta','1.0.0',1,0,0,'quarantined','{}','${'c'.repeat(64)}',1,'blocked');
      INSERT INTO marketplace_reviews(id, listing_id, user_id, stars) VALUES ('cr1','cat/alpha','u1',4),('cr2','cat/alpha','u2',5);
      INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('ci1','u1','d1','cat/alpha','cv_a1','enabled',true),('ci2','u2','d2','cat/alpha','cv_a1','installed',false),('ci3','u2','d2','cat/beta','cv_b1','failed',false);`);
    const list = async (q: string) => call(`/admin/marketplace/catalog${q}`, { as: 'ana' });
    const all = await list('?publisher=cat');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((i: any) => i.id), ['cat/gamma', 'cat/beta', 'cat/alpha']);       // updated_at desc
    const alpha = all.json.items.find((i: any) => i.id === 'cat/alpha');
    assert.deepEqual({ ...alpha, updatedAt: undefined }, {
      id: 'cat/alpha', name: 'Alpha catalog', type: 'skill', publisher: 'cat', visibility: 'public', trust: 'community', state: 'submitted', latestVersion: '1.1.0', latestVersionId: 'cv_a2',
      installs: 2, activeInstalls: 1, ratingAvg: 4.5, ratingCount: 2, updatedAt: undefined, scanVerdict: 'pending', riskTier: null, manualReview: false });
    assert.equal(typeof alpha.updatedAt, 'string');
    const gamma = all.json.items.find((i: any) => i.id === 'cat/gamma');
    assert.equal(gamma.ratingAvg, null); assert.equal(gamma.ratingCount, 0); assert.equal(gamma.state, null); assert.equal(gamma.latestVersion, null); assert.equal(gamma.installs, 0);
    assert.deepEqual((await list('?publisher=cat&type=skill')).json.items.map((i: any) => i.id), ['cat/gamma', 'cat/alpha']);
    assert.deepEqual((await list('?publisher=cat&visibility=private')).json.items.map((i: any) => i.id), ['cat/beta']);
    assert.deepEqual((await list('?publisher=cat&state=quarantined')).json.items.map((i: any) => i.id), ['cat/beta']);
    assert.deepEqual((await list('?publisher=cat&q=gamma')).json.items.map((i: any) => i.id), ['cat/gamma']);
    assert.deepEqual((await list('?publisher=cat&q=cat%2Fal')).json.items.map((i: any) => i.id), ['cat/alpha']);
    // pagination: no overlap, no gaps
    const p1 = await list('?publisher=cat&limit=2');
    assert.equal(p1.json.items.length, 2); assert.ok(p1.json.nextPage);
    const p2 = await list(`?publisher=cat&limit=2&page=${encodeURIComponent(p1.json.nextPage)}`);
    assert.deepEqual([...p1.json.items, ...p2.json.items].map((i: any) => i.id), ['cat/gamma', 'cat/beta', 'cat/alpha']);
    assert.equal(p2.json.nextPage, null);
    // strict input
    for (const q of ['?type=nope', '?state=nope', '?visibility=x', '?publisher=A%20B', '?limit=0', '?limit=abc', '?limit=-1', '?page=garbage', `?page=${Buffer.from('{"u":"x","id":"a/b"}').toString('base64url')}`,
      `?page=${Buffer.from('{"u":"2026-10-01T00:00:00Z","id":"x; DROP"}').toString('base64url')}`, `?q=${'a'.repeat(201)}`]) {
      assert.equal((await list(q)).status, 400, q);
    }
    await admin.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('bulk','Bulk','u1');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) SELECT 'bulk/l' || n, 'skill', 'bulk', 'u1', 'public', 'Bulk ' || n FROM generate_series(1, 105) n`);
    const big = await list('?publisher=bulk&limit=1000');
    assert.equal(big.json.items.length, 100); assert.ok(big.json.nextPage);
    assert.equal((await list(`?publisher=bulk&page=${encodeURIComponent(big.json.nextPage)}`)).json.items.length, 5);
  });

  // ── review round: fail-closed roles, separation of duties, DB backstop, concurrency
  test('without roleOf the API is read-only: submissions, transitions and publishers are 403 with zero rows changed', async () => {
    const h2 = createServer(await (async () => { const hd = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, { tokens } as unknown as AdminDeps), store });
      return async (req: any, res: any) => { if (!(await hd(req, res))) res.writeHead(404).end(); }; })());
    await new Promise<void>((r) => h2.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(h2.address() as AddressInfo).port}`;
    try {
      const vid = (await submit(templateZip({ id: 'acme/failclosed' }))).json.versionId;
      const before_ = await counts();
      assert.equal((await call('/admin/marketplace/submissions', { as: 'root', zip: templateZip({ id: 'acme/fc2' }), origin })).status, 403);
      for (const a of ['claim', 'approve', 'publish', 'quarantine', 'revoke']) assert.equal((await call(`/admin/marketplace/versions/${vid}/${a}`, { as: 'root', method: 'POST', body: { reason: 'x' }, origin })).status, 403, a);
      assert.equal((await call('/admin/marketplace/publishers', { as: 'root', method: 'POST', body: { id: 'zzz', trust: 'verified' }, origin })).status, 403);
      assert.equal((await call('/admin/marketplace/reviews/x', { as: 'root', method: 'DELETE', origin })).status, 403);
      assert.deepEqual(await counts(), before_);
      assert.equal((await call('/admin/marketplace/catalog', { as: 'root', origin })).status, 200);
    } finally { h2.close(); }
  });

  test('publisher squatting: only a superadmin creates a publisher; an engineer submits under an existing one; a failed package never creates one', async () => {
    const before_ = await counts();
    const e1 = await submit(templateZip({ id: 'newsquat/a' }), '', 'eng');
    assert.equal(e1.status, 400); assert.equal(e1.json.code, 'unknown_publisher');
    const e2 = await submit(templateZip({ id: 'failpub/a', pptx: macroPptx() }), '', 'root');
    assert.equal(e2.status, 400); assert.equal(e2.json.code, 'unknown_publisher'); assert.equal(e2.json.validation.ok, false);
    assert.deepEqual(await counts(), before_);
    assert.equal((await one(`SELECT count(*)::int AS n FROM marketplace_publishers WHERE id IN ('newsquat','failpub')`)).n, 0);
    assert.equal((await submit(templateZip({ id: 'acme/by-eng' }), '', 'eng')).status, 201);                       // existing publisher: fine
    const s = await submit(templateZip({ id: 'brandnew/a' }), '', 'root');                                           // superadmin creates it
    assert.equal(s.status, 201);
    assert.deepEqual(await one(`SELECT verified FROM marketplace_publishers WHERE id = 'brandnew'`), { verified: false });
    assert.equal((await one(`SELECT trust FROM marketplace_listings WHERE id = 'brandnew/a'`)).trust, 'community');
  });

  test('self review: the submitter (non-superadmin) cannot approve or publish their own version; a superadmin can', async () => {
    const vid = (await submit(templateZip({ id: 'acme/selfrev' }), '', 'eng')).json.versionId;
    let r = await act(vid, 'approve', {}, 'eng'); assert.equal(r.status, 409); assert.equal(r.json.code, 'self_review');
    assert.equal(await vstate(vid), 'submitted');
    assert.equal((await act(vid, 'approve', {}, 'root')).status, 200);
    r = await act(vid, 'publish', {}, 'eng'); assert.equal(r.status, 409); assert.equal(r.json.code, 'self_review');
    assert.equal((await act(vid, 'publish', {}, 'root')).status, 200);
    const own = (await submit(templateZip({ id: 'acme/selfrev2' }), '', 'root')).json.versionId;
    assert.equal((await act(own, 'approve', {}, 'root')).status, 200);   // superadmin may review their own
  });

  test('DB backstop: a version cannot become approved/published with a pending or blocked scan verdict, but can with clean', async () => {
    const vid = (await submit(templateZip({ id: 'acme/backstop' }))).json.versionId;
    for (const v of ['pending', 'blocked']) {
      await admin.query('UPDATE marketplace_versions SET scan_verdict = $2 WHERE id = $1', [vid, v]);
      for (const st of ['approved', 'published']) await assert.rejects(admin.query('UPDATE marketplace_versions SET state = $2 WHERE id = $1', [vid, st]), /cannot become/, `${v} ${st}`);
    }
    assert.equal(await vstate(vid), 'submitted');
    await admin.query(`UPDATE marketplace_versions SET scan_verdict = 'clean', state = 'published' WHERE id = $1`, [vid]);
    assert.equal(await vstate(vid), 'published');
  });

  test('concurrent submissions: same id+version -> one 201 and one 409 version_exists; different versions both succeed', async () => {
    const same = await Promise.all([submit(templateZip({ id: 'acme/race', version: '1.0.0' })), submit(templateZip({ id: 'acme/race', version: '1.0.0' }))]);
    assert.deepEqual(same.map((r) => r.status).sort(), [201, 409]);
    assert.equal(same.find((r) => r.status === 409)!.json.code, 'version_exists');
    const diff = await Promise.all([submit(templateZip({ id: 'acme/race2', version: '1.0.0' })), submit(templateZip({ id: 'acme/race2', version: '1.1.0' })), submit(templateZip({ id: 'acme/race2', version: '2.0.0' }))]);
    assert.deepEqual(diff.map((r) => r.status), [201, 201, 201]);
    assert.equal((await one(`SELECT count(*)::int AS n FROM marketplace_versions WHERE listing_id = 'acme/race2'`)).n, 3);
  });

  test('minors: reject from approved updates the submission row; extra path segments are 404; a resubmission never rewrites visibility', async () => {
    const vid = (await submit(templateZip({ id: 'acme/minor' }))).json.versionId;
    assert.equal((await act(vid, 'approve')).status, 200);
    assert.equal((await act(vid, 'reject', { reason: 'changed my mind' })).status, 200);
    assert.equal((await one('SELECT state FROM marketplace_submissions WHERE version_id = $1', [vid])).state, 'rejected');
    const v2 = (await submit(templateZip({ id: 'acme/minor', version: '1.1.0' }), '?visibility=private')).json.versionId;
    assert.equal((await act(`${v2}/approve/anything`, 'x')).status, 404);
    assert.equal((await call(`/admin/marketplace/versions/${v2}/approve/anything`, { as: 'root', method: 'POST', body: {} })).status, 404);
    assert.equal(await vstate(v2), 'submitted');
    assert.equal((await one(`SELECT visibility FROM marketplace_listings WHERE id = 'acme/minor'`)).visibility, 'public');   // ?visibility=private did not touch the existing listing
    assert.equal((await auditFor(v2))[0].detail.previousVisibility, undefined);
  });

  test('catalog SQL injection attempts are inert', async () => {
    const before_ = await counts();
    const r = await call(`/admin/marketplace/catalog?q=${encodeURIComponent("'; DROP TABLE marketplace_versions; --")}`, { as: 'ana' });
    assert.equal(r.status, 200);
    assert.equal((await counts()).versions, before_.versions);
  });
});

describe('marketplace admin API: installs, reviews, reports, publishers, analytics (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, api: Server, base = '';
  const call = async (path: string, o: { as?: string; method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOKENS[o.as][0]}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const one = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows[0];
  const SHA = 'd'.repeat(64);

  before(async () => {
    h = await startMarketplacePg(); admin = h.admin;
    const handler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE_OF[id], store: memoryArtifactStore() });
    api = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    await h.owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'),('u2','u2@example.test'),('u3','u3@example.test'),('u4','u4@example.test');
      INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2'),('d3','u3'),('d4','u4'),('d5','u4');`);
    await admin.query(`
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('an','An','u1',true),('other','Other','u2',false);
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA}',1,'k');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, tags) VALUES
        ('an/a','skill','an','u1','public','An A','{pdf,tools}'),('an/b','template','an','u1','public','An B','{pdf}'),('other/c','agent','other','u2','public','Other C','{}');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES
        ('a1','an/a','1.0.0',1,0,0,'published','{}','${SHA}',1),('a2','an/a','1.1.0',1,1,0,'published','{}','${SHA}',1),('b1','an/b','1.0.0',1,0,0,'published','{}','${SHA}',1),('c1','other/c','1.0.0',1,0,0,'published','{}','${SHA}',1);
      INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled, installed_at, updated_at) VALUES
        ('i1','u1','d1','an/a','a1','enabled',true,'2026-10-02T12:00:00Z','2026-10-02T12:00:00Z'),
        ('i2','u2','d2','an/a','a2','enabled',true,'2026-10-05T12:00:00Z','2026-10-05T12:00:00Z'),
        ('i3','u3','d3','an/a','a2','installed',false,'2026-10-10T12:00:00Z','2026-10-10T12:00:00Z'),
        ('i4','u4','d4','an/b','b1','disabled',false,'2026-10-12T12:00:00Z','2026-10-12T12:00:00Z'),
        ('i5','u1','d1','an/b','b1','uninstalled',false,'2026-10-03T12:00:00Z','2026-10-20T12:00:00Z'),
        ('i6','u2','d2','an/b','b1','failed',false,'2026-10-15T12:00:00Z','2026-10-15T12:00:00Z'),
        ('i7','u3','d3','other/c','c1','enabled',true,'2026-09-01T12:00:00Z','2026-09-01T12:00:00Z'),
        ('i8','u1','d1','other/c',NULL,'requested',false,'2026-10-16T12:00:00Z','2026-10-16T12:00:00Z');
      INSERT INTO marketplace_install_events(id, user_id, device_id, listing_id, version_id, event, at) VALUES
        ('e1','u1','d1','an/b','b1','uninstalled','2026-10-20T12:00:00Z'),('e2','u3','d3','other/c','c1','uninstalled','2026-09-20T12:00:00Z'),('e3','u1','d1','an/a','a1','installed','2026-10-02T12:00:00Z');
      INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, at) VALUES
        ('an/a','a1','published','root','2026-10-01T00:00:00Z'),('an/a','a1','quarantined','root','2026-10-14T12:00:00Z'),('other/c','c1','revoked','root','2026-09-30T12:00:00Z');
      INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, body, created_at) VALUES
        ('r1','an/a','u1',5,'Great skill, works well','2026-10-06T00:00:00Z'),('r2','an/a','u2',4,NULL,'2026-10-07T00:00:00Z'),('r3','an/b','u3',3,'ok','2026-10-08T00:00:00Z'),('r4','other/c','u4',1,'bad','2026-09-05T00:00:00Z');
      INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ('an/a','u1'),('an/b','u1');
      INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ('t1','Team','u1'); INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ('t1','u1','owner');
      INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, reason, details, state, created_at) VALUES
        ('rp1','an/a','u2','malware','looks bad','open','2026-10-08T00:00:00Z'),('rp2','an/b','u3','broken',NULL,'open','2026-10-09T00:00:00Z'),('rp3','other/c','u4','other',NULL,'dismissed','2026-10-10T00:00:00Z');`);
  });
  after(async () => { api?.close(); if (h) await h.stop(); });

  test('analytics: every number equals the hand-computed count from the seeded rows; coverage is exact; nothing invented', async () => {
    const r = await call('/admin/marketplace/analytics', { as: 'ana' });
    assert.equal(r.status, 200, r.text);
    const j = r.json;
    assert.deepEqual(j.publishedListingsByType, { agent: 1, skill: 1, template: 1 });
    assert.equal(j.installs, 6);                 // i1 i2 i3 i4 i5 i7 (requested and failed rows are not installs)
    assert.equal(j.failedInstalls, 1);           // i6
    assert.equal(j.failureRate, 1 / 7);
    assert.equal(j.activeInstalls, 3);           // i1 i2 i7 (live and enabled)
    assert.equal(j.uninstalls, 2);               // events e1 e2
    assert.deepEqual(j.updateAdoption, { onLatest: 4, installs: 5, ratio: 0.8 });   // live rows i1..i4,i7; i1 is on the older a1
    assert.equal(j.averageRating, 3.25); assert.equal(j.ratingCount, 4);
    assert.equal(j.securityIncidents, 2);
    assert.deepEqual(j.popularCategories, [{ tag: 'pdf', listings: 2, installs: 4 }, { tag: 'tools', listings: 1, installs: 3 }]);
    assert.deepEqual(j.telemetryCoverage, { devicesReporting: 4, devicesKnown: 5, ratio: 0.8 });   // d1..d4 have install rows; d5 does not
    assert.deepEqual(j.notCollected, ['invocations', 'workflow_completions', 'first_use_activation']);
    for (const k of ['invocations', 'workflowCompletions', 'firstUseActivation']) assert.equal(k in j, false);
  });

  test('analytics filters: publisher and date range', async () => {
    const j = (await call('/admin/marketplace/analytics?publisher=an&from=2026-10-01&to=2026-10-31', { as: 'ana' })).json;
    assert.deepEqual(j.publishedListingsByType, { skill: 1, template: 1 });
    assert.equal(j.installs, 5); assert.equal(j.failedInstalls, 1); assert.equal(j.activeInstalls, 2); assert.equal(j.uninstalls, 1);
    assert.deepEqual(j.updateAdoption, { onLatest: 3, installs: 4, ratio: 0.75 });
    assert.equal(j.averageRating, 4); assert.equal(j.ratingCount, 3);
    assert.equal(j.securityIncidents, 1);
    const t = (await call('/admin/marketplace/analytics?type=agent', { as: 'ana' })).json;
    assert.equal(t.securityIncidents, 1); assert.equal(t.installs, 1); assert.equal(t.averageRating, 1);
    const empty = (await call('/admin/marketplace/analytics?publisher=nobody', { as: 'ana' })).json;
    assert.equal(empty.installs, 0); assert.equal(empty.failureRate, null); assert.equal(empty.averageRating, null); assert.equal(empty.updateAdoption.ratio, null);
    for (const q of ['?from=2026-13-01', '?from=yesterday', '?type=nope', '?publisher=A%20B', '?from=2026-10-05&to=2026-10-01']) assert.equal((await call(`/admin/marketplace/analytics${q}`, { as: 'ana' })).status, 400, q);
  });

  test('installations and per-user installs expose user ids only, never emails', async () => {
    const all = await call('/admin/marketplace/installations', { as: 'ana' });
    assert.equal(all.status, 200); assert.equal(all.json.items.length, 8);
    assert.ok(!all.text.includes('example.test') && !all.text.includes('@'));
    const u1 = await call('/admin/marketplace/installations?user=u1', { as: 'ana' });
    assert.deepEqual(u1.json.items.map((i: any) => i.id).sort(), ['i1', 'i5', 'i8']);
    assert.deepEqual((await call('/admin/marketplace/installations?listing=an/b&state=failed', { as: 'ana' })).json.items.map((i: any) => i.id), ['i6']);
    const p1 = await call('/admin/marketplace/installations?limit=3', { as: 'ana' });
    const p2 = await call(`/admin/marketplace/installations?limit=3&page=${encodeURIComponent(p1.json.nextPage)}`, { as: 'ana' });
    const p3 = await call(`/admin/marketplace/installations?limit=3&page=${encodeURIComponent(p2.json.nextPage)}`, { as: 'ana' });
    assert.deepEqual([...p1.json.items, ...p2.json.items, ...p3.json.items].map((i: any) => i.id), ['i5', 'i8', 'i6', 'i4', 'i3', 'i2', 'i1', 'i7']);
    assert.equal(p3.json.nextPage, null);
    for (const q of ['?state=nope', '?listing=bad', '?user=a%20b', '?page=zzz']) assert.equal((await call(`/admin/marketplace/installations${q}`, { as: 'ana' })).status, 400, q);
    const d = await call('/admin/marketplace/users/u1/installs', { as: 'ana' });
    assert.equal(d.status, 200);
    const i1 = d.json.items.find((i: any) => i.id === 'i1');
    assert.deepEqual({ ...i1, installedAt: undefined, updatedAt: undefined }, { id: 'i1', userId: 'u1', deviceId: 'd1', listingId: 'an/a', versionId: 'a1', version: '1.0.0', versionState: 'published', state: 'enabled', enabled: true,
      scanVerdict: null, lastError: null, scope: 'user', installedAt: undefined, updatedAt: undefined });
    assert.deepEqual(d.json.favorites.map((f: any) => f.listingId).sort(), ['an/a', 'an/b']);
    assert.deepEqual(d.json.reviews.map((x: any) => [x.id, x.stars]), [['r1', 5]]);
    assert.deepEqual(d.json.teams, [{ teamId: 't1', role: 'owner' }]);
    assert.ok(!d.text.includes('example.test'));
    assert.equal((await call('/admin/marketplace/users/nobody/installs', { as: 'ana' })).status, 404);
  });

  test('deleting a review is moderate-only, audited with stars and a body hash (never the text), and recomputes the rating', async () => {
    const lst = await call('/admin/marketplace/reviews?listing=an/a', { as: 'ana' });
    assert.deepEqual(lst.json.items.map((r: any) => r.id), ['r2', 'r1']);
    const before_ = (await one('SELECT count(*)::int AS n FROM marketplace_reviews')).n;
    assert.equal((await call('/admin/marketplace/reviews/r1', { as: 'eng', method: 'DELETE' })).status, 403);
    assert.equal((await call('/admin/marketplace/reviews/r1', { as: 'ana', method: 'DELETE' })).status, 403);
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_reviews')).n, before_);
    assert.equal((await call('/admin/marketplace/reviews/nope', { as: 'root', method: 'DELETE' })).status, 404);
    const d = await call('/admin/marketplace/reviews/r1', { as: 'root', method: 'DELETE' });
    assert.equal(d.status, 200);
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_reviews')).n, before_ - 1);
    const a = await one(`SELECT admin_user_id, target_user_id, detail FROM admin_audit WHERE action = 'marketplace.delete_review'`);
    assert.equal(a.admin_user_id, 'root'); assert.equal(a.target_user_id, 'u1');
    assert.deepEqual(a.detail, { reviewId: 'r1', listingId: 'an/a', stars: 5, bodySha256: createHash('sha256').update('Great skill, works well').digest('hex'), bodyLength: 23 });
    assert.ok(!JSON.stringify(a.detail).includes('Great skill'));
    assert.equal((await one(`SELECT rating_avg::float8 AS a FROM marketplace_listing_stats WHERE listing_id = 'an/a'`)).a, 4);
  });

  test('reports: list by state, resolve is moderate-only, audited, and not repeatable', async () => {
    const open = await call('/admin/marketplace/reports?state=open', { as: 'ana' });
    assert.deepEqual(open.json.items.map((r: any) => r.id), ['rp2', 'rp1']);
    assert.equal((await call('/admin/marketplace/reports', { as: 'ana' })).json.items.length, 3);
    assert.equal((await call('/admin/marketplace/reports?state=nope', { as: 'ana' })).status, 400);
    assert.equal((await call('/admin/marketplace/reports/rp1/resolve', { as: 'eng', method: 'POST', body: { state: 'actioned' } })).status, 403);
    assert.equal((await one(`SELECT state FROM marketplace_reports WHERE id = 'rp1'`)).state, 'open');
    assert.equal((await call('/admin/marketplace/reports/rp1/resolve', { as: 'root', method: 'POST', body: { state: 'bogus' } })).status, 400);
    assert.equal((await call('/admin/marketplace/reports/rp1/resolve', { as: 'root', method: 'POST', body: {} })).status, 400);
    assert.equal((await call('/admin/marketplace/reports/nope/resolve', { as: 'root', method: 'POST', body: { state: 'actioned' } })).status, 404);
    assert.equal((await call('/admin/marketplace/reports/rp2/resolve', { as: 'root', method: 'POST', body: { state: 'triaged' } })).json.state, 'triaged');
    assert.equal((await one(`SELECT resolved_at FROM marketplace_reports WHERE id = 'rp2'`)).resolved_at, null);
    assert.equal((await call('/admin/marketplace/reports/rp1/resolve', { as: 'root', method: 'POST', body: { state: 'actioned', reason: 'quarantined the version' } })).status, 200);
    const row = await one(`SELECT state, resolved_at FROM marketplace_reports WHERE id = 'rp1'`);
    assert.equal(row.state, 'actioned'); assert.notEqual(row.resolved_at, null);
    assert.equal((await call('/admin/marketplace/reports/rp1/resolve', { as: 'root', method: 'POST', body: { state: 'dismissed' } })).status, 409);
    const a = await one(`SELECT detail FROM admin_audit WHERE action = 'marketplace.resolve_report' AND detail->>'reportId' = 'rp1'`);
    assert.deepEqual(a.detail, { reportId: 'rp1', listingId: 'an/a', from: 'open', to: 'actioned', reason: 'quarantined the version' });
  });

  test('publishers: anyone with read can list; only a superadmin can create or verify, and listings follow the trust', async () => {
    const list = await call('/admin/marketplace/publishers', { as: 'ana' });
    assert.deepEqual(list.json.items.map((p: any) => [p.id, p.trust, p.listings]), [['an', 'verified', 2], ['other', 'community', 1]]);
    const before_ = (await one('SELECT count(*)::int AS n FROM marketplace_publishers')).n;
    for (const as of ['eng', 'ana', 'sup']) assert.equal((await call('/admin/marketplace/publishers', { as, method: 'POST', body: { id: 'newpub', trust: 'verified' } })).status, 403, as);
    assert.equal((await one('SELECT count(*)::int AS n FROM marketplace_publishers')).n, before_);
    for (const body of [{}, { id: 'Bad Id', trust: 'verified' }, { id: 'newpub', trust: 'private' }, { id: 'newpub' }, { id: 'newpub', trust: 'verified', displayName: '' }, { id: 'newpub', trust: 'verified', ownerUserId: 'ghost' }])
      assert.ok([400, 404].includes((await call('/admin/marketplace/publishers', { as: 'root', method: 'POST', body })).status), JSON.stringify(body));
    const c = await call('/admin/marketplace/publishers', { as: 'root', method: 'POST', body: { id: 'newpub', trust: 'verified', displayName: 'New Pub', ownerUserId: 'u3' } });
    assert.equal(c.status, 201);
    assert.deepEqual(await one(`SELECT display_name, verified, owner_user_id FROM marketplace_publishers WHERE id = 'newpub'`), { display_name: 'New Pub', verified: true, owner_user_id: 'u3' });
    const u = await call('/admin/marketplace/publishers', { as: 'root', method: 'POST', body: { id: 'other', trust: 'official' } });
    assert.equal(u.status, 200); assert.equal(u.json.listingsUpdated, 1);
    assert.equal((await one(`SELECT trust FROM marketplace_listings WHERE id = 'other/c'`)).trust, 'official');
    assert.equal((await call('/admin/marketplace/publishers', { as: 'ana' })).json.items.find((p: any) => p.id === 'other').trust, 'official');
    assert.deepEqual((await admin.query(`SELECT action, admin_user_id FROM admin_audit WHERE action LIKE 'marketplace.%publisher' ORDER BY id`)).rows,
      [{ action: 'marketplace.create_publisher', admin_user_id: 'root' }, { action: 'marketplace.update_publisher', admin_user_id: 'root' }]);
  });

  test('every request through the API is attributed to the acting admin in admin_audit', async () => {
    const rows = (await admin.query(`SELECT DISTINCT admin_user_id FROM admin_audit`)).rows.map((r) => r.admin_user_id).sort();
    assert.deepEqual(rows, ['ana', 'root']);   // denied requests (eng, sup) change nothing and leave no row
  });
});
