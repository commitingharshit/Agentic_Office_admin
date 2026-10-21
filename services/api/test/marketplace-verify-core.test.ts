import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import { LISTING_TYPES, type ListingType, type ManifestV1, type UnpackedPackage } from '../src/marketplace/types.ts';
import { getValidator, validateArtifact } from '../src/marketplace/validate/index.ts';
import { fromValidationReport } from '../src/marketplace/verify/adapters.ts';
import { memoryEvidenceSink } from '../src/marketplace/verify/evidence.ts';
import { assertNoScoreKeys, assertPipelineContract, getPipeline, listPipelines, registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';
import { canonicalJson, deriveVerdict, runPipeline, serializeResult } from '../src/marketplace/verify/runner.ts';
import { defaultTools } from '../src/marketplace/verify/tools.ts';
import type { PipelineDef, StageDef, StageOutput, StageResult } from '../src/marketplace/verify/types.ts';

const enc = (s: string) => new TextEncoder().encode(s);
function pkgOf(): UnpackedPackage {
  const files = new Map([['SKILL.md', enc('---\nname: pdf-notes\ndescription: Summarize PDFs.\n---\n\n# Hi\n')]]);
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: 'acme/pdf-notes', type: 'skill', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
    compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { entry: 'SKILL.md', name: 'pdf-notes' },
  };
  return { files, manifest };
}
const T: ListingType = 'bundle'; // no real pipeline or validator registered: a safe slot for fixtures
const stage = (id: string, run: StageDef['run'], o: Partial<StageDef> = {}): StageDef => ({ id, title: id, required: false, timeoutMs: 1000, run, ...o });
const pass = async (): Promise<StageOutput> => ({ status: 'pass', evidence: [] });
const mk = (stages: StageDef[], o: Partial<PipelineDef> = {}): PipelineDef => ({ type: T, name: 'fixture', version: 1, stages, ...o });
const withPipeline = async (def: PipelineDef, fn: () => Promise<void>) => { registerPipeline(def); try { await fn(); } finally { unregisterPipelineForTest(def.type); } };
const sr = (status: StageResult['status'], required: boolean): StageResult => ({ id: 'x', title: 'x', required, status, evidence: [], durationMs: 0, ...(status === 'pass' ? {} : { reason: 'r' }) });
const run = (t: ListingType = T, o = {}) => runPipeline(t, pkgOf(), {}, { evidence: memoryEvidenceSink(), ...o });

describe('deriveVerdict truth table', () => {
  const cases: [StageResult['status'], boolean, string][] = [
    ['pass', true, 'pass'], ['pass', false, 'pass'], ['fail', true, 'fail'], ['fail', false, 'fail'], ['skipped', true, 'incomplete'], ['skipped', false, 'pass'],
  ];
  for (const [st, req, want] of cases) test(`${st} ${req ? 'required' : 'optional'} => ${want}`, () => assert.equal(deriveVerdict([sr('pass', true), sr(st, req)]), want));
  test('a failure outranks a skipped required stage', () => assert.equal(deriveVerdict([sr('skipped', true), sr('fail', false)]), 'fail'));
});

describe('registry contract', () => {
  test('rejects: not-manifest-first, duplicate ids, no required stage, bad id, bad timeout, forward/unknown after, duplicate type', () => {
    const m = stage('manifest', pass, { required: true });
    assert.throws(() => assertPipelineContract(mk([stage('a', pass, { required: true })])), /manifest/);
    assert.throws(() => assertPipelineContract(mk([m, stage('a', pass), stage('a', pass)])), /duplicate/);
    assert.throws(() => assertPipelineContract(mk([stage('manifest', pass)])), /required/);
    assert.throws(() => assertPipelineContract(mk([m, stage('Bad_Id', pass)])), /kebab/);
    assert.throws(() => assertPipelineContract(mk([m, stage('a', pass, { timeoutMs: 0 })])), /timeoutMs/);
    assert.throws(() => assertPipelineContract(mk([m, stage('a', pass, { after: ['b'] }), stage('b', pass)])), /earlier/);
    assert.throws(() => assertPipelineContract(mk([m], { type: 'nope' as ListingType })), /unknown listing type/);
    registerPipeline(mk([m]));
    try { assert.throws(() => registerPipeline(mk([m])), /already registered/); } finally { unregisterPipelineForTest(T); }
  });
  test('score-like keys are rejected at any depth, case-insensitively', () => {
    for (const k of ['score', 'confidence', 'grade', 'rating', 'percent', 'Score']) assert.throws(() => assertNoScoreKeys({ a: [{ b: { c: { [k]: 1 } } }] }), /forbidden key/);
    assertNoScoreKeys({ measured: { name: 'ssim', value: 0.9, threshold: 0.8, op: '>=' } });
  });
  test('onboarding: unregistered type is a single failed type-supported stage', async () => {
    const r = await run('connector');
    assert.equal(r.verdict, 'fail'); assert.equal(r.stages.length, 1);
    assert.equal(r.stages[0].id, 'type-supported'); assert.equal(r.stages[0].status, 'fail'); assert.match(r.stages[0].reason!, /no verification pipeline for type connector/);
  });
});

