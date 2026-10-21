// Plan 4 Task 2: the verification store, its API and the approval gate, against a REAL Postgres (embedded-postgres, real roles, RLS on).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import type { AdminRole } from '../src/marketplace/permissions.ts';
import { getPipeline, registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';
import { normaliseResult } from '../src/marketplace/verifyStore.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const PPTX = new Uint8Array(readFileSync(new URL('./fixtures/marketplace/board-update.pptx', import.meta.url)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TOK: Record<string, [string, AdminRole]> = { root: ['r'.repeat(30), 'superadmin'], eng: ['e'.repeat(30), 'engineer'], ana: ['a'.repeat(30), 'analyst'] };
const tokens = parseTokens(Object.entries(TOK).map(([k, [t]]) => `${k}:${t}`).join(','));
const H = (c: string) => c.repeat(64);

function templateZip(id: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'template.pptx': PPTX, 'previews/1.png': PNG };
  const manifest = {
    schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: 'Deck', summary: 'A deck.', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { format: 'pptx', file: 'template.pptx', previews: ['previews/1.png'] },
  };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
const stage = (o: Record<string, unknown> = {}) => ({ id: 'manifest', title: 'Manifest', required: true, status: 'pass', evidence: [], durationMs: 5, ...o });
const result = (sha: string, o: Record<string, unknown> = {}) => ({
  type: 'template', pipeline: 'template-basic', pipelineVersion: 1, subjectSha256: sha, verdict: 'pass', stages: [stage()], env: { officecli: '1.0' },
  startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:00:01.000Z', ...o,
});
const failing = (sha: string, n = 'x') => result(sha, { verdict: 'fail', finishedAt: `2026-10-21T10:00:0${n.length}.000Z`, stages: [stage({ status: 'fail', reason: 'bad ooxml ' + n })] });
const incomplete = (sha: string) => result(sha, { verdict: 'incomplete', stages: [stage(), stage({ id: 'render', title: 'Render', status: 'skipped', reason: 'tool-missing:officecli' })] });

describe('normaliseResult (no database)', () => {
  const ok = result(H('a'));
  test('accepts a well-formed result and recomputes nothing it did not check', () => {
    const n = normaliseResult(ok);
    assert.equal(n.result.verdict, 'pass'); assert.match(n.resultSha256, /^[0-9a-f]{64}$/);
  });
  test('refuses: unknown fields, score keys, forged verdict, missing reason, bad ids, duplicate stages, future time, huge env', () => {
    const bad = (x: unknown, re: RegExp) => assert.throws(() => normaliseResult(x), re);
    bad({ ...ok, extra: 1 }, /unknown field/);
    bad({ ...ok, stages: [stage({ evidence: [{ kind: 'check', label: 'x', measured: { name: 'a', value: 1, threshold: 1, op: '>=', score: 9 } }] })] }, /score|unknown field/);
    bad(result(H('a'), { stages: [stage({ status: 'fail', reason: 'r' })] }), /does not match the stages/);   // says pass, stage failed
    bad({ ...ok, stages: [stage({ status: 'skipped' })], verdict: 'incomplete' }, /needs a reason/);
    bad({ ...ok, stages: [stage({ id: 'Bad Id' })] }, /kebab/);
    bad({ ...ok, stages: [stage(), stage()] }, /duplicate/);
    bad({ ...ok, finishedAt: '2999-01-01T00:00:00.000Z' }, /future/);
    bad({ ...ok, finishedAt: '2026-10-21T09:00:00.000Z' }, /before startedAt/);
    bad({ ...ok, env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])) }, /env/);
    bad({ ...ok, subjectSha256: '../etc/passwd' }, /64/);
  });
  test('size caps: detail over 2 KiB, 51 evidence items, 41 blobs, oversized blob, total result over 256 KiB', () => {
    const ev = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, () => ({ kind: 'text', label: 'l', ...extra }));
    assert.throws(() => normaliseResult({ ...ok, stages: [stage({ evidence: ev(1, { detail: 'x'.repeat(2049) }) })] }), /detail/);
    assert.throws(() => normaliseResult({ ...ok, stages: [stage({ evidence: ev(51) })] }), /at most 50/);
    const blob = (i: number) => ({ kind: 'image', label: 'p', blob: { sha256: i.toString(16).padStart(64, '0'), mime: 'image/png', size: 1 } });
    assert.throws(() => normaliseResult({ ...ok, stages: [stage({ evidence: Array.from({ length: 41 }, (_, i) => blob(i)).slice(0, 41) })] }), /at most 50|more than 40/);
    assert.throws(() => normaliseResult({ ...ok, stages: [stage({ evidence: [{ kind: 'image', label: 'p', blob: { sha256: H('1'), mime: 'image/png', size: 3 * 1024 * 1024 } }] })] }), /size/);
    assert.throws(() => normaliseResult({ ...ok, stages: [stage({ evidence: [{ kind: 'image', label: 'p', blob: { sha256: H('1'), mime: 'text/html', size: 1 } }] })] }), /mime/);
    const many = Array.from({ length: 64 }, (_, i) => stage({ id: `s${i}`, evidence: ev(50, { detail: 'y'.repeat(2000) }) }));
    assert.throws(() => normaliseResult({ ...ok, stages: many }), (e: any) => e.status === 413);
  });
});

