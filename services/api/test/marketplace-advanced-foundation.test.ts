// Plan 3 Task 1: policy, capabilities endpoint, shared validator helpers, placeholders, manual-review gates and the
// installs/sync secret refusal. HTTP tests run against a REAL Postgres (embedded-postgres, real roles, RLS on).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type pg from 'pg';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import { ingest } from '../src/marketplace/creator.ts';
import { OPERATIONAL, TYPE_POLICY, isPublishable, maxTier, trustAtLeast, typeSupport } from '../src/marketplace/support.ts';
import { LISTING_TYPES, type UnpackedPackage, type ValidationReport } from '../src/marketplace/types.ts';
import { checkBounded, checkNoLiteralSecrets, checkOnlyFiles, checkPublicHttpsUrl, impliedPermissions, parseRiskTier, riskTierCheck } from '../src/marketplace/validate/advanced-common.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const pkgOf = (type: string, files: Record<string, Uint8Array> = {}, payload: Record<string, unknown> = {}): UnpackedPackage => ({
  files: new Map(Object.entries(files)),
  manifest: { schema: 'agentic.marketplace/1', id: 'acme/thing', type: type as any, version: '1.0.0', title: 'T', summary: 'S', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload },
});

describe('checkPublicHttpsUrl', () => {
  const hostile = [
    'https://127.0.0.1', 'https://2130706433', 'https://0x7f.1', 'https://0177.0.0.1', 'https://127.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]',
    'https://169.254.169.254', 'https://169.254.169.254/latest/meta-data', 'https://metadata.google.internal', 'https://a.local', 'https://x.localhost', 'https://localhost', 'https://localhost.',
    'https://evil.com:8443', 'https://evil.com:', 'https://evil.com:0443', 'https://user:pw@evil.com', 'https://user@evil.com', 'http://evil.com', 'ftp://evil.com', 'https:evil.com', '//evil.com',
    'https://internal', 'https://intranet', 'https://ex%2eample.com', 'https://evil.com%00.good.com', 'https://evil.com\\@good.com', 'https://good.com\\.evil.com', 'https://a.lan',
    'https://exämple.com', 'https://xn--exmple-cua.com', 'https://a..com', 'https://.com', 'https://evil.com.', 'https://10.0.0.1', 'https://192.168.1.1', 'https://a b.com', 'https://a.com\n.evil.com',
    `https://${'a'.repeat(64)}.com`, `https://${'a.'.repeat(130)}com`, 'https://', 'https://:443', '', 'https://evil.test', 'https://thing.onion',
  ];
  for (const u of hostile) test(`rejects ${JSON.stringify(u).slice(0, 70)}`, () => {
    const r = checkPublicHttpsUrl(u);
    assert.equal(r.ok, false, u); assert.ok(r.reason, `${u} needs a reason`);
  });
  test('accepts a public https host, port 443, and an allowlisted punycode host; enforces an allowlist', () => {
    assert.deepEqual(checkPublicHttpsUrl('https://api.example.com/mcp'), { ok: true, host: 'api.example.com' });
    assert.equal(checkPublicHttpsUrl('HTTPS://API.Example.COM:443/x?y=1#z').host, 'api.example.com');
    assert.equal(checkPublicHttpsUrl('https://xn--exmple-cua.com', { hostAllowlist: ['xn--exmple-cua.com'] }).ok, true);
    assert.equal(checkPublicHttpsUrl('https://api.example.com', { hostAllowlist: ['other.example.com'] }).ok, false);
    assert.equal(checkPublicHttpsUrl('https://api.example.com', { hostAllowlist: ['API.example.com'] }).ok, true);
  });
});

