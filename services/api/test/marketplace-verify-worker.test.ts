// Plan 4 Task 5: the out-of-process verifier worker. Part 1 attacks the sandbox with hostile children (no database).
// Part 2 drives the job queue, the worker protocol and the worker itself against a REAL Postgres (embedded-postgres, real roles).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import type { AdminRole } from '../src/marketplace/permissions.ts';
import { runSandboxed, type SandboxOptions } from '../src/marketplace/verify/worker/sandbox.ts';
import { VerifyWorker, type WorkerOptions } from '../src/marketplace/verify/worker/worker.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const STUB = here('./fixtures/verify-worker/child-stub.mjs');
const REGISTER = here('./fixtures/verify-worker/register-pipeline.mjs');
const CHILD_TS = here('../src/marketplace/verify/worker/child.ts');
const PPTX = new Uint8Array(readFileSync(here('./fixtures/marketplace/board-update.pptx')));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const H = (c: string) => c.repeat(64);
const SECRET = 'WORKER-SERVICE-CREDENTIAL-0123456789abcdef';
const pgrep = (pattern: string): number[] => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
const leftoverWorkdirs = (root: string) => readdirSync(root).filter((n) => n.startsWith('verify-job-'));

const sbox = (mode: string, o: Partial<SandboxOptions> & { env?: Record<string, string> } = {}) => runSandboxed({
  command: process.execPath, args: [STUB], timeoutMs: 15_000, maxStdoutBytes: 1024 * 1024, ...o,
  env: { HOSTILE: mode, VERIFY_JOB_SHA: H('a'), VERIFY_JOB_TYPE: 'template', ...(o.env ?? {}) },
});

