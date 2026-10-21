// Plan 3 Task 13: the hostile-corpus runner must not pass vacuously. These meta-tests feed the runner doctored corpora
// and assert it fails (exit 1) for each way a gate could silently succeed.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIN_CASES, evaluateAdvancedGate, loadCorpora, type Corpus } from '../evals/advanced-gate.ts';

const copy = async (): Promise<Corpus[]> => (await loadCorpora()).map((c) => ({ type: c.type, benign: [...c.benign], malicious: [...c.malicious] }));

describe('advanced gate runner', () => {
  test('the real corpora pass and cover all six types over their size floor', async () => {
    const r = await evaluateAdvancedGate(await loadCorpora());
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.perType.map((t) => t.type).sort(), ['bridge', 'connector', 'hook', 'memory', 'routine', 'workflow']);
    for (const t of r.perType) assert.ok(t.benign + t.malicious >= MIN_CASES[t.type], `${t.type} below its floor`);
    assert.equal(r.exitCode, 0);
  });

  test('a malicious case that validates ok fails the gate', async () => {
    const cs = await copy();
    const hook = cs.find((c) => c.type === 'hook')!;
    hook.malicious.push({ ...hook.benign[0], id: 'sneaky', label: 'malicious' } as any);
    const r = await evaluateAdvancedGate(cs);
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join('\n'), /hook.*sneaky/);
  });

  test('deleting half a corpus fails the size floor', async () => {
    const cs = await copy();
    const m = cs.find((c) => c.type === 'memory')!;
    m.malicious = m.malicious.slice(0, 2);  // 6 benign + 2 hostile = 8, under the floor of 10
    const r = await evaluateAdvancedGate(cs);
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join('\n'), /memory.*floor/);
  });

  test('an emptied corpus and a missing corpus both fail', async () => {
    const cs = await copy();
    cs.find((c) => c.type === 'bridge')!.malicious = [];
    assert.equal((await evaluateAdvancedGate(cs)).exitCode, 1);
    const missing = (await copy()).filter((c) => c.type !== 'workflow');
    const r = await evaluateAdvancedGate(missing);
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join('\n'), /workflow.*missing/);
  });

  test('a benign case that fails is a false positive and fails the gate', async () => {
    const cs = await copy();
    const hook = cs.find((c) => c.type === 'hook')!;
    hook.benign.push({ ...hook.malicious[0], id: 'broken-benign', label: 'benign' } as any);
    const r = await evaluateAdvancedGate(cs);
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join('\n'), /hook\/broken-benign: false positive/);
  });

  test('a validator crash is not detection: it fails the gate whether the case is benign or malicious', async () => {
    const cs = await copy();
    const hook = cs.find((c) => c.type === 'hook')!;
    hook.malicious.push({ id: 'crashes', label: 'malicious', category: 'x', note: 'x', build: () => { throw new Error('boom'); } } as any);
    const r = await evaluateAdvancedGate(cs);
    assert.equal(r.exitCode, 1);
    assert.match(r.failures.join('\n'), /hook\/crashes: validator crash/);
  });

  test('a known gap is reported, not hidden, and a stale one is flagged', async () => {
    const cs = await copy();
    const hook = cs.find((c) => c.type === 'hook')!;
    hook.malicious.push({ ...hook.benign[0], id: 'gap1', label: 'malicious' } as any);
    const r = await evaluateAdvancedGate(cs, new Map([['hook/gap1', 'documented'], ['hook/h01-block-named-path', 'stale entry']]));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.knownGapsOpen, ['hook/gap1']);
    assert.ok(r.notes.join('\n').includes('hook/h01-block-named-path'));
  });
});