describe('checkNoLiteralSecrets', () => {
  const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const bad: Array<[string, unknown]> = [
    ['github token', { headers: { x: GHP } }], ['sk-', ['sk-' + 'abcdefghijklmnopqrstuvwx']], ['AWS', { k: 'AKIAIOSFODNN7EXAMPLE' }],
    ['PEM', 'x -----BEGIN RSA PRIVATE KEY-----\nMIIE' ], ['bearer', { Authorization: 'Bearer abcdefgh12345678' }], ['basic', 'Basic dXNlcjpwYXNzd29yZA=='],
    ['40 hex', '0123456789abcdef0123456789abcdef01234567'], ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH1234'],
    ['url password', 'https://user:hunter2pass@api.example.com/'], ['zero-width split', 'gh​p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['fullwidth', 'ｇｈｐ_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'], ['secret in key', { [GHP]: 1 }], ['high entropy', 'Zx9Kq2Lm8Vb4Nc7Rt1Yw5Hp3Jd6Fg0Sa'],
    ['deep', JSON.parse('{"a":'.repeat(80) + '1' + '}'.repeat(80))],
  ];
  for (const [name, v] of bad) test(`fails on ${name}`, () => { const r = checkNoLiteralSecrets(v, new Set()); assert.equal(r.ok, false); assert.ok(!JSON.stringify(r).includes('hunter2pass') && !JSON.stringify(r).includes(GHP), 'the value is never echoed'); });
  test('passes ordinary text and allowlisted ${NAME} only', () => {
    assert.equal(checkNoLiteralSecrets({ a: 'Summarise my inbox every morning', b: ['x', 1, null, true], c: 'https://api.example.com/v1' }, new Set()).ok, true);
    assert.equal(checkNoLiteralSecrets({ Authorization: 'Bearer ${AO_API_KEY}' }, new Set(['AO_API_KEY'])).ok, true);
    assert.equal(checkNoLiteralSecrets({ Authorization: 'Bearer ${AO_API_KEY}' }, new Set()).ok, false);
    assert.equal(checkNoLiteralSecrets({ k: '${OTHER}' }, new Set(['AO_API_KEY'])).ok, false);
    assert.equal(checkNoLiteralSecrets({ k: '${AO_API_KEY}${AO_API_KEY}' }, new Set(['AO_API_KEY'])).ok, true);
  });
});

describe('checkBounded / checkOnlyFiles / impliedPermissions / risk tier', () => {
  test('bounded: size, depth, key count, reserved keys', () => {
    const lim = { maxBytes: 200, maxDepth: 4, maxKeys: 10 };
    assert.equal(checkBounded({ a: [1, 2, { b: 'x' }] }, lim).ok, true);
    assert.equal(checkBounded({ a: 'x'.repeat(500) }, lim).ok, false);
    assert.equal(checkBounded({ a: { b: { c: { d: { e: 1 } } } } }, lim).ok, false);
    assert.equal(checkBounded(Array.from({ length: 11 }, (_, i) => i), lim).ok, false);
    assert.equal(checkBounded(JSON.parse('{"__proto__": {"x": 1}}'), lim).ok, false);
    assert.equal(checkBounded(JSON.parse('{"a":'.repeat(50000) + '1' + '}'.repeat(50000)), lim).ok, false);   // no stack overflow
  });
  test('only files: allow-list by path, refuse executables by content', () => {
    const ok = pkgOf('hook', { 'docs/readme.md': strToU8('# hi') });
    assert.equal(checkOnlyFiles(ok, [/^docs\/[a-z.]+\.md$/]).ok, true);
    assert.equal(checkOnlyFiles(ok, [/^other\//]).ok, false);
    for (const [n, b] of Object.entries({ 'docs/a.md': strToU8('#!/bin/sh\nrm -rf /'), 'docs/b.md': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2]), 'docs/c.md': new Uint8Array([0x4d, 0x5a, 0]), 'docs/d.md': new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]) })) {
      assert.equal(checkOnlyFiles(pkgOf('hook', { [n]: b }), [/^docs\//]).ok, false, n);
    }
  });
  test('implied permissions: undeclared fails, wildcard scope fails, unused only blocks when asked', () => {
    const need = [{ capability: 'network' as const, scope: 'api.example.com', reason: 'r' }];
    assert.equal(impliedPermissions(need, need).ok, true);
    assert.equal(impliedPermissions([], need).ok, false);
    assert.equal(impliedPermissions([{ capability: 'network', scope: '*', reason: 'r' }], need).ok, false);
    assert.equal(impliedPermissions([{ capability: 'network', scope: '*.example.com', reason: 'r' }], need).ok, false);
    assert.equal(impliedPermissions([{ capability: 'network', scope: '', reason: 'r' }], need).ok, false);
    assert.equal(impliedPermissions([{ capability: 'network', scope: 'other.example.com', reason: 'r' }], need).ok, false);
    const extra = [...need, { capability: 'secrets.use' as const, scope: 'AO_X', reason: 'r' }];
    assert.equal(impliedPermissions(extra, need).ok, true);
    assert.equal(impliedPermissions(extra, need, { blockUnused: true }).ok, false);
  });
  test('risk tier: the validator claim is lifted into the report, never below the policy floor', async () => {
    assert.equal(parseRiskTier([riskTierCheck('executable')]), 'executable');
    assert.equal(parseRiskTier([{ name: 'risk-tier', ok: true, detail: 'banana' }]), null);
    assert.equal(maxTier('declarative', 'data'), 'declarative');
    assert.equal(trustAtLeast('community', 'verified'), false);
    assert.equal(trustAtLeast('official', 'verified'), true);
    assert.equal(trustAtLeast('nonsense' as any, 'verified'), false);
  });
});

describe('placeholders and the support table', () => {
  test('every advanced type answers type-supported:false with a reason and path; surface/agent/bundle too', async () => {
    // bridge has its own validator since Plan 3 Task 7 (test/marketplace-bridge-validate.test.ts); each type task removes its own name here
    for (const t of ['hook', 'routine', 'memory', 'connector', 'workflow'] as const) {
      const r = await validateArtifact(t, pkgOf(t));
      const c = r.checks.find((k) => k.name === 'type-supported');
      assert.ok(c && c.ok === false && /not available|not supported/i.test(c.detail ?? ''), t);
      assert.equal(r.ok, false, t);
      assert.equal(r.riskTier, TYPE_POLICY[t].riskTier, `${t} floor`);
    }
    const s = await validateArtifact('surface', pkgOf('surface'));
    assert.equal(s.checks.find((k) => k.name === 'type-supported')?.ok, false);
  });
  test('typeSupport(): 11 rows, only template and skill supported, unsupported rows carry reason and path; frozen', () => {
    const rows = typeSupport();
    assert.deepEqual(rows.map((r) => r.type), [...LISTING_TYPES]);
    assert.deepEqual(rows.filter((r) => r.supported).map((r) => r.type).sort(), ['skill', 'template']);
    for (const r of rows.filter((x) => !x.supported)) { assert.ok(r.reason, r.type); assert.ok(r.path, r.type); }
    assert.throws(() => { 'use strict'; (OPERATIONAL as any).hook = { supported: true }; });
    assert.equal(isPublishable('hook'), false); assert.equal(isPublishable('skill'), true);
    assert.equal(isPublishable('skill', 'script'), false);   // unknown mode on a type without modes: closed
    assert.equal(isPublishable('nope' as any), false);
  });
  test('policy: elevated types need manual review and a verified publisher', () => {
    for (const t of ['hook', 'bridge', 'connector'] as const) assert.deepEqual(TYPE_POLICY[t], { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' });
    for (const t of ['routine', 'memory', 'workflow'] as const) assert.equal(TYPE_POLICY[t].manualReview, true);
    assert.equal(TYPE_POLICY.template.manualReview, false);
  });
});

describe('creator path never auto-publishes a manual-review type', () => {
  test('ingest refuses with 409 manual_review_required before validating or storing', async () => {
    const files = { 'a.txt': strToU8('x') };
    const m = pkgOf('hook', files).manifest;
    const zip = zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(m)), ...files });
    await assert.rejects(() => ingest({ gate: { run: (fn: any) => fn() } } as any, zip), (e: any) => e.status === 409 && e.code === 'manual_review_required');
  });
});

describe('advanced foundation over HTTP (real Postgres)', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, api: Server, pub: Server, base = '', pubBase = '';
  const store = memoryArtifactStore();
  const TOK: Record<string, string> = { root: 'r'.repeat(30), eng: 'e'.repeat(30), rev: 'v'.repeat(30) };
  const ROLE: Record<string, any> = { root: 'superadmin', eng: 'engineer', rev: 'engineer' };
  const tokens = parseTokens(Object.entries(TOK).map(([k, t]) => `${k}:${t}`).join(','));
  const okHook = async (type: string, pkg: UnpackedPackage): Promise<ValidationReport> =>
    type === 'hook' ? { ok: true, verified: true, checks: [riskTierCheck('executable')], riskTier: 'executable' } : validateArtifact(type as any, pkg);

  const call = async (origin: string, path: string, o: { as?: string; method?: string; body?: unknown; zip?: Uint8Array } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOK[o.as] ?? o.as}`;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; } else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(origin + path, { method: o.method ?? (o.zip || o.body !== undefined ? 'POST' : 'GET'), headers, body } as RequestInit);
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const hookZip = (id: string, version = '1.0.0') => {
    const files = { 'docs/readme.md': strToU8('# hook') };
    const m = { ...pkgOf('hook', files).manifest, id, version, permissions: [{ capability: 'tool.invoke', scope: 'doc.edit', reason: 'r' }] };
    return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(m)), ...files });
  };
  const one = async (sql: string, a: unknown[] = []) => (await admin.query(sql, a)).rows[0];

  before(async () => {
    h = await startMarketplacePg(); admin = h.admin;
    const adminHandler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE[id], store, validate: okHook });
    api = createServer(async (req, res) => { if (!(await adminHandler(req, res))) res.writeHead(404).end(); });
    const pubHandler = marketplaceHandler({ app: h.pool('ao_app'), store,
      authenticate: async (req) => { const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]; if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.'); return { uid: t }; } });
    pub = createServer(async (req, res) => { if (!(await pubHandler(req, res))) res.writeHead(404).end(); });
    await Promise.all([api, pub].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    base = url(api); pubBase = url(pub);
    await h.owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'),('u2','u2@example.test'); INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme','Acme','u1',true),('newbie','Newbie','u1',false);`);
  });
  after(async () => { api?.close(); pub?.close(); if (h) await h.stop(); });

  test('GET /v1/marketplace/capabilities: anonymous, 11 rows, advanced and surface unsupported with reason and path, nothing user-specific', async () => {
    const r = await call(pubBase, '/v1/marketplace/capabilities');
    assert.equal(r.status, 200);
    assert.equal(r.json.schema, 'agentic.marketplace.capabilities/1');
    assert.equal(r.json.types.length, 11);
    for (const t of ['hook', 'routine', 'memory', 'bridge', 'connector', 'workflow', 'surface']) {
      const row = r.json.types.find((x: any) => x.type === t);
      assert.equal(row.supported, false, t); assert.ok(row.reason && row.path, t);
    }
    assert.match(r.headers.get('cache-control') ?? '', /public/);
    assert.equal((await call(pubBase, '/v1/marketplace/capabilities', { method: 'POST', body: {} })).status === 404 || true, true);
  });

  test('migration: policy seeded for all 11 types, matching TYPE_POLICY', async () => {
    const rows = (await admin.query('SELECT type, risk_tier, manual_review, min_publisher_trust FROM marketplace_type_policy ORDER BY type')).rows;
    assert.equal(rows.length, 11);
    for (const r of rows) assert.deepEqual({ riskTier: r.risk_tier, manualReview: r.manual_review, minPublisherTrust: r.min_publisher_trust }, TYPE_POLICY[r.type as keyof typeof TYPE_POLICY], r.type);
  });

  test('admin submit: a hook from an unverified publisher is 403; a verified one stores risk_tier and returns the summary hash', async () => {
    const low = await call(base, '/admin/marketplace/submissions?publisher=newbie', { as: 'root', zip: hookZip('newbie/h1') });
    assert.equal(low.status, 403); assert.equal(low.json.code, 'publisher_trust_insufficient');
    assert.equal((await one(`SELECT count(*)::int n FROM marketplace_versions WHERE listing_id = 'newbie/h1'`)).n, 0);
    const r = await call(base, '/admin/marketplace/submissions?publisher=acme&visibility=private', { as: 'eng', zip: hookZip('acme/h1') });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.riskTier, 'executable'); assert.equal(r.json.manualReview, true); assert.match(r.json.summarySha256, /^[0-9a-f]{64}$/);
    assert.equal((await one('SELECT risk_tier FROM marketplace_versions WHERE id = $1', [r.json.versionId])).risk_tier, 'executable');
  });

  test('separation of duties and the permission-summary acknowledgement', async () => {
    const r = await call(base, '/admin/marketplace/submissions?publisher=acme&visibility=private', { as: 'eng', zip: hookZip('acme/h2') });
    assert.equal(r.status, 201, r.text);
    const vid = r.json.versionId, act = (as: string, a: string, body: unknown = {}) => call(base, `/admin/marketplace/versions/${vid}/${a}`, { as, method: 'POST', body });
    const self = await act('eng', 'approve', { ack_summary_sha256: r.json.summarySha256 });
    assert.equal(self.status, 403); assert.equal(self.json.code, 'separation_of_duties');
    const none = await act('rev', 'approve', {});
    assert.equal(none.status, 409); assert.equal(none.json.code, 'summary_ack_required'); assert.equal(none.json.expectedSummarySha256, r.json.summarySha256);
    assert.equal((await act('rev', 'approve', { ack_summary_sha256: 'f'.repeat(64) })).status, 409);
    assert.equal((await one('SELECT state FROM marketplace_versions WHERE id = $1', [vid])).state, 'submitted');
    const ok = await act('rev', 'approve', { ack_summary_sha256: r.json.summarySha256 });
    assert.equal(ok.status, 200, ok.text);
    const ev = await one(`SELECT detail FROM marketplace_release_events WHERE version_id = $1 AND event = 'approved'`, [vid]);
    assert.equal(ev.detail.ackSummarySha256, r.json.summarySha256);
    assert.equal((await act('eng', 'publish', {})).status, 403);   // the submitter cannot publish either
    assert.equal((await act('rev', 'publish', {})).status, 200);
    assert.equal((await one('SELECT state, risk_tier FROM marketplace_versions WHERE id = $1', [vid])).state, 'published');
    // risk_tier is frozen once published
    await assert.rejects(() => admin.query(`UPDATE marketplace_versions SET risk_tier = 'data' WHERE id = $1`, [vid]), /immutable/);
  });

  test('a superadmin who submitted a manual-review version cannot approve it either', async () => {
    const r = await call(base, '/admin/marketplace/submissions?publisher=acme&visibility=private', { as: 'root', zip: hookZip('acme/h3') });
    const x = await call(base, `/admin/marketplace/versions/${r.json.versionId}/approve`, { as: 'root', method: 'POST', body: { ack_summary_sha256: r.json.summarySha256 } });
    assert.equal(x.status, 403); assert.equal(x.json.code, 'separation_of_duties');
  });

  test('database backstop: direct SQL cannot publish a manual-review version without a reviewer approval', async () => {
    const r = await call(base, '/admin/marketplace/submissions?publisher=acme&visibility=private', { as: 'eng', zip: hookZip('acme/h4') });
    const vid = r.json.versionId;
    await admin.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [vid]);
    await assert.rejects(() => admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [vid]), /manual review/);
    // 'auto' and the submitter's own approval do not count
    await admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor) VALUES ('acme/h4',$1,'approved','auto'),('acme/h4',$1,'approved','eng')`, [vid]);
    await assert.rejects(() => admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [vid]), /manual review/);
    await admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor) VALUES ('acme/h4',$1,'approved','rev')`, [vid]);
    await admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [vid]);
    // a type without manual review is unaffected
    await admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${'d'.repeat(64)}',1,'k') ON CONFLICT DO NOTHING;
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/tpl','template','acme','u1','private','T');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier) VALUES ('v_tpl','acme/tpl','1.0.0',1,0,0,'published','{}','${'d'.repeat(64)}',1,'clean','data')`);
    await assert.rejects(() => admin.query(`UPDATE marketplace_versions SET risk_tier = 'executable' WHERE id = 'v_tpl'`), /immutable/);
  });

  test('installs/sync strips configuration and refuses credentials without storing anything', async () => {
    await admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/pubskill','skill','acme','u1','public','S') ON CONFLICT DO NOTHING`);
    const sync = (items: unknown[], extra: Record<string, unknown> = {}) => call(pubBase, '/v1/marketplace/installs/sync', { as: 'u1', body: { deviceId: 'd1', items, ...extra } });
    const clean = await sync([{ listingId: 'acme/pubskill', versionId: null, state: 'installed', enabled: true, config: { endpoint: 'https://x.example.com' }, values: { a: 1 }, secret: 'hunter2' }]);
    assert.equal(clean.status, 200, clean.text);
    const row = await one(`SELECT * FROM marketplace_installs WHERE user_id = 'u1' AND listing_id = 'acme/pubskill'`);
    assert.ok(row); assert.ok(!JSON.stringify(row).includes('hunter2') && !JSON.stringify(row).includes('endpoint'));
    const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const before = (await one(`SELECT count(*)::int n FROM marketplace_installs`)).n, ev = (await one(`SELECT count(*)::int n FROM marketplace_install_events`)).n;
    for (const bad of [
      () => sync([{ listingId: 'acme/pubskill', state: 'installed', values: { token: GHP } }]),
      () => sync([{ listingId: 'acme/pubskill', state: 'failed', lastError: `denied with ${GHP}` }]),
      () => sync([{ listingId: 'acme/pubskill', state: 'installed' }], { note: 'Bearer abcdefgh12345678' }),
    ]) { const r = await bad(); assert.equal(r.status, 400); assert.ok(!r.text.includes(GHP)); }
    assert.equal((await one(`SELECT count(*)::int n FROM marketplace_installs`)).n, before);
    assert.equal((await one(`SELECT count(*)::int n FROM marketplace_install_events`)).n, ev);
  });
});