describe('sandbox: a hostile job is contained and always yields an outcome', () => {
  const root = mkdtempSync(join(tmpdir(), 'vw-root-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('a benign child passes and its throwaway directory is deleted', async () => {
    const r = await sbox('ok', { workRoot: root });
    assert.equal(r.ok, true, r.stderrTail);
    assert.equal(JSON.parse(r.stdout.toString()).result.verdict, 'pass');
    assert.deepEqual(leftoverWorkdirs(root), []);
  });
  test('a hang is killed at the wall-clock limit', async () => {
    const t0 = Date.now(), r = await sbox('hang', { workRoot: root, timeoutMs: 1200 });
    assert.equal(r.reason, 'timeout'); assert.ok(Date.now() - t0 < 8000);
    assert.deepEqual(leftoverWorkdirs(root), []);
  });
  test('CPU burn is stopped (ulimit -t or the wall clock, whichever fires first)', async () => {
    const r = await sbox('spin', { workRoot: root, cpuSeconds: 1, timeoutMs: 20_000 });
    assert.equal(r.ok, false); assert.ok(['signal', 'timeout', 'exit'].includes(r.reason!), String(r.reason));
    assert.ok(r.durationMs < 15_000);
  });
  test('memory growth is killed by the RSS cap', async () => {
    const r = await sbox('alloc', { workRoot: root, maxRssBytes: 300 * 1024 * 1024, timeoutMs: 30_000 });
    assert.equal(r.reason, 'memory'); assert.ok(r.peakRssBytes >= 300 * 1024 * 1024);
  });
  test('printing megabytes is cut at the stdout cap, memory use stays bounded', async () => {
    const r = await sbox('megabytes', { workRoot: root, maxStdoutBytes: 256 * 1024 });
    assert.equal(r.reason, 'output-cap'); assert.ok(r.stdout.length <= 256 * 1024);
  });
  test('a non-zero exit is reported with a bounded stderr tail', async () => {
    const r = await sbox('exit3', { workRoot: root });
    assert.equal(r.reason, 'exit'); assert.equal(r.exitCode, 3); assert.match(r.stderrTail, /boom/);
  });
  test('detached grandchildren left behind are killed with the group (no orphans)', async () => {
    const mark = `4242.${Date.now() % 100000}`;
    const r = await sbox('spawn-orphans', { workRoot: root, env: { ORPHAN_MARK: mark } });
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual(pgrep(`sleep ${mark}`), [], 'orphaned sleep processes survived the job');
  });
  test('the environment is scrubbed: the parent credential is invisible to the job', async () => {
    process.env.AO_VERIFY_TOKEN = SECRET; process.env.DATABASE_URL = 'postgres://x:y@z/db';
    try {
      const r = await sbox('env-dump', { workRoot: root });
      const text = r.stdout.toString();
      assert.ok(!text.includes(SECRET) && !text.includes('postgres://'));
      const env = JSON.parse(JSON.parse(text).result.stages[0].evidence[0].detail);
      assert.deepEqual(Object.keys(env).filter((k) => !k.startsWith('__CF') && !k.startsWith('HOSTILE') && !k.startsWith('VERIFY_') && k !== 'PWD' && k !== 'SHLVL' && k !== '_').sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    } finally { delete process.env.AO_VERIFY_TOKEN; delete process.env.DATABASE_URL; }
  });
  const darwin = { skip: process.platform !== 'darwin' ? 'macOS sandbox-exec profile (documented, not verified on this OS)' : false };
  test('writes outside the working directory are denied (macOS write jail)', darwin, async () => {
    const outside = join(root, 'outside.txt');
    const r = await sbox('write-outside', { workRoot: join(root, 'jobs'), env: { OUTSIDE_FILE: outside } });
    assert.equal(r.containment.writes, 'jailed');
    assert.equal(JSON.parse(r.stdout.toString()).wrote, false); assert.equal(existsSync(outside), false);
  });
  test('the network is denied, even loopback (macOS sandbox-exec)', darwin, async () => {
    const srv = net.createServer((s) => s.end()); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const open = await sbox('net', { workRoot: root, denyNetwork: false, env: { NET_PORT: String((srv.address() as AddressInfo).port) } });
      assert.equal(JSON.parse(open.stdout.toString()).verdict, 'connected', 'control: the connection works when not denied');
      const r = await sbox('net', { workRoot: root, env: { NET_PORT: String((srv.address() as AddressInfo).port) } });
      assert.equal(r.containment.network, 'denied'); assert.equal(JSON.parse(r.stdout.toString()).verdict, 'denied');
    } finally { srv.close(); }
  });
  test('credential directories can be hidden from the job (macOS)', darwin, async () => {
    const dir = join(root, 'fake-ssh'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'id'), 'PRIVATE KEY');
    const r = await sbox('readsecret', { workRoot: root, denyReadPaths: [dir], env: { PROBE_FILE: join(dir, 'id') } });
    assert.equal(JSON.parse(r.stdout.toString()).visible, false);
    const c = await sbox('readsecret', { workRoot: root, denyReadPaths: [], env: { PROBE_FILE: join(dir, 'id') } });
    assert.equal(JSON.parse(c.stdout.toString()).visible, true, 'control');
  });
  test('optional fork denial stops a job spawning processes (macOS)', darwin, async () => {
    const r = await sbox('fork', { workRoot: root, denyFork: true });
    assert.equal(JSON.parse(r.stdout.toString()).spawned, false);
    const c = await sbox('fork', { workRoot: root });
    assert.equal(JSON.parse(c.stdout.toString()).spawned, true, 'control');
  });
  test('requireSandbox refuses when containment cannot be applied, instead of running uncontained', async () => {
    const r = await sbox('ok', { workRoot: root, requireSandbox: true, denyNetwork: true, jailWrites: true });
    if (r.containment.network === 'denied' && r.containment.writes === 'jailed') assert.equal(r.ok, true);
    else assert.equal(r.reason, 'sandbox-unavailable');
  });
});

// ──────────────────────────────────────────────────────────────────────────── queue + worker against a real Postgres
const TOK: Record<string, [string, AdminRole]> = {
  root: ['r'.repeat(30), 'superadmin'], eng: ['e'.repeat(30), 'engineer'], ana: ['a'.repeat(30), 'analyst'],
  eng2: ['f'.repeat(30), 'engineer'], eng3: ['g'.repeat(30), 'engineer'], eng4: ['h'.repeat(30), 'engineer'], eng5: ['i'.repeat(30), 'engineer'],
  wrk: [SECRET, 'verifier'], wrk2: ['w2'.repeat(15), 'verifier'],
};
const tokens = parseTokens(Object.entries(TOK).map(([k, [t]]) => `${k}:${t}`).join(','));

function templateZip(id: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'template.pptx': PPTX, 'previews/1.png': PNG };
  const manifest = {
    schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: 'Deck', summary: 'A deck.', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { format: 'pptx', file: 'template.pptx', previews: ['previews/1.png'] },
  };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}

