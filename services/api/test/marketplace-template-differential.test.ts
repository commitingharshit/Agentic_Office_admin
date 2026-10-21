// The OfficeCLI differential's own machinery: seeded mutations are reproducible, OfficeCLI output is classified, and (when a
// binary is installed) the reference agrees on one real template and one truncated file. The full 500-mutation run is
// `npm run eval:differential`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import { classifyOfficecli, mutations, officecliBin, officecliVerdict, rng } from '../evals/template-differential.ts';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/marketplace/${n}`, import.meta.url)));
const bases = { docx: fx('board-memo.docx'), pptx: fx('board-update.pptx'), xlsx: fx('budget-tracker.xlsx') };

describe('differential machinery', () => {
  test('the PRNG and the mutation set are reproducible per seed and differ across seeds', () => {
    assert.deepEqual([rng(7)(), rng(7)()], [rng(7)(), rng(7)()]);
    const a = mutations(bases, 30, 5).map((m) => `${m.id}:${sha256Hex(m.bytes)}`), b = mutations(bases, 30, 5).map((m) => `${m.id}:${sha256Hex(m.bytes)}`);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, mutations(bases, 30, 6).map((m) => `${m.id}:${sha256Hex(m.bytes)}`));
    assert.equal(new Set(mutations(bases, 200, 1).map((m) => m.op)).size >= 8, true, 'operators are spread');
  });
  test('classification', () => {
    assert.equal(classifyOfficecli({ code: 0, out: 'Validation passed' }, { code: 0, out: 'Found 0' }).kind, 'ok');
    assert.equal(classifyOfficecli({ code: 1, out: 'Error: Cannot open x.docx: File contains corrupted data.' }, undefined).kind, 'cannot-open');
    assert.equal(classifyOfficecli({ code: 1, out: 'Found 1 validation error(s):\n  [Package] x' }, undefined).kind, 'invalid');
    assert.equal(classifyOfficecli({ code: null, out: '' }, undefined).kind, 'error');
  });
  const bin = officecliBin();
  test('OfficeCLI agrees: a real template opens, a truncated one does not', { skip: bin ? false : 'officecli not installed', timeout: 180_000 }, async () => {
    assert.equal((await officecliVerdict(bin!, bases.docx, 'docx')).kind, 'ok');
    assert.equal((await officecliVerdict(bin!, bases.docx.slice(0, 500), 'docx')).kind, 'cannot-open');
  });
});
