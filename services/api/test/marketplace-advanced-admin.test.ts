// Plan 3 Task 12: the admin API for the advanced types. Unit tests for the summary builder, then HTTP tests on a REAL Postgres
// (embedded-postgres, real roles; the handler runs as ao_admin) covering authz, the acknowledgement flow, the per-type halt, type policy,
// analytics and the security view, with the hostile cases (wrong role, forged and stale hashes, oversize, probing).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type pg from 'pg';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex, unpack } from '../src/marketplace/artifacts.ts';
import { buildReviewSummary, reviewSummaryHash, MAX_SUMMARY_BYTES } from '../src/marketplace/summary.ts';
import { TYPE_POLICY } from '../src/marketplace/support.ts';
import { LISTING_TYPES, type ManifestV1, type UnpackedPackage } from '../src/marketplace/types.ts';
import { benign as hookBenign } from '../evals/corpora/hook.ts';
import { benign as memBenign } from '../evals/corpora/memory.ts';
import { benign as wfBenign } from '../evals/corpora/workflow.ts';
import { bridgePackage } from '../evals/corpora/bridge.ts';
import { connectorPackage } from '../evals/corpora/connector.ts';
import { baseRoutine } from '../evals/corpora/routine.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const zipOf = (pkg: UnpackedPackage): Uint8Array => zipSync({ [MANIFEST_NAME]: enc(JSON.stringify(pkg.manifest)), ...Object.fromEntries(pkg.files) });
const retarget = (bytes: Uint8Array, id: string, version = '1.0.0'): Uint8Array => { const p = unpack(bytes); p.manifest = { ...p.manifest, id, version }; return zipOf(p); };
const withId = (p: UnpackedPackage, id: string): UnpackedPackage => ({ files: p.files, manifest: { ...p.manifest, id } });
const routinePkg = (): UnpackedPackage => {
  const spec = baseRoutine();
  return { files: new Map(), manifest: { schema: 'agentic.marketplace/1', id: 'acme/weekly', type: 'routine', version: '1.0.0', title: 'Weekly summary', summary: 'A routine.', license: 'MIT', compat: { app: '^1.0.0' },
    dependencies: spec.dependencies, permissions: spec.permissions, files: [], payload: spec.payload } as ManifestV1 };
};
const fixtures = async () => ({
  hook: unpack(await hookBenign[0].build()), bridge: bridgePackage(), connector: connectorPackage(), routine: routinePkg(),
  memory: memBenign.find((c) => c.id === 'mem0-declared-key')!.build(), workflow: unpack(await wfBenign.find((c) => c.id === 'w03-edit-workflow')!.build()),
});
const sumOf = (p: UnpackedPackage, tier: any = 'executable', checks: any[] = []) => buildReviewSummary(p.manifest.type, p.manifest, { artifactSha256: 'a'.repeat(64), riskTier: tier, checks });