describe('runner', () => {
  const man = stage('manifest', pass, { required: true });
  test('stages run in order and dependent stages see earlier results', async () => {
    const order: string[] = [];
    const mkS = (id: string, o: Partial<StageDef> = {}) => stage(id, async () => { order.push(id); return { status: 'pass', evidence: [] }; }, o);
    await withPipeline(mk([{ ...man, run: async () => { order.push('manifest'); return { status: 'pass', evidence: [] }; } }, mkS('b'), mkS('c', { after: ['b'] })]), async () => {
      const r = await run();
      assert.deepEqual(order, ['manifest', 'b', 'c']); assert.deepEqual(r.stages.map(s => s.id), ['manifest', 'b', 'c']); assert.equal(r.verdict, 'pass');
    });
  });
  test('a failing stage skips dependents with a reason; independent stages still run; verdict is fail', async () => {
    let indep = false, dep = false;
    await withPipeline(mk([
      { ...man, run: async () => ({ status: 'fail', reason: 'bad manifest', evidence: [] }) },
      stage('needs-manifest', async () => { dep = true; return pass(); }, { after: ['manifest'], required: true }),
      stage('independent', async () => { indep = true; return pass(); }),
    ]), async () => {
      const r = await run();
      assert.equal(dep, false); assert.equal(indep, true);
      const s = r.stages.find(x => x.id === 'needs-manifest')!;
      assert.equal(s.status, 'skipped'); assert.equal(s.reason, 'prerequisite-failed:manifest'); assert.equal(r.verdict, 'fail');
    });
  });
  test('a skipped prerequisite also skips dependents (never reads as pass)', async () => {
    await withPipeline(mk([man, stage('a', async () => ({ status: 'skipped', reason: 'tool-missing:officecli', evidence: [] }), { required: true }), stage('b', pass, { after: ['a'], required: true })]), async () => {
      const r = await run(); assert.equal(r.stages[2].reason, 'prerequisite-skipped:a'); assert.equal(r.verdict, 'incomplete');
    });
  });
  test('required stage skipped => incomplete, never pass; optional skipped => pass', async () => {
    const skip = async (): Promise<StageOutput> => ({ status: 'skipped', reason: 'tool-missing:x', evidence: [] });
    await withPipeline(mk([man, stage('r', skip, { required: true })]), async () => assert.equal((await run()).verdict, 'incomplete'));
    await withPipeline(mk([man, stage('o', skip)]), async () => assert.equal((await run()).verdict, 'pass'));
  });
  test('a hung stage times out as fail with evidence, quickly, and later stages still run', async () => {
    let after = false;
    await withPipeline(mk([man, stage('hang', () => new Promise<StageOutput>(() => {}), { timeoutMs: 30, required: true }), stage('later', async () => { after = true; return pass(); })]), async () => {
      const t0 = Date.now(); const r = await run();
      assert.ok(Date.now() - t0 < 1500);
      const h = r.stages.find(s => s.id === 'hang')!;
      assert.equal(h.status, 'fail'); assert.equal(h.reason, 'timeout'); assert.ok(h.evidence.length >= 1); assert.equal(after, true); assert.equal(r.verdict, 'fail');
    });
  });
  test('the stage receives an aborted signal on timeout', async () => {
    let aborted = false;
    await withPipeline(mk([man, stage('s', ctx => new Promise<StageOutput>(res => { ctx.signal.addEventListener('abort', () => { aborted = true; res({ status: 'pass', evidence: [] }); }); }), { timeoutMs: 20 })]), async () => {
      const r = await run(); assert.equal(r.stages[1].status, 'fail'); assert.equal(aborted, true);
    });
  });
  test('throws (sync and async, even non-Error) become fail, not a crash', async () => {
    await withPipeline(mk([man,
      stage('sync-throw', () => { throw new Error('boom'); }),
      stage('async-throw', async () => { throw new Error('kaboom'); }),
      stage('weird-throw', async () => { throw 'str'; })]), async () => {
      const r = await run();
      assert.deepEqual(r.stages.slice(1).map(s => s.status), ['fail', 'fail', 'fail']);
      assert.equal(r.stages[1].reason, 'stage-error: boom'); assert.equal(r.stages[3].reason, 'stage-error: str'); assert.equal(r.verdict, 'fail');
    });
  });
  test('malformed stage output fails closed: bad status, no result, skipped without reason, score key, non-finite measurement', async () => {
    const outs: unknown[] = [{ status: 'ok', evidence: [] }, undefined, { status: 'skipped', evidence: [] }, { status: 'fail', evidence: [] }];
    await withPipeline(mk([man, ...outs.map((o, i) => stage(`m${i}`, async () => o as StageOutput))]), async () => {
      const r = await run(); assert.deepEqual(r.stages.slice(1).map(s => s.status), ['fail', 'fail', 'fail', 'fail']);
      for (const s of r.stages.slice(1)) assert.match(s.reason!, /^stage-error:/);
    });
    await withPipeline(mk([man, stage('s', async () => ({ status: 'pass', evidence: [{ kind: 'json', label: 'x', measured: { name: 'ssim', value: NaN, threshold: 1, op: '>=' } }] }))]), async () => {
      const r = await run(); assert.equal(r.stages[1].status, 'pass'); assert.equal(r.stages[1].evidence[0].measured, undefined);
    });
    await withPipeline(mk([man, stage('s', async () => ({ status: 'pass', evidence: [], score: 0.9 } as unknown as StageOutput))]), async () => {
      const r = await run(); assert.equal(JSON.stringify(r).includes('"score"'), false); // extra fields never copied
    });
  });
  test('evidence from a stage is clamped: detail 2 KiB, 50 items per stage, hostile fields dropped', async () => {
    const ev = Array.from({ length: 80 }, (_, i) => ({ kind: 'text' as const, label: `<script>${i}</script>`.repeat(100), detail: 'd'.repeat(10_000) }));
    await withPipeline(mk([man, stage('s', async () => ({ status: 'pass', evidence: [...ev, { bogus: true } as never] }))]), async () => {
      const s = (await run()).stages[1];
      assert.ok(s.evidence.length <= 51); assert.ok(s.evidence.every(e => (e.detail?.length ?? 0) <= 2048 && e.label.length <= 256));
      assert.ok(s.evidence.some(e => e.label === 'evidence truncated'));
    });
  });
  test('evidence sink caps: 2 MiB per blob and 40 per run; truncation is recorded on the stage', async () => {
    await withPipeline(mk([man, stage('s', async ctx => {
      const out = []; let refused = 0;
      for (let i = 0; i < 45; i++) { try { out.push({ kind: 'log' as const, label: `b${i}`, blob: await ctx.evidence.addBlob('text/plain', enc(`blob ${i}`)) }); } catch { refused++; } }
      try { await ctx.evidence.addBlob('text/plain', new Uint8Array(2 * 1024 * 1024 + 1)); } catch { refused++; }
      return { status: 'pass', evidence: [...out, { kind: 'text', label: `refused ${refused}` }] };
    })]), async () => {
      const sink = memoryEvidenceSink();
      const r = await runPipeline(T, pkgOf(), {}, { evidence: sink });
      assert.equal(sink.blobs.size, 40);
      assert.ok(r.stages[1].evidence.some(e => e.label === 'evidence truncated'));
      assert.ok(r.stages[1].evidence.some(e => e.label === 'refused 6'));
    });
  });
  test('missing evidence sink: addBlob refuses, stage still completes', async () => {
    await withPipeline(mk([man, stage('s', async ctx => { await ctx.evidence.addBlob('text/plain', enc('x')); return pass(); })]), async () => {
      const r = await runPipeline(T, pkgOf(), {}); assert.equal(r.stages[1].status, 'fail');
    });
  });
});