describe('verification store, API and approval gate (real Postgres)', { skip }, () => {
  let h: MarketplacePg, api: Server, pub: Server, base = '', pubBase = '';
  const store = memoryArtifactStore();
  let pipelineRegistered = false;

  const call = async (path: string, o: { as?: string; method?: string; body?: unknown; raw?: string; zip?: Uint8Array; origin?: string; bearer?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOK[o.as][0]}`; else if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; }
    else if (o.raw !== undefined) { headers['content-type'] = 'application/json'; body = o.raw; }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch((o.origin ?? base) + path, { method: o.method ?? (o.zip || body !== undefined ? 'POST' : 'GET'), headers, body } as RequestInit);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let json: any; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* not json */ }
    return { status: r.status, json, bytes, headers: r.headers };
  };
  const mkVersion = async (id: string) => {
    const zip = templateZip(id), r = await call('/admin/marketplace/submissions', { as: 'root', zip });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { vid: r.json.versionId as string, lid: id, sha: sha256Hex(zip) };
  };
  const record = (vid: string, body: unknown, as = 'eng') => call(`/admin/marketplace/versions/${vid}/verification`, { as, body });
  const act = (vid: string, action: string, body: unknown = {}, as = 'root') => call(`/admin/marketplace/versions/${vid}/${action}`, { as, body });
  const rows = async (vid: string) => Number((await h.owner.query('SELECT count(*) AS n FROM marketplace_verifications WHERE version_id = $1', [vid])).rows[0].n);
  const setRequired = (types: string[]) => h.owner.query('UPDATE marketplace_settings SET verification_required_types = $1', [types]);

  before(async () => {
    h = await startMarketplacePg();
    const adminPool = h.pool('ao_admin');
    const deps = { tokens } as unknown as AdminDeps;
    const handler = marketplaceAdminHandler({ admin: adminPool, authenticate: (req) => authenticate(req, deps), roleOf: (id) => TOK[id][1], store });
    api = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    const ph = marketplaceHandler({
      app: h.pool('ao_app'), store,
      authenticate: async (req) => { const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]; if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.'); return { uid: t }; },
    });
    pub = createServer(async (req, res) => { if (!(await ph(req, res))) res.writeHead(404).end(); });
    await Promise.all([api, pub].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    base = url(api); pubBase = url(pub);
    await h.owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'),('u2','u2@example.test')`);
    if (!getPipeline('template')) {
      registerPipeline({ type: 'template', name: 'template-basic', version: 1, stages: [{ id: 'manifest', title: 'Manifest', required: true, timeoutMs: 1000, run: async () => ({ status: 'pass', evidence: [] }) }] });
      pipelineRegistered = true;
    }
  });
  after(async () => { if (pipelineRegistered) unregisterPipelineForTest('template'); api?.close(); pub?.close(); if (h) await h.stop(); });

  test('record: stored once (an identical replay is the same row), audited, and an analyst or ao_app cannot write', async () => {
    const { vid, sha } = await mkVersion('acme/rec');
    assert.equal((await record(vid, result(sha), 'ana')).status, 403);
    const a = await record(vid, result(sha));
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.duplicate, false); assert.equal(a.json.verdict, 'pass');
    const b = await record(vid, result(sha));
    assert.equal(b.json.duplicate, true); assert.equal(b.json.verificationId, a.json.verificationId);
    assert.equal(await rows(vid), 1);
    const au = (await h.owner.query(`SELECT admin_user_id FROM admin_audit WHERE action = 'marketplace.verification_record' AND detail->>'versionId' = $1`, [vid])).rows;
    assert.equal(au.length, 1);
    // forged results from the application role: no grant, no policy
    await assert.rejects(h.asUser('u1', () => h.app.query(
      `INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
       VALUES ('forged', $1, $2, 'p', 1, 'pass', '[]', $3, now(), now(), 'u1')`, [vid, sha, H('9')])), /permission denied|row-level security/);
  });

  test('a result for another artifact sha, another type, or with a forged verdict is refused and nothing is stored', async () => {
    const { vid, sha } = await mkVersion('acme/swap');
    for (const [body, status, code] of [
      [result(H('f')), 409, 'sha_mismatch'],
      [{ ...result(sha), type: 'skill' }, 409, 'type_mismatch'],
      [result(sha, { stages: [stage({ status: 'fail', reason: 'r' })] }), 400, 'bad_request'],   // verdict says pass
      [{ ...result(sha), score: 0.99 }, 400, 'bad_request'],
    ] as const) {
      const r = await record(vid, body);
      assert.equal(r.status, status, JSON.stringify(r.json)); assert.equal(r.json.code, code);
    }
    assert.equal(await rows(vid), 0);
    // DB swap guard, bypassing the API
    await assert.rejects(h.owner.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
      VALUES ('swap1', $1, $2, 'p', 1, 'pass', '[]', $3, now(), now(), 'x')`, [vid, H('f'), H('8')]), /carries/);
  });

  test('append-only: update and delete are refused, but removing the version cascades', async () => {
    const { vid, sha } = await mkVersion('acme/append');
    const id = (await record(vid, result(sha))).json.verificationId;
    await assert.rejects(h.owner.query(`UPDATE marketplace_verifications SET verdict = 'fail' WHERE id = $1`, [id]), /append-only/);
    await assert.rejects(h.owner.query(`DELETE FROM marketplace_verifications WHERE id = $1`, [id]), /append-only/);
    await assert.rejects(h.admin.query(`UPDATE marketplace_verifications SET verdict = 'fail' WHERE id = $1`, [id]), /permission denied/);
    // a creator rollback deletes the VERSION; its results go with it (a version with no release events, as a rolled-back upload has)
    const o = h.owner;
    await o.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,1,'k-casc')`, [H('d')]);
    await o.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('acme/casc','template','acme','u1','private','T')`);
    await o.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES ('vcasc','acme/casc','1.0.0',1,0,0,'draft','{}',$1,1)`, [H('d')]);
    await o.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
      VALUES ('vc1','vcasc',$1,'p',1,'pass','[]',$2,now(),now(),'x')`, [H('d'), H('7')]);
    await o.query(`DELETE FROM marketplace_versions WHERE id = 'vcasc'`);
    assert.equal(await rows('vcasc'), 0);
  });

  test('hostile bodies: oversized, unknown fields, path tricks in evidence, evidence that is really a package, missing or lying blobs', async () => {
    const { vid, sha } = await mkVersion('acme/hostile');
    assert.equal((await record(vid, null, 'eng')).status, 400);
    const huge = await call(`/admin/marketplace/versions/${vid}/verification`, { as: 'eng', raw: JSON.stringify(result(sha, { env: { pad: 'x'.repeat(300 * 1024) } })) });
    assert.equal(huge.status, 413);
    const withBlob = (blob: unknown) => result(sha, { stages: [stage({ evidence: [{ kind: 'image', label: 'p', blob }] })] });
    assert.equal((await record(vid, withBlob({ sha256: '../../etc/passwd', mime: 'image/png', size: 1 }))).status, 400);
    assert.equal((await record(vid, withBlob({ sha256: H('c'), mime: 'image/png', size: 1, path: '/etc/passwd' }))).status, 400);
    assert.equal((await record(vid, withBlob({ sha256: H('c'), mime: 'image/png', size: 1 }))).json.code, 'bad_request');   // not in the store
    const real = strToU8('hello evidence'), rsha = sha256Hex(real);
    await store.put(rsha, real);
    assert.equal((await record(vid, withBlob({ sha256: rsha, mime: 'text/plain', size: real.length + 5 }))).status, 400);   // lies about its size
    assert.equal((await record(vid, withBlob({ sha256: sha, mime: 'image/png', size: 1 }))).status, 400);                   // the package itself is not evidence
    assert.equal(await rows(vid), 0);
    const good = await record(vid, withBlob({ sha256: rsha, mime: 'text/plain', size: real.length }));
    assert.equal(good.status, 200, JSON.stringify(good.json));
  });

  test('approval gate: missing, failed, incomplete (with and without an acknowledgement) and pass; direct SQL cannot skip it', async () => {
    await setRequired(['template']);
    try {
      const { vid, sha, lid } = await mkVersion('acme/gate');
      let r = await act(vid, 'approve');
      assert.equal(r.status, 409); assert.equal(r.json.code, 'verification_required');
      await assert.rejects(h.owner.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [vid]), /no verification/);   // backstop

      assert.equal((await record(vid, failing(sha))).status, 200);
      r = await act(vid, 'approve');
      assert.equal(r.status, 409); assert.equal(r.json.code, 'verification_failed'); assert.deepEqual(r.json.failedStages, ['manifest']);
      await assert.rejects(h.owner.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [vid]), /verification is fail/);
      assert.equal((await act(vid, 'approve', { acknowledgeIncomplete: 'please' })).json.code, 'verification_failed');   // an ack never overrides a fail

      assert.equal((await record(vid, incomplete(sha))).status, 200);
      r = await act(vid, 'approve');
      assert.equal(r.status, 409); assert.equal(r.json.code, 'verification_incomplete'); assert.equal(r.json.skippedStages[0].id, 'render');
      await assert.rejects(h.owner.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [vid]), /verification is incomplete/);
      assert.equal((await act(vid, 'approve', { acknowledgeIncomplete: '' })).status, 400);
      assert.equal((await act(vid, 'approve', { acknowledgeIncomplete: 'x'.repeat(501) })).status, 400);
      r = await act(vid, 'approve', { acknowledgeIncomplete: 'officecli not installed on this host; reviewed the deck by hand' });
      assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.state, 'approved');
      const ack = (await h.owner.query(`SELECT admin_user_id, detail FROM admin_audit WHERE action = 'marketplace.approve_incomplete' AND detail->>'versionId' = $1`, [vid])).rows;
      assert.equal(ack.length, 1); assert.equal(ack[0].admin_user_id, 'root'); assert.match(ack[0].detail.acknowledgement, /reviewed the deck/);

      // a NEWER failing result after approval blocks publication (the ack named the earlier verification)
      assert.equal((await record(vid, failing(sha, 'late'))).status, 200);
      r = await act(vid, 'publish'); assert.equal(r.json.code, 'verification_failed');
      assert.equal((await record(vid, result(sha, { finishedAt: '2026-10-21T10:00:09.000Z' }))).status, 200);
      r = await act(vid, 'publish'); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.state, 'published');
      assert.equal(lid, 'acme/gate');
    } finally { await setRequired([]); }
  });

  test('the gate follows the artifact: a result for sha A does not approve a version that now carries sha B; unlisted types are not gated', async () => {
    await setRequired(['template']);
    try {
      const { vid, sha } = await mkVersion('acme/follow');
      assert.equal((await record(vid, result(sha))).status, 200);
      const other = templateZip('acme/follow-b'), osha = sha256Hex(other);
      await h.owner.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1, 1, 'k-follow')`, [osha]);
      await h.owner.query(`UPDATE marketplace_versions SET sha256 = $2 WHERE id = $1`, [vid, osha]);
      assert.equal((await act(vid, 'approve')).json.code, 'verification_required');
      assert.equal((await call(`/v1/marketplace/versions/${vid}/verification`, { origin: pubBase })).status, 404);   // the join hides a result for the old bytes
      await setRequired(['skill']);
      assert.equal((await act(vid, 'approve')).status, 200);   // template is not in the list: not gated
    } finally { await setRequired([]); }
  });

  test('admin verify runs the registered pipeline on the stored bytes; analyst 403; read returns latest + history', async () => {
    const { vid, sha } = await mkVersion('acme/run');
    assert.equal((await call(`/admin/marketplace/versions/${vid}/verify`, { as: 'ana', method: 'POST' })).status, 403);
    const r = await call(`/admin/marketplace/versions/${vid}/verify`, { as: 'eng', method: 'POST' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.verdict, 'pass');
    assert.equal((await call('/admin/marketplace/versions/nope/verify', { as: 'eng', method: 'POST' })).status, 404);
    const g = await call(`/admin/marketplace/versions/${vid}/verification`, { as: 'ana' });
    assert.equal(g.status, 200); assert.equal(g.json.verification.artifactSha256, sha); assert.equal(g.json.history.length, 1);
    assert.equal(JSON.stringify(g.json).match(/"(score|confidence|grade|rating|percent)"/), null);
  });

  test('public read: same visibility as the version, one uniform 404, stale flag, evidence only if referenced by a visible row', async () => {
    const { vid, sha, lid } = await mkVersion('acme/pub');
    const ev = strToU8('stage output <script>alert(1)</script>'), esha = sha256Hex(ev);
    await store.put(esha, ev);
    const other = strToU8('unreferenced'), osha = sha256Hex(other);
    await store.put(osha, other);
    const body = result(sha, { stages: [stage({ evidence: [{ kind: 'log', label: 'out', blob: { sha256: esha, mime: 'text/plain', size: ev.length } }] })] });
    assert.equal((await record(vid, body)).status, 200);
    const url = `/v1/marketplace/versions/${vid}/verification`;
    // submitted + private listing owned by the system user: invisible to anonymous and to u1; the code is the same as for an id that does not exist
    const nobody = await call('/v1/marketplace/versions/does-not-exist/verification', { origin: pubBase });
    for (const who of [undefined, 'u1', 'u2']) {
      const r = await call(url, { origin: pubBase, bearer: who });
      assert.equal(r.status, 404, `${who}`); assert.deepEqual(r.json, nobody.json);
      assert.equal((await call(`${url}/evidence/${esha}`, { origin: pubBase, bearer: who })).status, 404);
    }
    await h.owner.query(`UPDATE marketplace_listings SET visibility = 'public' WHERE id = $1`, [lid]);
    await h.owner.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [vid]);
    const r = await call(url, { origin: pubBase });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.verdict, 'pass'); assert.equal(r.json.verified, true); assert.equal(r.json.artifactSha256, sha); assert.equal(r.json.stale, false);
    assert.equal(r.json.stages[0].evidence[0].blobUrl, `${url}/evidence/${esha}`);
    assert.equal(JSON.stringify(r.json).match(/"(score|confidence|grade|rating|percent)"/), null);
    const e = await call(`${url}/evidence/${esha}`, { origin: pubBase });
    assert.equal(e.status, 200); assert.equal(new TextDecoder().decode(e.bytes), new TextDecoder().decode(ev));
    assert.equal(e.headers.get('content-type'), 'text/plain'); assert.equal(e.headers.get('x-content-type-options'), 'nosniff'); assert.equal(e.headers.get('content-disposition'), 'attachment');
    for (const bad of [osha, sha, H('0'), '..%2f..%2fetc%2fpasswd', `${esha}%00`, esha.toUpperCase()]) assert.equal((await call(`${url}/evidence/${bad}`, { origin: pubBase })).status, 404, bad);
    assert.equal((await call(`/v1/marketplace/versions/${vid}/verification/evidence`, { origin: pubBase })).status, 404);
    // stale once a newer pipeline for the type is registered
    const def = getPipeline('template')!;
    unregisterPipelineForTest('template');
    registerPipeline({ ...def, version: def.version + 1 });
    try { assert.equal((await call(url, { origin: pubBase })).json.stale, true); }
    finally { unregisterPipelineForTest('template'); registerPipeline(def); }
  });
});