describe('buildReviewSummary', () => {
  test('hash is the Task 1 acknowledgement hash, unchanged (pinned against an independent copy of the algorithm)', async () => {
    const canon = (v: any): any => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
    const old = (manifest: any, artifactSha: string, tier: string | null) => createHash('sha256').update(JSON.stringify(canon({ schema: 'agentic.marketplace.review-summary/1', id: manifest?.id, type: manifest?.type, version: manifest?.version,
      artifact: artifactSha, riskTier: tier, permissions: [...(manifest?.permissions ?? [])].map(canon).sort((a: any, b: any) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1), dependencies: canon(manifest?.dependencies ?? []), payload: canon(manifest?.payload ?? {}) }))).digest('hex');
    for (const p of Object.values(await fixtures())) {
      assert.equal(reviewSummaryHash(p.manifest, 'b'.repeat(64), 'executable'), old(p.manifest, 'b'.repeat(64), 'executable'));
      assert.equal(sumOf(p).sha256, old(p.manifest, 'a'.repeat(64), 'executable'));
    }
  });

  test('the hash moves when anything the text is built from moves (payload, permissions, artifact, tier); not when only the title does', async () => {
    const p = (await fixtures()).hook;
    const base = sumOf(p).sha256;
    const edit = (f: (m: any) => void) => { const m = structuredClone(p.manifest) as any; f(m); return buildReviewSummary('hook', m, { artifactSha256: 'a'.repeat(64), riskTier: 'executable' }).sha256; };
    assert.notEqual(edit((m) => { m.payload.rules[0].action.message = 'changed'; }), base);
    assert.notEqual(edit((m) => { m.permissions.push({ capability: 'network', scope: 'x.example.com', reason: 'r' }); }), base);
    assert.notEqual(buildReviewSummary('hook', p.manifest, { artifactSha256: 'c'.repeat(64), riskTier: 'executable' }).sha256, base);
    assert.notEqual(buildReviewSummary('hook', p.manifest, { artifactSha256: 'a'.repeat(64), riskTier: 'declarative' }).sha256, base);
    assert.equal(edit((m) => { m.title = 'another title'; }), base);
  });

  test('a benign package shows its artifact hash and nothing is withheld', async () => {
    for (const p of Object.values(await fixtures())) {
      const sha = createHash('sha256').update(p.manifest.id).digest('hex');
      const s = buildReviewSummary(p.manifest.type, p.manifest, { artifactSha256: sha, riskTier: 'executable' });
      assert.ok(s.text.includes(`Artifact sha256: ${sha}`), p.manifest.type); assert.ok(!/withheld/.test(s.text), `${p.manifest.type}: ${s.text.match(/.*withheld.*/)?.[0]}`);
    }
  });

  test('hook: every rule, its event mapping and action text are in the text; 20 long rules are all there; a cap-busting 300 rules is flagged truncated', async () => {
    const p = (await fixtures()).hook;
    const rules = Array.from({ length: 20 }, (_, i) => ({ id: `rule-${i}`, event: i % 2 ? 'before_export' : 'before_document_edit', when: { tool: `docx_tool${i}`, arg_contains: { path: `secret-folder-${i}` } }, action: { type: 'block', message: `Rule ${i} says ${'stop '.repeat(30)}end-${i}` } }));
    const m = { ...structuredClone(p.manifest), payload: { kind: 'declarative', rules } } as ManifestV1;
    const s = buildReviewSummary('hook', m, { artifactSha256: 'a'.repeat(64), riskTier: 'executable' });
    assert.equal(s.truncated, false);
    for (let i = 0; i < 20; i++) { assert.ok(s.text.includes(`[rule-${i}]`), `rule ${i}`); assert.ok(s.text.includes(`end-${i}`), `message ${i}`); assert.ok(s.text.includes(`docx_tool${i}`)); }
    assert.match(s.text, /before_export -> Hermes pre_tool_call \(derived\)/);
    assert.ok(s.highRisk.some((r) => /can BLOCK/.test(r)));
    const many = { ...m, payload: { kind: 'declarative', rules: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, event: 'after_export', action: { type: 'log' } })) } } as ManifestV1;
    const t = buildReviewSummary('hook', many, { artifactSha256: 'a'.repeat(64), riskTier: 'executable' });
    assert.equal(t.truncated, true); assert.match(t.text, /more rules not shown/);
  });

  test('bridge: host, transport, tools and the secret NAME; connector: definition, secret field, network and data locality', async () => {
    const f = await fixtures();
    const b = sumOf(f.bridge);
    assert.match(b.text, /Host: https:\/\/mcp\.issues-example\.com\/mcp/); assert.match(b.text, /search_issues \[read\]/); assert.match(b.text, /secret named "token"/);
    assert.ok(b.highRisk.some((r) => /network: mcp\.issues-example\.com/.test(r)));
    const c = sumOf(f.connector);
    assert.match(c.text, /Service: example-issues/); assert.match(c.text, /api_key: API key \[SECRET/); assert.match(c.text, /Regions: eu/); assert.match(c.text, /nothing is sent to other services/);
    assert.match(c.text, /Network allowlist: \*\.issues-example\.com/); assert.ok(c.highRisk.some((r) => /secret field: api_key/.test(r)));
  });

  test('routine: schedule, full prompt, toolsets and unattended; memory: provider locality; workflow: DAG facts', async () => {
    const f = await fixtures();
    const r = sumOf(f.routine, 'declarative');
    assert.match(r.text, /Schedule template: \{minute\} \{hour\} \* \* \{dow\}/); assert.match(r.text, /Summarise what changed in the \{folder\} folder/); assert.match(r.text, /Toolsets it may use: file_read/); assert.ok(r.highRisk.includes('runs unattended on a schedule'));
    const mem = sumOf(f.memory, 'declarative');
    assert.match(mem.text, /Provider: mem0/); assert.match(mem.text, /REMOTE: your memories are sent to api\.mem0\.ai/); assert.match(mem.text, /MEM0_API_KEY/); assert.ok(mem.highRisk.some((x) => /memory leaves the device: api\.mem0\.ai/.test(x)));
    const local = sumOf(memBenign.find((c) => c.id === 'holographic-local')!.build(), 'declarative');
    assert.match(local.text, /local to this device/); assert.ok(!local.highRisk.some((x) => /leaves the device/.test(x)));
    const w = sumOf(f.workflow, 'declarative');
    assert.match(w.text, /Steps: \d+/); assert.match(w.text, /docx:docx_apply \(edit\)/); assert.ok(w.highRisk.some((x) => /changes documents: docx:docx_apply/.test(x)));
  });

  test('no secret ever appears: a credential smuggled past the validators is withheld and flagged; env var and field NAMES are fine', async () => {
    const p = (await fixtures()).hook;
    const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const m = structuredClone(p.manifest) as any;
    m.payload.rules[0].action.message = `Use ${GH} to continue`; m.permissions[0].reason = `key ${GH}`; m.title = GH;
    const s = buildReviewSummary('hook', m, { artifactSha256: 'a'.repeat(64), riskTier: 'executable', checks: [{ name: 'x', ok: false, detail: `leaked ${GH}` }] });
    assert.ok(!JSON.stringify(s).includes(GH), 'the token must not be in the summary at all');
    assert.match(s.text, /withheld/); assert.ok(s.highRisk.some((x) => /withheld/.test(x)));
  });

  test('never throws and stays bounded on garbage, hostile depth and huge input', async () => {
    const cases: any[] = [null, undefined, 5, 'x', [], { payload: null }, { payload: { rules: 'no' } }, { payload: { rules: [null, 1, 'x', []] } }, { payload: JSON.parse('{"a":'.repeat(500) + '1' + '}'.repeat(500)) }];
    for (const type of LISTING_TYPES) for (const m of cases) {
      const s = buildReviewSummary(type, m, { artifactSha256: 'a'.repeat(64), riskTier: null });
      assert.equal(typeof s.text, 'string'); assert.equal(s.riskTier, 'executable', 'unknown tier shows the strictest');
    }
    const big = { schema: 'agentic.marketplace/1', id: 'a/b', type: 'routine', version: '1.0.0', permissions: Array.from({ length: 5000 }, (_, i) => ({ capability: 'network', scope: `h${i}.example.com`, reason: 'x'.repeat(5000) })), payload: { blueprint: { prompt_template: 'p'.repeat(1_000_000) } } } as any;
    const s = buildReviewSummary('routine', big, { artifactSha256: 'a'.repeat(64), riskTier: 'declarative' });
    assert.ok(s.text.length < MAX_SUMMARY_BYTES + 8192, `bounded, got ${s.text.length}`); assert.equal(s.truncated, true);
    assert.ok(s.highRisk.length <= 25);
  });

  test('unmapped hook event and agent-step workflows are called out', async () => {
    const p = (await fixtures()).hook;
    const m = { ...structuredClone(p.manifest), payload: { kind: 'declarative', rules: [{ id: 'z', event: 'before_publish', action: { type: 'log' } }, { id: 'q', event: '__proto__', action: { type: 'log' } }] } } as ManifestV1;
    const s = buildReviewSummary('hook', m, { artifactSha256: 'a'.repeat(64), riskTier: 'executable' });
    assert.ok(s.highRisk.some((x) => /rule z: event before_publish is unsupported/.test(x))); assert.ok(s.highRisk.some((x) => /rule q: event __proto__ is not a mapped event/.test(x)));
  });
});