describe('serialization', () => {
  const big = (n: number) => ({
    type: T, pipeline: 'fixture', pipelineVersion: 1, subjectSha256: 'a'.repeat(64), verdict: 'fail' as const, env: { b: '2', a: '1' },
    startedAt: 't0', finishedAt: 't1',
    stages: Array.from({ length: 10 }, (_, i): StageResult => ({ id: `s${i}`, title: `s${i}`, required: i === 0, status: i === 3 ? 'fail' : 'pass', ...(i === 3 ? { reason: 'bad' } : {}),
      evidence: Array.from({ length: n }, (_, j) => ({ kind: 'text' as const, label: `e${j}`, detail: 'x'.repeat(2000) })), durationMs: 1 })),
  });
  test('deterministic: key order of input does not matter', () => {
    const a = big(1); const b = JSON.parse(JSON.stringify(a)); b.stages = b.stages.map((s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).reverse()));
    assert.equal(serializeResult(a), serializeResult({ ...b, env: { a: '1', b: '2' } }));
    assert.equal(canonicalJson({ b: 1, a: { d: 1, c: undefined } }), '{"a":{"d":1},"b":1}');
  });
  test('size-capped: evidence is shed, stage ids, statuses and verdict are never dropped', () => {
    const r = big(50); const out = serializeResult(r, 20_000);
    assert.ok(Buffer.byteLength(out) <= 20_000);
    const p = JSON.parse(out); assert.equal(p.truncated, true); assert.equal(p.verdict, 'fail');
    assert.deepEqual(p.stages.map((s: StageResult) => [s.id, s.status]), r.stages.map(s => [s.id, s.status]));
    assert.equal(p.stages[3].reason, 'bad');
  });
  test('an ordinary result is untouched and unmarked', () => assert.equal(JSON.parse(serializeResult(big(1))).truncated, undefined));
  test('even an absurdly small cap never drops stages', () => assert.equal(JSON.parse(serializeResult(big(50), 10)).stages.length, 10));
});