describe('verify job queue, worker protocol and worker (real Postgres)', { skip }, () => {
  let h: MarketplacePg, api: Server, base = '';
  const store = memoryArtifactStore();
  const logs: string[] = [];
  const jobsRoot = mkdtempSync(join(tmpdir(), 'vw-jobs-'));

  const call = async (path: string, o: { as?: string; method?: string; body?: unknown; lease?: string; raw?: Uint8Array; mime?: string; zip?: Uint8Array } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOK[o.as][0]}`;
    if (o.lease) headers['x-lease-token'] = o.lease;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; }
    else if (o.raw) { headers['content-type'] = o.mime ?? 'text/plain'; body = o.raw; }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(base + path, { method: o.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body } as RequestInit);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let json: any; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* binary */ }
    return { status: r.status, json, bytes };
  };
  let n = 0;
  const mkVersion = async () => {
    const id = `acme/job${++n}`, zip = templateZip(id), r = await call('/admin/marketplace/submissions', { as: 'root', zip });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return { vid: r.json.versionId as string, sha: sha256Hex(zip), zip };
  };
  // the API rate-limits runs per admin (6/minute), so the many enqueues of this file are spread over several engineers
  let rr = 0;
  const enqueue = (vid: string, as?: string) => call(`/admin/marketplace/versions/${vid}/verify`, { as: as ?? ['eng', 'eng2', 'eng3', 'eng4', 'eng5'][rr++ % 5], body: {} });
  const claim = (as = 'wrk', worker = 'w-test', leaseSec = 30) => call('/admin/marketplace/verify-jobs/claim', { as, body: { worker, leaseSec } });
  const jobRow = async (id: string) => (await h.owner.query('SELECT * FROM marketplace_verify_jobs WHERE id = $1', [id])).rows[0];
  const verifs = async (vid: string) => (await h.owner.query('SELECT * FROM marketplace_verifications WHERE version_id = $1 ORDER BY seq', [vid])).rows;
  const expire = (id: string) => h.owner.query(`UPDATE marketplace_verify_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
  const okResult = (sha: string, o: Record<string, unknown> = {}) => ({
    type: 'template', pipeline: 'template-basic', pipelineVersion: 1, subjectSha256: sha, verdict: 'pass', stages: [{ id: 'manifest', title: 'Manifest', required: true, status: 'pass', evidence: [], durationMs: 5 }],
    env: {}, startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), ...o,
  });
  const worker = (hostile: string | null, extra: Partial<WorkerOptions> = {}) => new VerifyWorker({
    apiBase: base, token: TOK.wrk[0], workerId: `w-${hostile ?? 'real'}`, leaseSec: 30, log: (l) => logs.push(l),
    child: hostile ? { command: process.execPath, args: [STUB], env: { HOSTILE: hostile } }
      : { command: process.execPath, args: ['--max-old-space-size=512', CHILD_TS], env: { VERIFY_MODULES: REGISTER } },
    sandbox: { timeoutMs: 20_000, workRoot: jobsRoot, maxRssBytes: 1024 * 1024 * 1024 }, ...extra,
  });

  before(async () => {
    h = await startMarketplacePg();
    const deps = { tokens } as unknown as AdminDeps;
    const handler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, deps), roleOf: (id) => TOK[id][1], store, verifyMode: 'queue' });
    api = createHttp(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => { api?.close(); if (h) await h.stop(); rmSync(jobsRoot, { recursive: true, force: true }); });

  test('verify only ENQUEUES in queue mode; a second request is the same job; roles are least-privilege', async () => {
    const { vid } = await mkVersion();
    const a = await enqueue(vid);
    assert.equal(a.status, 200, JSON.stringify(a.json)); assert.equal(a.json.queued, true); assert.equal(a.json.duplicate, false);
    const b = await enqueue(vid);
    assert.equal(b.json.jobId, a.json.jobId); assert.equal(b.json.duplicate, true);
    assert.equal((await verifs(vid)).length, 0, 'nothing ran in the API process');
    assert.equal((await enqueue(vid, 'ana')).status, 403);
    assert.equal((await enqueue(vid, 'wrk')).status, 403, 'a verifier cannot request runs');
    assert.equal((await claim('eng')).status, 403, 'an engineer is not a worker');
    assert.equal((await claim('ana')).status, 403);
    assert.equal((await call(`/admin/marketplace/versions/${vid}/approve`, { as: 'wrk', body: {} })).status, 403, 'a leaked worker token cannot approve');
    assert.equal((await call('/admin/marketplace/catalog', { as: 'wrk' })).status, 403);
    assert.equal((await call('/admin/marketplace/verify-jobs/claim', { body: { worker: 'x' } })).status, 401);
    assert.equal((await call(`/admin/marketplace/versions/${vid}/verification`, { as: 'ana' })).json.job.status, 'queued');
    await h.owner.query(`UPDATE marketplace_verify_jobs SET status = 'dead' WHERE id = $1`, [a.json.jobId]);   // clear for later tests
  });

  test('lease race: two workers claiming one job at once get exactly one', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => claim(i % 2 ? 'wrk' : 'wrk2', `race-${i}`)));
    assert.deepEqual(rs.map((r) => r.status), rs.map(() => 200));
    const got = rs.filter((r) => r.json.job);
    assert.equal(got.length, 1);
    assert.equal(got[0].json.job.id, q.json.jobId); assert.equal((await jobRow(q.json.jobId)).attempts, 1);
    await h.owner.query(`UPDATE marketplace_verify_jobs SET status = 'dead' WHERE id = $1`, [q.json.jobId]);
  });

  test('a killed worker never strands the version: the expired lease is reclaimed, the old lease is dead', async () => {
    const { vid, sha } = await mkVersion(); const q = await enqueue(vid);
    const first = (await claim('wrk', 'doomed')).json.job;
    assert.equal((await claim('wrk2', 'rival')).json.job, null, 'a live lease is not reclaimable');
    await expire(first.id);                       // the worker was SIGKILLed: its heartbeats stop and the lease lapses
    const second = (await claim('wrk2', 'rival')).json.job;
    assert.equal(second.id, q.json.jobId); assert.equal(second.attempts, 2); assert.notEqual(second.leaseToken, first.leaseToken);
    // the zombie wakes up: it can neither extend nor deliver nor download nor upload
    const hb = await call(`/admin/marketplace/verify-jobs/${first.id}/heartbeat`, { as: 'wrk', lease: first.leaseToken, body: {} });
    assert.equal(hb.status, 409); assert.equal(hb.json.code, 'lease_lost');
    assert.equal((await call(`/admin/marketplace/verify-jobs/${first.id}/result`, { as: 'wrk', lease: first.leaseToken, body: okResult(sha) })).json.code, 'lease_lost');
    assert.equal((await call(`/admin/marketplace/verify-jobs/${first.id}/artifact`, { as: 'wrk', lease: first.leaseToken })).status, 409);
    assert.equal((await call(`/admin/marketplace/verify-jobs/${first.id}/blob`, { as: 'wrk', lease: first.leaseToken, raw: strToU8('x') })).status, 409);
    assert.equal((await call(`/admin/marketplace/verify-jobs/${first.id}/fail`, { as: 'wrk', lease: first.leaseToken, body: { error: 'x' } })).status, 409);
    assert.equal((await verifs(vid)).length, 0);
    // the new holder delivers; the heartbeat extends only its own lease
    assert.equal((await call(`/admin/marketplace/verify-jobs/${second.id}/heartbeat`, { as: 'wrk2', lease: second.leaseToken, body: {} })).status, 200);
    const done = await call(`/admin/marketplace/verify-jobs/${second.id}/result`, { as: 'wrk2', lease: second.leaseToken, body: okResult(sha) });
    assert.equal(done.status, 200, JSON.stringify(done.json)); assert.equal(done.json.duplicate, false);
    assert.equal((await jobRow(second.id)).status, 'done'); assert.equal((await verifs(vid)).length, 1);
  });

  test('a result is idempotent per job: a replayed delivery is the same record, never a second row', async () => {
    const { vid, sha } = await mkVersion(); await enqueue(vid);
    const j = (await claim()).json.job; const body = okResult(sha);
    const a = await call(`/admin/marketplace/verify-jobs/${j.id}/result`, { as: 'wrk', lease: j.leaseToken, body });
    const b = await call(`/admin/marketplace/verify-jobs/${j.id}/result`, { as: 'wrk', lease: j.leaseToken, body: okResult(sha, { finishedAt: new Date().toISOString(), env: { again: '1' } }) });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true); assert.equal(b.json.verificationId, a.json.verificationId);
    assert.equal((await verifs(vid)).length, 1);
    assert.equal((await call(`/admin/marketplace/verify-jobs/${j.id}/result`, { as: 'wrk', lease: 'f'.repeat(48), body })).json.code, 'lease_lost', 'a stranger with a guessed token');
  });

  test('a result for a different artifact is refused, and a result for a version whose artifact changed is discarded', async () => {
    const { vid, sha } = await mkVersion(); const q = await enqueue(vid);
    const j = (await claim()).json.job;
    const wrong = await call(`/admin/marketplace/verify-jobs/${j.id}/result`, { as: 'wrk', lease: j.leaseToken, body: okResult(H('9')) });
    assert.equal(wrong.status, 409); assert.equal(wrong.json.code, 'sha_mismatch');
    assert.equal((await jobRow(j.id)).status, 'running', 'a bad delivery does not consume the job');
    // the version's artifact is no longer the one this job verified (simulated by pinning the job to another sha)
    await h.owner.query('UPDATE marketplace_verify_jobs SET sha256 = $2 WHERE id = $1', [q.json.jobId, H('7')]);
    const stale = await call(`/admin/marketplace/verify-jobs/${j.id}/result`, { as: 'wrk', lease: j.leaseToken, body: okResult(H('7')) });
    assert.equal(stale.status, 409); assert.equal(stale.json.code, 'sha_mismatch');
    const row = await jobRow(j.id); assert.equal(row.status, 'dead'); assert.equal(row.last_error, 'artifact-changed');
    assert.equal((await verifs(vid)).length, 0); assert.ok(sha);
  });

  test('retry cap and dead-letter: an explicit incomplete verification, never a silent stall; a new request starts a new job', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    for (let i = 1; i <= 3; i++) {
      const j = (await claim()).json.job; assert.equal(j.attempts, i);
      const f = await call(`/admin/marketplace/verify-jobs/${j.id}/fail`, { as: 'wrk', lease: j.leaseToken, body: { error: `infra ${i}` } });
      assert.equal(f.json.status, i < 3 ? 'queued' : 'dead');
    }
    assert.equal((await claim()).json.job, null);
    const row = await jobRow(q.json.jobId); assert.equal(row.status, 'dead'); assert.match(row.last_error, /infra 3/);
    const v = await verifs(vid); assert.equal(v.length, 1); assert.equal(v[0].verdict, 'incomplete');
    assert.match(v[0].stages[0].reason, /dead-letter/); assert.equal(v[0].stages[0].status, 'skipped');
    const again = await enqueue(vid); assert.notEqual(again.json.jobId, q.json.jobId); assert.equal(again.json.duplicate, false);
    await h.owner.query(`UPDATE marketplace_verify_jobs SET status = 'dead' WHERE id = $1`, [again.json.jobId]);
  });

  test('fail and blob are audited in the same transaction as the change; heartbeat is deliberately not', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    const audits = async (action: string) => (await h.owner.query(`SELECT detail FROM admin_audit WHERE action = $1 AND detail->>'jobId' = $2 ORDER BY id`, [`marketplace.${action}`, q.json.jobId])).rows.map((r) => r.detail);
    const j1 = (await claim()).json.job;
    assert.equal((await call(`/admin/marketplace/verify-jobs/${j1.id}/heartbeat`, { as: 'wrk', lease: j1.leaseToken, body: {} })).status, 200);
    const blob = await call(`/admin/marketplace/verify-jobs/${j1.id}/blob`, { as: 'wrk', lease: j1.leaseToken, raw: strToU8('evidence-1'), mime: 'text/plain' });
    assert.equal(blob.status, 200, JSON.stringify(blob.json));
    const [b] = await audits('verify_blob');
    assert.equal(b.sha256, blob.json.sha256); assert.equal(b.size, blob.json.size); assert.equal(b.versionId, vid); assert.equal(b.mime, 'text/plain');
    assert.ok(!JSON.stringify(b).includes('evidence-1'), 'the bytes never reach the audit row');
    // a rejected blob (lost lease) changes nothing and is not audited
    assert.equal((await call(`/admin/marketplace/verify-jobs/${j1.id}/blob`, { as: 'wrk', lease: 'f'.repeat(48), raw: strToU8('x') })).status, 409);
    assert.equal((await audits('verify_blob')).length, 1);
    const f1 = await call(`/admin/marketplace/verify-jobs/${j1.id}/fail`, { as: 'wrk', lease: j1.leaseToken, body: { error: 'infra one' } });
    assert.equal(f1.json.status, 'queued');
    assert.equal((await call(`/admin/marketplace/verify-jobs/${j1.id}/fail`, { as: 'wrk', lease: j1.leaseToken, body: { error: 'again' } })).status, 409);
    const a1 = await audits('verify_fail');
    assert.equal(a1.length, 1, 'a rejected fail is not audited');
    assert.deepEqual([a1[0].to, a1[0].attempt, a1[0].error, a1[0].versionId], ['queued', 1, 'infra one', vid]);
    for (let i = 2; i <= 3; i++) { const j = (await claim()).json.job; await call(`/admin/marketplace/verify-jobs/${j.id}/fail`, { as: 'wrk', lease: j.leaseToken, body: { error: `infra ${i}` } }); }
    const all = await audits('verify_fail');
    assert.deepEqual(all.map((d) => d.to), ['queued', 'queued', 'dead']);
    assert.equal((await audits('verify_heartbeat')).length, 0);
    const hb = (await h.owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action LIKE '%heartbeat%'`)).rows[0].n;
    assert.equal(hb, 0, 'heartbeat is high-frequency and stays unaudited');
  });

  test('lease expiry that exhausts the attempts dead-letters on the next claim (a crash loop cannot wedge a version)', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    for (let i = 0; i < 3; i++) { await claim(); await expire(q.json.jobId); }
    assert.equal((await claim()).json.job, null);
    assert.equal((await jobRow(q.json.jobId)).status, 'dead'); assert.equal((await verifs(vid))[0].verdict, 'incomplete');
  });

  test('worker, real sandboxed child: unpack -> pipeline -> evidence blob upload -> recorded pass; credentials never logged', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid); logs.length = 0;
    const w = worker(null);
    assert.equal(await w.runOnce(), 'done', logs.join('\n'));
    const v = await verifs(vid); assert.equal(v.length, 1); assert.equal(v[0].verdict, 'pass');
    assert.equal(v[0].pipeline, 'template-basic'); assert.match(v[0].env.containment, /net=/);
    assert.equal(v[0].evidence_shas.length, 1);
    assert.ok(await store.get(v[0].evidence_shas[0]), 'the evidence blob reached the store through the API');
    const row = await jobRow(q.json.jobId); assert.equal(row.status, 'done'); assert.equal(row.verification_id, v[0].id);
    assert.equal(await w.runOnce(), 'idle');
    const all = logs.join('\n'); assert.ok(!all.includes(SECRET)); assert.ok(!all.includes(row.lease_token ?? '\u0000')); assert.ok(logs.some((l) => l.includes('claimed')));
    assert.equal(w.health().done, 1);
  });

  // hostile package behaviour, end to end through the worker: each is recorded as a fail with evidence and the worker survives
  for (const [mode, reason, opts] of [
    ['hang', 'sandbox:timeout', { timeoutMs: 1500 }], ['megabytes', 'sandbox:output-cap', { maxStdoutBytes: 128 * 1024 }],
    ['exit3', 'sandbox:exit-3', {}], ['garbage', 'sandbox:invalid-output', {}], ['alloc', 'sandbox:memory', { maxRssBytes: 300 * 1024 * 1024, timeoutMs: 30_000 }],
  ] as const) {
    test(`hostile "${mode}": recorded as fail ${reason} with evidence; worker keeps serving`, async () => {
      const { vid } = await mkVersion(); const q = await enqueue(vid); logs.length = 0;
      const w = worker(mode, { sandbox: { workRoot: jobsRoot, ...opts } });
      assert.equal(await w.runOnce(), 'done', logs.join('\n'));
      const v = (await verifs(vid))[0]; assert.equal(v.verdict, 'fail');
      assert.equal(v.stages[0].id, 'sandbox'); assert.equal(v.stages[0].reason, reason);
      assert.ok(v.stages[0].evidence.length >= 1 && JSON.stringify(v).length < 20_000);
      assert.equal((await jobRow(q.json.jobId)).status, 'done');
      assert.deepEqual(leftoverWorkdirs(jobsRoot), []);
      assert.ok(!JSON.stringify(v).includes(SECRET)); assert.equal(await w.runOnce(), 'idle');
    });
  }

  test('hostile child that dumps its environment as evidence learns nothing: no credential reaches it or the stored record', async () => {
    const { vid } = await mkVersion(); await enqueue(vid); logs.length = 0;
    process.env.AO_VERIFY_TOKEN = SECRET;
    try { assert.equal(await worker('env-dump').runOnce(), 'done', logs.join('\n')); } finally { delete process.env.AO_VERIFY_TOKEN; }
    const v = (await verifs(vid))[0]; assert.ok(!JSON.stringify(v).includes(SECRET)); assert.ok(!logs.join('\n').includes(SECRET));
    const seen = Object.keys(JSON.parse(v.stages[0].evidence[0].detail)); assert.ok(!seen.some((k) => /TOKEN|DATABASE|SECRET|KEY/.test(k)), seen.join(','));
  });

  test('hostile child output the server refuses (score keys, forged verdict) hands the job back instead of storing it', async () => {
    for (const mode of ['forged-score', 'forged-verdict']) {
      const { vid } = await mkVersion(); const q = await enqueue(vid);
      const r = await worker(mode).runOnce();
      assert.equal(r, 'failed', mode);
      const row = await jobRow(q.json.jobId); assert.equal(row.status, 'queued'); assert.match(row.last_error, /result-rejected/); assert.equal((await verifs(vid)).length, 0, mode);
      await h.owner.query(`UPDATE marketplace_verify_jobs SET status = 'dead' WHERE id = $1`, [q.json.jobId]);
    }
  });

  test('a child cannot choose what was verified, and a blob reference it never uploaded is dropped', async () => {
    const { vid, sha } = await mkVersion(); await enqueue(vid);
    assert.equal(await worker('other-subject').runOnce(), 'done');
    assert.equal((await verifs(vid))[0].sha256, sha);
    const b = await mkVersion(); await enqueue(b.vid);
    assert.equal(await worker('ghost-blob').runOnce(), 'done');
    const v = (await verifs(b.vid))[0]; assert.equal(v.evidence_shas.length, 0); assert.equal(v.stages[0].evidence[0].blob, undefined);
  });

  test('graceful shutdown mid-job: the child is killed, the job goes back to the queue, the next worker finishes it', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    const w1 = worker('hang', { pollMs: 50, sandbox: { workRoot: jobsRoot, timeoutMs: 60_000 } });
    await w1.start();
    for (let i = 0; i < 100 && !w1.health().current; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(w1.health().status, 'busy');
    await w1.stop(200);
    assert.equal(w1.health().status, 'stopped');
    const row = await jobRow(q.json.jobId); assert.equal(row.status, 'queued'); assert.equal(row.last_error, 'worker-shutdown'); assert.equal(row.attempts, 1);
    assert.deepEqual(leftoverWorkdirs(jobsRoot), []);
    assert.equal(await worker('ok').runOnce(), 'done');
    assert.equal((await jobRow(q.json.jobId)).attempts, 2); assert.equal((await verifs(vid))[0].verdict, 'pass');
  });

  test('a worker whose lease was taken over discards its result (it cannot overwrite the new holder)', async () => {
    const { vid } = await mkVersion(); const q = await enqueue(vid);
    const w = worker('hang', { leaseSec: 1, sandbox: { workRoot: jobsRoot, timeoutMs: 30_000 } });
    const run = w.runOnce();
    for (let i = 0; i < 100 && !w.health().current; i++) await new Promise((r) => setTimeout(r, 30));
    await h.owner.query(`UPDATE marketplace_verify_jobs SET lease_until = now() - interval '1 second', lease_token = 'x' WHERE id = $1`, [q.json.jobId]);   // another worker took it over
    assert.equal(await run, 'lost');
    assert.equal(w.health().leaseLost, 1); assert.equal((await verifs(vid)).length, 0);
  });

  test('health endpoint and heartbeat bookkeeping', async () => {
    const w = worker('ok', { healthPort: 0, pollMs: 50 }); await w.start();
    try {
      const res = await fetch(`http://127.0.0.1:${w.healthAddress()}/healthz`); const j = await res.json() as any;
      assert.equal(res.status, 200); assert.equal(j.workerId, 'w-ok'); assert.ok(['idle', 'busy'].includes(j.status));
      assert.ok(!JSON.stringify(j).includes(SECRET));
    } finally { await w.stop(500); }
  });
});