describe('advanced admin API over HTTP (real Postgres, real roles)', { skip }, () => {
  let h: MarketplacePg, owner: pg.Client, admin: pg.Client, api: Server, pub: Server, base = '', pubBase = '';
  const store = memoryArtifactStore();
  const TOK: Record<string, string> = { root: 'r'.repeat(30), eng: 'e'.repeat(30), rev: 'v'.repeat(30), ana: 'a'.repeat(30), sup: 's'.repeat(30), ver: 'w'.repeat(30), nobody: 'n'.repeat(30) };
  const ROLE: Record<string, any> = { root: 'superadmin', eng: 'engineer', rev: 'engineer', ana: 'analyst', sup: 'support', ver: 'verifier' };
  const tokens = parseTokens(Object.entries(TOK).filter(([k]) => k !== 'nobody').map(([k, t]) => `${k}:${t}`).join(','));
  const call = async (origin: string, path: string, o: { as?: string; method?: string; body?: unknown; raw?: string; zip?: Uint8Array } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOK[o.as] ?? o.as}`;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; } else if (o.raw !== undefined) { headers['content-type'] = 'application/json'; body = o.raw; } else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(origin + path, { method: o.method ?? (o.zip || o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET'), headers, body } as RequestInit);
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, text };
  };
  const A = (path: string, o: Parameters<typeof call>[2] = {}) => call(base, `/admin/marketplace${path}`, o);
  const one = async (sql: string, a: unknown[] = []) => (await owner.query(sql, a)).rows[0];
  const rows = async (sql: string, a: unknown[] = []) => (await owner.query(sql, a)).rows;
  const snapshot = async () => JSON.stringify({
    v: await rows('SELECT id, state FROM marketplace_versions ORDER BY id'), p: await rows('SELECT type, risk_tier, manual_review, min_publisher_trust FROM marketplace_type_policy ORDER BY type'),
    e: (await one('SELECT count(*)::int n FROM marketplace_release_events')).n, a: (await one('SELECT count(*)::int n FROM admin_audit')).n });
  const submit = (as: string, pkg: UnpackedPackage | Uint8Array, q = '?publisher=acme&visibility=private') => A(`/submissions${q}`, { as, zip: pkg instanceof Uint8Array ? pkg : zipOf(pkg) });
  const ids: Record<string, any> = {};

  before(async () => {
    h = await startMarketplacePg(); owner = h.owner; admin = h.admin;
    const adminHandler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE[id], store });
    api = createServer(async (req, res) => { if (!(await adminHandler(req, res))) res.writeHead(404).end(); });
    const pubHandler = marketplaceHandler({ app: h.pool('ao_app'), store,
      authenticate: async (req) => { const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]; if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.'); return { uid: t }; } });
    pub = createServer(async (req, res) => { if (!(await pubHandler(req, res))) res.writeHead(404).end(); });
    await Promise.all([api, pub].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    base = url(api); pubBase = url(pub);
    await owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'),('u2','u2@example.test'),('u3','u3@example.test'); INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2'),('d3','u3'),('d4','u3');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme','Acme','u1',true);`);
  });
  after(async () => { api?.close(); pub?.close(); if (h) await h.stop(); });

  // ---------------------------------------------------------------- per-type submit, queue entry, detail, acknowledgement
  test('each advanced type: the submit response, the queue entry and the detail agree on one summary hash; the detail renders that type\'s facts', async () => {
    const f = await fixtures();
    const subs: Array<[string, UnpackedPackage | Uint8Array, RegExp[]]> = [
      ['hook', retarget(zipOf(f.hook), 'acme/hk-a'), [/\[h01|\[[a-z0-9-]+\] on before_document_edit -> Hermes pre_tool_call \(derived\)/, /Confidential documents are not editable/]],
      ['bridge', withId(f.bridge, 'acme/br-a'), [/Host: https:\/\/mcp\.issues-example\.com/, /search_issues \[read\]/]],
      ['connector', withId(f.connector, 'acme/cn-a'), [/Service: example-issues/, /Regions: eu/, /\[SECRET/]],
      ['memory', withId(f.memory, 'acme/mm-a'), [/Provider: mem0/, /REMOTE: your memories are sent to api\.mem0\.ai/]],
      ['routine', withId(f.routine, 'acme/rt-a'), [/Schedule template/, /Summarise what changed/, /Toolsets it may use: file_read/]],
    ];
    for (const [type, pkg, res] of subs) {
      const r = await submit('eng', pkg);
      assert.equal(r.status, 201, `${type}: ${r.text.slice(0, 600)}`);
      assert.equal(r.json.manualReview, true, type); assert.match(r.json.summarySha256, /^[0-9a-f]{64}$/);
      ids[type] = r.json;
      const q = (await A('/submissions', { as: 'ana' })).json.items.find((x: any) => x.versionId === r.json.versionId);
      assert.equal(q.summarySha256, r.json.summarySha256, `${type} queue hash`); assert.equal(q.manualReview, true); assert.ok(Array.isArray(q.highRisk)); assert.equal(q.summaryTruncated, false);
      const d = await A(`/submissions/${r.json.versionId}`, { as: 'ana' });
      assert.equal(d.status, 200, d.text); assert.equal(d.json.summarySha256, r.json.summarySha256, `${type} detail hash`); assert.equal(d.json.type, type);
      assert.equal(d.json.acknowledgement.required, true); assert.equal(d.json.summary.truncated, false);
      for (const re of res) assert.match(d.json.summary.text, re, `${type} detail text`);
      assert.deepEqual(d.json.policy.floor, TYPE_POLICY[type as keyof typeof TYPE_POLICY]);
      assert.ok(d.json.summary.text.length < MAX_SUMMARY_BYTES + 4096);
    }
  });

  test('acknowledgement flow: missing, forged, other-version and non-hex hashes are all 409 and change nothing; the right one passes; self-review is 403', async () => {
    const t = ids.hook, before_ = await snapshot();
    const approve = (as: string, body: unknown) => A(`/versions/${t.versionId}/approve`, { as, method: 'POST', body });
    for (const bad of [{}, { ack_summary_sha256: '' }, { ack_summary_sha256: 'f'.repeat(64) }, { ack_summary_sha256: 'zz' }, { ack_summary_sha256: ids.bridge.summarySha256 }, { ack_summary_sha256: 12 }, { ack_summary_sha256: [t.summarySha256] }, { ack_summary_sha256: t.summarySha256 + 'x' }]) {
      const r = await approve('rev', bad);
      assert.equal(r.status, 409, JSON.stringify(bad)); assert.equal(r.json.code, 'summary_ack_required'); assert.equal(r.json.expectedSummarySha256, t.summarySha256);
    }
    assert.equal(await snapshot(), before_, 'a refused approval changes no row and writes no audit');
    const self = await approve('eng', { ack_summary_sha256: t.summarySha256 });
    assert.equal(self.status, 403); assert.equal(self.json.code, 'separation_of_duties');
    assert.equal(await snapshot(), before_);
    const ok = await approve('rev', { ack_summary_sha256: t.summarySha256.toUpperCase() });
    assert.equal(ok.status, 200, ok.text);
    const ev = await one(`SELECT detail FROM marketplace_release_events WHERE version_id = $1 AND event = 'approved'`, [t.versionId]);
    assert.equal(ev.detail.ackSummarySha256, t.summarySha256);
  });

  test('a stale hash is refused after the manifest changed (the new hash is demanded), and a summary too large to read cannot be approved', async () => {
    const t = ids.bridge;
    // the manifest of a not-yet-published version is editable by the owner role; an ack taken before the edit must not carry over
    await owner.query(`UPDATE marketplace_versions SET manifest = jsonb_set(manifest, '{payload,tools,0,summary}', '"Now also deletes everything"') WHERE id = $1`, [t.versionId]);
    const r = await A(`/versions/${t.versionId}/approve`, { as: 'rev', method: 'POST', body: { ack_summary_sha256: t.summarySha256 } });
    assert.equal(r.status, 409); assert.equal(r.json.code, 'summary_ack_required'); assert.notEqual(r.json.expectedSummarySha256, t.summarySha256);
    const d = await A(`/submissions/${t.versionId}`, { as: 'rev' });
    assert.equal(d.json.summarySha256, r.json.expectedSummarySha256); assert.match(d.json.summary.text, /Now also deletes everything/);
    assert.equal((await one('SELECT state FROM marketplace_versions WHERE id = $1', [t.versionId])).state, 'submitted');
    // too large to show: refused before the hash is even compared
    const c = ids.connector;
    await owner.query(`UPDATE marketplace_versions SET manifest = jsonb_set(manifest, '{payload,fields}', (SELECT jsonb_agg(jsonb_build_object('key','k'||g,'label',repeat('x',300),'secret',false)) FROM generate_series(1,400) g)) WHERE id = $1`, [c.versionId]);
    const det = await A(`/submissions/${c.versionId}`, { as: 'rev' });
    assert.equal(det.json.summary.truncated, true); assert.match(det.json.summary.text, /cannot be approved from here/);
    const ap = await A(`/versions/${c.versionId}/approve`, { as: 'rev', method: 'POST', body: { ack_summary_sha256: det.json.summarySha256 } });
    assert.equal(ap.status, 409); assert.equal(ap.json.code, 'summary_truncated');
    assert.equal((await one('SELECT state FROM marketplace_versions WHERE id = $1', [c.versionId])).state, 'submitted');
  });

  // ---------------------------------------------------------------- authz and probing
  test('every new route: wrong role is 403 with zero rows changed and no audit row; no token is 401; a verifier or support role reads nothing', async () => {
    const before_ = await snapshot();
    const reads = ['/type-policy', '/analytics/advanced', '/security/advanced', `/submissions/${ids.hook.versionId}`];
    for (const as of ['sup', 'ver']) for (const p of reads) { const r = await A(p, { as }); assert.equal(r.status, 403, `${as} ${p}`); assert.equal(r.json.code, 'forbidden'); }
    for (const p of reads) { assert.equal((await A(p)).status, 401, p); assert.ok([401, 403].includes((await A(p, { as: 'nobody' })).status), p); }
    const writes: Array<[string, string, unknown, string[]]> = [
      ['PUT', '/type-policy/template', { manualReview: true, reason: 'x' }, ['eng', 'ana', 'sup', 'ver']],
      ['POST', '/types/hook/halt', { reason: 'x' }, ['eng', 'ana', 'sup', 'ver']],
    ];
    for (const [method, p, body, roles] of writes) for (const as of roles) { const r = await A(p, { as, method, body }); assert.equal(r.status, 403, `${as} ${method} ${p}`); assert.equal(r.json.code, 'forbidden'); }
    for (const [method, p, body] of writes) { assert.equal((await A(p, { method, body })).status, 401); assert.ok([401, 403].includes((await A(p, { as: 'nobody', method, body })).status)); }
    // an unauthorised caller learns nothing about whether a type or version exists: 403 for unknown too
    assert.equal((await A('/types/nonsense/halt', { as: 'eng', method: 'POST', body: { reason: 'x' } })).status, 403);
    assert.equal((await A('/type-policy/nonsense', { as: 'eng', method: 'PUT', body: { reason: 'x' } })).status, 403);
    assert.equal(await snapshot(), before_);
    assert.equal((await A('/type-policy', { as: 'ana' })).status, 200);
  });

  test('probing: unknown or malformed ids and types answer one uniform 404 body; wrong methods and extra path segments do not leak', async () => {
    const bodies = new Set<string>();
    for (const p of ['/submissions/ver_nope', '/submissions/..%2F..%2Fetc', '/submissions/' + 'a'.repeat(300), '/submissions/%00', '/submissions/a%20b']) {
      const r = await A(p, { as: 'ana' }); assert.equal(r.status, 404, p); bodies.add(JSON.stringify({ c: r.json.code }));
    }
    assert.equal(bodies.size, 1);
    for (const [method, p] of [['PUT', '/type-policy/nonsense'], ['POST', '/types/nonsense/halt'], ['PUT', '/type-policy/__proto__'], ['POST', '/types/constructor/halt']] as const) {
      const r = await A(p, { as: 'root', method, body: { reason: 'x', manualReview: true } }); assert.equal(r.status, 404, p); assert.equal(r.json.code, 'not_found');
    }
    assert.equal((await A('/type-policy/hook/extra', { as: 'root', method: 'PUT', body: { reason: 'x' } })).status, 404);
    assert.equal((await A('/types/hook/halt', { as: 'root', method: 'GET' })).status, 404);
    assert.equal((await A('/type-policy', { as: 'root', method: 'DELETE' })).status, 404);
    assert.equal((await A('/analytics/advanced/x', { as: 'ana' })).status, 404);
  });

  test('oversize and malformed bodies: 400/413, nothing changes', async () => {
    const before_ = await snapshot();
    const big = JSON.stringify({ reason: 'x'.repeat(70 * 1024) });
    assert.equal((await A('/types/hook/halt', { as: 'root', method: 'POST', raw: big })).status, 413);
    assert.equal((await A('/type-policy/hook', { as: 'root', method: 'PUT', raw: big })).status, 413);
    for (const raw of ['not json', '[]', '"x"', 'null']) { assert.equal((await A('/types/hook/halt', { as: 'root', method: 'POST', raw })).status, 400, raw); }
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: 'x'.repeat(1001) }, { reason: 'ok', extra: 1 }, { reason: 'ok', __proto__x: 1 }]) assert.equal((await A('/types/hook/halt', { as: 'root', method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(await snapshot(), before_);
  });

  // ---------------------------------------------------------------- catalog filters
  test('catalog: filter by type, riskTier (and the older tier name) and manualReview; every item carries riskTier and manualReview; bad values are 400', async () => {
    await owner.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${'d'.repeat(64)}',1,'k') ON CONFLICT DO NOTHING;
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/skl','skill','acme','u1','private','Skill');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier) VALUES ('v_skl','acme/skl','1.0.0',1,0,0,'published','{}','${'d'.repeat(64)}',1,'clean','declarative')`);
    const list = async (q: string) => { const r = await A(`/catalog?${q}`, { as: 'ana' }); assert.equal(r.status, 200, r.text); return r.json.items as any[]; };
    assert.deepEqual((await list('type=hook')).map((x) => x.type), ['hook']);
    const manual = await list('manualReview=true&limit=100'); const notManual = await list('manualReview=false&limit=100');
    assert.ok(manual.length >= 5 && manual.every((x) => x.manualReview === true)); assert.ok(notManual.some((x) => x.id === 'acme/skl') && notManual.every((x) => x.manualReview === false));
    assert.ok(!notManual.some((x) => ['hook', 'bridge', 'connector', 'memory', 'routine'].includes(x.type)));
    const exec = await list('riskTier=executable&limit=100'); assert.ok(exec.length >= 3 && exec.every((x) => x.riskTier === 'executable'));
    assert.deepEqual((await list('tier=executable&limit=100')).map((x) => x.id).sort(), exec.map((x) => x.id).sort());
    assert.ok((await list('riskTier=declarative&limit=100')).some((x) => x.id === 'acme/skl' || x.type === 'routine'));
    assert.deepEqual((await list('type=bridge&riskTier=executable&manualReview=true')).map((x) => x.type), ['bridge']);
    for (const q of ['riskTier=banana', 'manualReview=maybe', 'type=nonsense', "riskTier='; DROP TABLE x;--"]) assert.equal((await A(`/catalog?${q}`, { as: 'ana' })).status, 400, q);
  });

  // ---------------------------------------------------------------- type policy
  test('type policy: GET lists all 11 with their code floor; a superadmin can raise, never lower below the floor (409, row unchanged); the database refuses it too', async () => {
    const g = await A('/type-policy', { as: 'ana' });
    assert.equal(g.status, 200); assert.equal(g.json.items.length, 11);
    for (const it of g.json.items) { assert.deepEqual(it.floor, TYPE_POLICY[it.type as keyof typeof TYPE_POLICY]); assert.equal(it.raised, false); }
    const put = (body: unknown, type = 'hook') => A(`/type-policy/${type}`, { as: 'root', method: 'PUT', body });
    const before_ = await snapshot();
    for (const body of [{ riskTier: 'declarative', reason: 'x' }, { riskTier: 'data', reason: 'x' }, { manualReview: false, reason: 'x' }, { minPublisherTrust: 'community', reason: 'x' }, { minPublisherTrust: 'private', reason: 'x' }]) {
      const r = await put(body); assert.equal(r.status, 409, JSON.stringify(body)); assert.equal(r.json.code, 'below_floor');
    }
    for (const [body, st] of [[{ reason: 'x' }, 400], [{ manualReview: true }, 400], [{ riskTier: 'extreme', reason: 'x' }, 400], [{ manualReview: 'yes', reason: 'x' }, 400], [{ minPublisherTrust: 'god', reason: 'x' }, 400], [{ nonsense: 1, reason: 'x' }, 400]] as const) assert.equal((await put(body)).status, st, JSON.stringify(body));
    assert.equal(await snapshot(), before_);
    await assert.rejects(() => admin.query(`UPDATE marketplace_type_policy SET manual_review = false WHERE type = 'hook'`), /below its floor/);
    await assert.rejects(() => admin.query(`UPDATE marketplace_type_policy SET risk_tier = 'data' WHERE type = 'hook'`), /below its floor/);
    await assert.rejects(() => admin.query(`UPDATE marketplace_type_policy SET floor_manual_review = false WHERE type = 'template'`), /permission denied/);   // ao_admin may not even write the floor columns
    await assert.rejects(() => owner.query(`UPDATE marketplace_type_policy SET floor_manual_review = false WHERE type = 'hook'`), /floor of hook cannot be changed/);   // and the trigger stops the table owner
    await assert.rejects(() => h.app.query(`UPDATE marketplace_type_policy SET manual_review = false WHERE type = 'template'`), /permission denied/);
    await assert.rejects(() => admin.query(`INSERT INTO marketplace_type_policy(type, risk_tier, manual_review, min_publisher_trust, floor_risk_tier, floor_manual_review, floor_min_publisher_trust) VALUES ('x','data',false,'community','data',false,'community')`), /permission denied/);
  });

  test('raising a policy takes effect (template now needs manual review and the DB guard follows), is audited with before/after and reason, and can be relaxed back to the floor but no further', async () => {
    const put = (body: unknown) => A('/type-policy/template', { as: 'root', method: 'PUT', body });
    const a0 = (await one(`SELECT count(*)::int n FROM admin_audit WHERE action = 'marketplace.set_type_policy'`)).n;
    const r = await put({ manualReview: true, riskTier: 'declarative', minPublisherTrust: 'verified', reason: 'templates were abused' });
    assert.equal(r.status, 200, r.text); assert.deepEqual({ ...r.json, floor: undefined }, { type: 'template', riskTier: 'declarative', manualReview: true, minPublisherTrust: 'verified', floor: undefined });
    const au = await one(`SELECT admin_user_id, detail FROM admin_audit WHERE action = 'marketplace.set_type_policy' ORDER BY id DESC LIMIT 1`);
    assert.equal((await one(`SELECT count(*)::int n FROM admin_audit WHERE action = 'marketplace.set_type_policy'`)).n, a0 + 1);
    assert.equal(au.admin_user_id, 'root'); assert.equal(au.detail.reason, 'templates were abused'); assert.equal(au.detail.before.manualReview, false); assert.equal(au.detail.after.manualReview, true);
    const g = (await A('/type-policy', { as: 'ana' })).json.items.find((x: any) => x.type === 'template');
    assert.equal(g.raised, true); assert.equal(g.updatedBy, 'root');
    assert.ok((await A('/catalog?manualReview=true&type=template&limit=100', { as: 'ana' })).status === 200);
    // the database guard now demands a reviewer approval for a template too
    await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/tpl','template','acme','u1','private','T');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier) VALUES ('v_tpl','acme/tpl','1.0.0',1,0,0,'approved','{}','${'d'.repeat(64)}',1,'clean','data')`);
    await assert.rejects(() => admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = 'v_tpl'`), /manual review/);
    // relax back to the floor
    const back = await put({ manualReview: false, riskTier: 'data', minPublisherTrust: 'community', reason: 'incident closed' });
    assert.equal(back.status, 200, back.text);
    assert.equal((await put({ riskTier: 'data', manualReview: false, minPublisherTrust: 'private', reason: 'x' })).status, 409);
    await admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = 'v_tpl'`);
  });

  // ---------------------------------------------------------------- halt
  test('halt: quarantines every published version of the type only, one event per version, one audit row; installs/sync then reports update_available with reason quarantined', async () => {
    const mk = async (id: string, type: string, state: 'published' | 'deprecated' | 'submitted', n = 1) => {
      await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ($1,$2,'acme','u1','public','L') ON CONFLICT DO NOTHING`, [id, type]);
      const vid = `v_${id.replace('/', '_')}_${n}`;
      await owner.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier) VALUES ($1,$2,$3,$4,0,0,'approved',$5,$6,1,'clean','executable')`,
        [vid, id, `${n}.0.0`, n, JSON.stringify({ id, type }), 'd'.repeat(64)]);
      await owner.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor) VALUES ($1,$2,'submitted','eng'),($1,$2,'approved','rev')`, [id, vid]);
      if (state === 'published' || state === 'deprecated') await owner.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [vid]);
      if (state === 'deprecated') await owner.query(`UPDATE marketplace_versions SET state = 'deprecated' WHERE id = $1`, [vid]);
      if (state === 'submitted') await owner.query(`UPDATE marketplace_versions SET state = 'submitted' WHERE id = $1`, [vid]);
      return vid;
    };
    const w1 = await mk('acme/wf-1', 'workflow', 'published'), w2 = await mk('acme/wf-2', 'workflow', 'deprecated'), w3 = await mk('acme/wf-3', 'workflow', 'submitted'), w1b = await mk('acme/wf-1', 'workflow', 'published', 2);
    const other = await mk('acme/rt-other', 'routine', 'published');
    await owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('ins_h1','u1','d1','acme/wf-1','${w1}','enabled',true)`);
    const a0 = (await one(`SELECT count(*)::int n FROM admin_audit WHERE action = 'marketplace.halt_type'`)).n, e0 = (await one(`SELECT count(*)::int n FROM marketplace_release_events WHERE event = 'quarantined'`)).n;
    const miss = await A('/types/workflow/halt', { as: 'root', method: 'POST', body: {} }); assert.equal(miss.status, 400); assert.equal(miss.json.code, 'reason_required');
    const r = await A('/types/workflow/halt', { as: 'root', method: 'POST', body: { reason: 'workflow runtime CVE' } });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.quarantinedVersions, 3); assert.equal(r.json.listings, 2); assert.equal(r.json.releaseEvents, 3); assert.deepEqual([...r.json.versionIds].sort(), [w1, w1b, w2].sort());
    assert.deepEqual((await rows(`SELECT id, state FROM marketplace_versions WHERE id = ANY($1) ORDER BY id`, [[w1, w1b, w2, w3, other]])).map((x) => `${x.id}:${x.state}`).sort(),
      [`${w1}:quarantined`, `${w1b}:quarantined`, `${w2}:quarantined`, `${w3}:submitted`, `${other}:published`].sort());
    const ev = await rows(`SELECT detail FROM marketplace_release_events WHERE event = 'quarantined' AND version_id = ANY($1)`, [[w1, w1b, w2]]);
    assert.equal(ev.length, 3); assert.ok(ev.every((x) => x.detail.reason === 'workflow runtime CVE' && x.detail.halt === 'workflow'));
    assert.equal((await one(`SELECT count(*)::int n FROM marketplace_release_events WHERE event = 'quarantined'`)).n, e0 + 3);
    assert.equal((await one(`SELECT count(*)::int n FROM admin_audit WHERE action = 'marketplace.halt_type'`)).n, a0 + 1);
    const au = await one(`SELECT admin_user_id, detail FROM admin_audit WHERE action = 'marketplace.halt_type' ORDER BY id DESC LIMIT 1`);
    assert.equal(au.admin_user_id, 'root'); assert.equal(au.detail.versions, 3); assert.equal(au.detail.reason, 'workflow runtime CVE');
    // a device that installed it learns on its next sync
    const sync = await call(pubBase, '/v1/marketplace/installs/sync', { as: 'u1', body: { deviceId: 'd1', items: [{ listingId: 'acme/wf-1', versionId: w1, state: 'enabled', enabled: true }] } });
    assert.equal(sync.status, 200, sync.text);
    const item = (sync.json.updates ?? []).find((x: any) => x.listingId === 'acme/wf-1');
    assert.ok(item, sync.text.slice(0, 400)); assert.equal(item.state, 'update_available'); assert.equal(item.reason, 'quarantined');
    // idempotent: a second halt finds nothing and still audits once
    const again = await A('/types/workflow/halt', { as: 'root', method: 'POST', body: { reason: 'again' } });
    assert.equal(again.json.quarantinedVersions, 0); assert.equal(again.json.releaseEvents, 0);
    assert.equal((await one(`SELECT state FROM marketplace_versions WHERE id = $1`, [w3])).state, 'submitted');
  });

  // ---------------------------------------------------------------- analytics and security
  test('analytics/advanced: numbers equal row counts exactly, every type is present, failed reasons are sanitised, coverage and notCollected are unchanged and honest', async () => {
    await owner.query(`DELETE FROM marketplace_installs; DELETE FROM marketplace_usage_events`);
    const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const ins = async (n: number, user: string, dev: string, listing: string, state: string, enabled: boolean, err: string | null = null) =>
      owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, enabled, last_error) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`ins_a${n}`, user, dev, listing, state, enabled, err]);
    await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/hk-b','hook','acme','u1','public','H'),('acme/hk-c','hook','acme','u1','public','H'),('acme/cn-b','connector','acme','u1','public','C') ON CONFLICT DO NOTHING`);
    await ins(1, 'u1', 'd1', 'acme/hk-b', 'enabled', true); await ins(2, 'u2', 'd2', 'acme/hk-b', 'installed', false); await ins(3, 'u3', 'd3', 'acme/hk-b', 'configured', false);
    await ins(4, 'u1', 'd1', 'acme/hk-c', 'failed', false, `connect to https://evil.example.com:8443/path?token=${GH} failed for usr_abc123 at /Users/bob/.ssh/id_rsa (alice@example.com)`);
    await ins(5, 'u2', 'd2', 'acme/hk-c', 'failed', false, 'connect to https://other.example.org/x failed for usr_zzz999 at /Users/eve/.ssh/id_rsa (bob@example.com)');
    await ins(6, 'u3', 'd3', 'acme/cn-b', 'installed', false); await ins(7, 'u3', 'd4', 'acme/cn-b', 'uninstalled', false);
    await owner.query(`INSERT INTO marketplace_install_events(id, user_id, listing_id, event) VALUES ('ie1','u1','acme/hk-b','uninstalled'),('ie2','u2','acme/hk-b','uninstalled'),('ie3','u3','acme/cn-b','uninstalled'),('ie4','u3','acme/cn-b','installed')`);
    const before_ = await snapshot();
    const r = await A('/analytics/advanced', { as: 'ana' });
    assert.equal(r.status, 200, r.text);
    const T = Object.fromEntries(r.json.byType.map((x: any) => [x.type, x]));
    assert.deepEqual(r.json.byType.map((x: any) => x.type), [...LISTING_TYPES]);
    const sql = async (q: string) => (await one(q)).n;
    const hookRows = { installs: await sql(`SELECT count(*)::int n FROM marketplace_installs i JOIN marketplace_listings l ON l.id=i.listing_id WHERE l.type='hook' AND i.state NOT IN ('requested','permission_review','failed')`),
      failed: await sql(`SELECT count(*)::int n FROM marketplace_installs i JOIN marketplace_listings l ON l.id=i.listing_id WHERE l.type='hook' AND i.state='failed'`),
      active: await sql(`SELECT count(*)::int n FROM marketplace_installs i JOIN marketplace_listings l ON l.id=i.listing_id WHERE l.type='hook' AND i.enabled AND i.state IN ('installed','configured','enabled','disabled','update_available')`),
      awaiting: await sql(`SELECT count(*)::int n FROM marketplace_installs i JOIN marketplace_listings l ON l.id=i.listing_id WHERE l.type='hook' AND i.state='installed'`),
      quarantines: await sql(`SELECT count(*)::int n FROM marketplace_release_events e JOIN marketplace_listings l ON l.id=e.listing_id WHERE l.type='hook' AND e.event='quarantined'`) };
    assert.deepEqual({ installs: T.hook.installs, failed: T.hook.failedInstalls, active: T.hook.activeInstalls, awaiting: T.hook.awaitingConfiguration, quarantines: T.hook.quarantines }, hookRows);
    assert.equal(T.hook.installs, 3); assert.equal(T.hook.failedInstalls, 2); assert.equal(T.hook.activeInstalls, 1); assert.equal(T.hook.liveInstalls, 3); assert.equal(T.hook.uninstalls, 2); assert.equal(T.hook.awaitingConfiguration, 1);
    assert.equal(T.hook.failureRate, 2 / 5); assert.ok(Math.abs(T.hook.awaitingConfigurationRate - 1 / 3) < 1e-9);
    assert.equal(T.connector.installs, 2); assert.equal(T.connector.uninstalls, 1); assert.equal(T.connector.awaitingConfiguration, 1); assert.equal(T.connector.failureRate, 0);
    assert.equal(T.skill.installs, 0); assert.equal(T.skill.failureRate, null); assert.equal(T.skill.awaitingConfigurationRate, null);
    assert.equal(T.workflow.quarantines, 3, 'from the halt test'); assert.equal(T.workflow.revokes, 0);
    assert.equal(T.workflow.versionsByState.quarantined, 3);
    // sanitised: the two different hosts/ids/paths/emails collapse into ONE bucket with the secret gone
    assert.equal(T.hook.failedReasons.length, 1); assert.equal(T.hook.failedReasons[0].count, 2);
    const txt = JSON.stringify(r.json); for (const leak of [GH, 'evil.example.com', 'other.example.org', 'usr_abc123', 'alice@example.com', '/Users/bob', 'id_rsa']) assert.ok(!txt.includes(leak), `leaked ${leak}`);
    assert.match(T.hook.failedReasons[0].reason, /connect to <url> failed for <id> at <path>/);
    assert.deepEqual(r.json.notCollected, ['invocations', 'workflow_completions', 'first_use_activation']);
    const cov = r.json.telemetryCoverage; assert.equal(cov.devicesKnown, 4); assert.equal(cov.devicesReporting, 4, 'distinct devices that have any install row'); assert.ok(cov.ratio <= 1);
    assert.ok(!/user|email/i.test(Object.keys(r.json.byType[0]).join(',')), 'no per-user fields');
    assert.equal((await rows('SELECT id, state FROM marketplace_versions ORDER BY id')).length > 0, true);
    assert.equal(JSON.parse(await snapshot()).v.length, JSON.parse(before_).v.length, 'a read changes no version');
  });

  test('analytics/advanced: from/to limit event counts; bad dates are 400', async () => {
    const all = (await A('/analytics/advanced', { as: 'ana' })).json.byType.find((x: any) => x.type === 'hook');
    const none = (await A('/analytics/advanced?from=2000-01-01&to=2000-01-02', { as: 'ana' })).json.byType.find((x: any) => x.type === 'hook');
    assert.equal(none.installs, 0); assert.equal(none.failedInstalls, 0); assert.equal(none.uninstalls, 0); assert.equal(none.activeInstalls, all.activeInstalls, 'snapshots are not range-limited');
    for (const q of ['from=2026-13-01', 'from=yesterday', 'from=2026-02-02&to=2026-01-01']) assert.equal((await A(`/analytics/advanced?${q}`, { as: 'ana' })).status, 400, q);
  });

  test('security/advanced: quarantined and revoked versions of risky types with reason and actor, executable published versions, counts, caps; read only', async () => {
    // one revoked executable bridge
    const t = ids.hook;
    await A(`/versions/${t.versionId}/publish`, { as: 'rev', method: 'POST', body: {} });
    const rv = await A(`/versions/${t.versionId}/revoke`, { as: 'root', method: 'POST', body: { reason: 'exfiltrates documents' } });
    assert.equal(rv.status, 200, rv.text);
    await owner.query(`INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, reason, details, state) VALUES ('rep1','acme/wf-1','u2','malware','x','open')`);
    const before_ = await snapshot();
    const r = await A('/security/advanced', { as: 'ana' });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.json.types.includes('template') && !r.json.types.includes('skill'));
    assert.equal(r.json.quarantined.length, 3); assert.ok(r.json.quarantined.every((x: any) => x.type === 'workflow' && x.reason === 'workflow runtime CVE' && x.by === 'root'));
    assert.equal(r.json.quarantined.find((x: any) => x.listingId === 'acme/wf-1' && x.liveInstalls >= 0).openReports, 1);
    const rev = r.json.revoked.find((x: any) => x.versionId === t.versionId); assert.ok(rev); assert.equal(rev.reason, 'exfiltrates documents'); assert.equal(rev.type, 'hook');
    assert.ok(r.json.highTierPublished.every((x: any) => x.riskTier === 'executable' && ['published', 'deprecated'].includes(x.state)));
    assert.ok(r.json.counts.some((c: any) => c.type === 'workflow' && c.state === 'quarantined' && c.n === 3));
    assert.ok(!JSON.stringify(r.json).includes('u1@example.test'));
    assert.equal(await snapshot(), before_.replace(/"a":\d+/, `"a":${(await one('SELECT count(*)::int n FROM admin_audit')).n}`));
  });

  test('every mutation writes exactly one audit row naming the admin; reads write one too; denied requests write none', async () => {
    const acts = await rows(`SELECT action, count(*)::int n FROM admin_audit GROUP BY action`);
    const n = (a: string) => acts.find((x) => x.action === a)?.n ?? 0;
    assert.equal(n('marketplace.set_type_policy'), 2); assert.equal(n('marketplace.halt_type'), 2);
    assert.ok(n('marketplace.view_type_policy') >= 2 && n('marketplace.view_analytics_advanced') >= 2 && n('marketplace.view_security_advanced') >= 1 && n('marketplace.view_submission') >= 5);
    assert.equal((await one(`SELECT count(*)::int n FROM admin_audit WHERE admin_user_id IN ('eng','sup','ver','nobody') AND action IN ('marketplace.halt_type','marketplace.set_type_policy')`)).n, 0);
  });
});