describe('adapters and tools', () => {
  test('fromValidationReport maps a real skill report 1:1, preserving skipped+required', async () => {
    const report = await validateArtifact('skill', pkgOf());
    const stages = fromValidationReport(report);
    assert.deepEqual(stages.map(s => s.id), report.checks.map(c => c.name));
    const scan = stages.find(s => s.id === 'security-scan')!;
    assert.equal(scan.status, 'skipped'); assert.equal(scan.required, true); assert.ok(scan.reason);
    assert.equal(deriveVerdict(stages), report.verified ? 'pass' : report.ok ? 'incomplete' : 'fail');
    assert.equal(deriveVerdict(stages), 'incomplete');
    for (const c of report.checks) { const s = stages.find(x => x.id === c.name)!; assert.equal(s.status, c.skipped ? 'skipped' : c.ok ? 'pass' : 'fail'); }
  });
  test('failed checks map to fail with a reason', () => {
    const [s] = fromValidationReport({ ok: false, checks: [{ name: 'files-match-hashes', ok: false, detail: 'hash mismatch for a' }] });
    assert.equal(s.status, 'fail'); assert.equal(s.reason, 'hash mismatch for a');
  });
  test('defaultTools: every member undefined without configuration (absence => skipped)', () => {
    assert.deepEqual(defaultTools({}), {});
  });
});

describe('conformance', () => {
  // A type with a validator but no pipeline must fail this test; that is what forces Plans 2 and 3 to bring one.
  // Types whose pipeline has landed are listed in COVERED and are checked strictly; the rest are todo until their task registers one.
  const COVERED: ListingType[] = ['template'];
  test('every type with a validator has a pipeline (template: covered)', async () => {
    await import('../src/marketplace/verify/stages/template/index.ts'); // registers the template pipeline
    for (const t of COVERED) { assert.ok(getValidator(t), `${t} has a validator`); assert.ok(getPipeline(t), `no pipeline for ${t}`); }
  });
  test('every type with a validator has a pipeline (remaining types)', { todo: 'skill: enabled in Task 4; Plan 3 types: when their pipelines land' }, () => {
    for (const t of LISTING_TYPES) if (getValidator(t) && !COVERED.includes(t)) assert.ok(getPipeline(t), `no pipeline for ${t}`);
  });
  test('every registered pipeline satisfies the contract', () => { for (const d of listPipelines()) assertPipelineContract(d); });
});
