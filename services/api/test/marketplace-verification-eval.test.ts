// Plan 4 Task 7: the verification eval's gate logic must not pass vacuously. Fake tools and tiny corpora; the real corpus run is
// `npm run eval:verification` (real officecli and kernels).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import '../src/marketplace/verify/stages/template/index.ts';
import type { PipelineTools } from '../src/marketplace/verify/types.ts';
import { evaluate } from '../evals/run-verification.ts';
import { vcases, type VCase } from '../evals/verification-corpus/index.ts';

const HAVE = { officecli: false, kernel: false };
const benign = vcases.find((c) => c.label === 'benign')!;
const hostile = vcases.find((c) => c.label === 'hostile')!;
const broken = (over: Partial<VCase> = {}): VCase => ({ id: 'bk', label: 'broken', note: 'x', catches: ['issues'], needs: [], build: () => benign.build(), ...over });
const tools: PipelineTools = {};

describe('verification eval gate', () => {
  test('the real corpus has all three classes and enough cases', () => {
    for (const l of ['benign', 'hostile', 'broken']) assert.ok(vcases.some((c) => c.label === l), l);
    assert.ok(vcases.filter((c) => c.label === 'hostile').length >= 40);
    assert.ok(vcases.filter((c) => c.label === 'broken').length >= 6);
    assert.ok(vcases.filter((c) => c.label === 'benign').length >= 5);
  });
  test('an empty corpus fails', async () => { assert.match((await evaluate([], tools, HAVE, [])).failures.join('\n'), /corpus is empty/); });
  test('a corpus missing a class fails', async () => { assert.match((await evaluate([hostile], tools, HAVE, [])).failures.join('\n'), /no benign cases/); });
  test('a hostile case that the pipeline does not fail is a miss', async () => {
    const g = await evaluate([benign, { ...benign, id: 'looks-fine', label: 'hostile' }, broken()], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.match(g.failures.join('\n'), /looks-fine: hostile package ended/);
  });
  test('a hostile case is detected when the validator stage fails it', async () => {
    const g = await evaluate([benign, hostile], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.ok(!g.failures.some((f) => f.startsWith(hostile.id)), g.failures.join('\n'));
  });
  test('a broken case needing a missing tool is SKIPPED, counted and fails the gate unless the tool is allowed', async () => {
    const c = broken({ id: 'needs-kernel', needs: ['kernel'] });
    const strict = await evaluate([benign, hostile, c], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.deepEqual(strict.skippedCases, ['needs-kernel']);
    assert.match(strict.failures.join('\n'), /needs-kernel: skipped \(tool-missing:kernel\)/);
    assert.equal(strict.outcomes.find((o) => o.id === 'needs-kernel')!.verdict, 'skipped');
    const allowed = await evaluate([benign, hostile, c], tools, HAVE, ['tool-missing', 'not-discriminating', 'kernel']);
    assert.ok(!allowed.failures.some((f) => f.startsWith('needs-kernel')));
    assert.deepEqual(allowed.skippedCases, ['needs-kernel']);   // still reported
  });
  test('a broken case failing at an unexpected stage does not count as caught', async () => {
    const g = await evaluate([benign, { ...hostile, label: 'broken', id: 'wrong-stage', catches: ['formula-validity'] }], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.match(g.failures.join('\n'), /wrong-stage: failed, but not at the expected stage/);
  });
  test('required stages skipped on a benign case are counted per reason and must be covered by --allow-skip', async () => {
    const g = await evaluate([benign, hostile, broken()], tools, HAVE, []);
    assert.ok(Object.keys(g.skippedStageReasons).length > 0, 'with no tools, required stages are skipped');
    assert.match(g.failures.join('\n'), /required stage .* skipped .* not covered by --allow-skip/);
  });
  test('a crashing builder is a crash, never a detection', async () => {
    const g = await evaluate([benign, hostile, broken({ id: 'boom', build: () => { throw new Error('boom'); } })], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.match(g.failures.join('\n'), /boom: the pipeline crashed/);
  });
  test('no result carries a score-like key', async () => {
    const g = await evaluate([benign, hostile, broken()], tools, HAVE, ['tool-missing', 'not-discriminating']);
    assert.doesNotMatch(JSON.stringify(g), /"(score|confidence|grade|percent)"/i);
  });
});
