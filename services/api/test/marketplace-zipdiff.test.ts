// Server leg of the three-reader zip differential (Plan 4 Task 9). The desktop reader and the Hermes reader cannot be
// imported into this runtime, so the comparison is corpus based: scripts/dev/marketplace-zip-differential.mjs generates a
// corpus, runs this file, the desktop zipCorpus test and the Hermes pytest on it, and compares their JSONL outputs.
//   ZIPDIFF_CORPUS=<dir> ZIPDIFF_OUT=<dir>   write <out>/server.jsonl for that corpus
//   (neither set)                            generate a corpus in memory and check the server reader on its own
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256Hex, unpack, UnpackError } from '../src/marketplace/artifacts.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { generateCorpus, type FuzzCase } from './lib/zipfuzz.ts';

export interface Verdict { id: string; outcome: 'accept' | 'reject'; code?: string; msg?: string; files?: [string, string][] }

// The server install path is unpack() followed by validateArtifact(); the reader-level verdict is unpack plus the checks
// that police the package itself (manifest, paths, hashes, skill size caps), not the content scanners.
const READER_CHECKS = new Set(['manifest-type-matches', 'manifest-valid', 'file-paths-safe', 'files-match-hashes', 'size-limits']);

export async function readServer(bytes: Uint8Array, id: string): Promise<Verdict> {
  try {
    const pkg = unpack(bytes);
    const report = await validateArtifact(pkg.manifest.type, pkg);
    const failed = report.checks.filter((c) => !c.ok && (READER_CHECKS.has(c.name)));
    if (failed.length) return { id, outcome: 'reject', code: 'bad-manifest', msg: `${failed[0].name}: ${failed[0].detail ?? ''}`.slice(0, 200) };
    const files = [...pkg.files].map(([p, b]): [string, string] => [p, sha256Hex(b)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return { id, outcome: 'accept', files };
  } catch (e) {
    if (e instanceof UnpackError) return { id, outcome: 'reject', code: e.code, msg: e.message.slice(0, 200) };
    return { id, outcome: 'reject', code: 'crash', msg: String(e).slice(0, 200) };
  }
}

const corpusDir = process.env.ZIPDIFF_CORPUS, outDir = process.env.ZIPDIFF_OUT;

test('zip differential: server reader over the corpus', async () => {
  let cases: Pick<FuzzCase, 'id' | 'bytes'>[];
  if (corpusDir) {
    const m = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')) as { cases: { id: string }[] };
    cases = m.cases.map((c) => ({ id: c.id, bytes: new Uint8Array(readFileSync(join(corpusDir, `${c.id}.zip`))) }));
  } else {
    cases = generateCorpus();
  }
  assert.ok(cases.length >= 300, `corpus must have at least 300 zips, has ${cases.length}`);
  const out: string[] = [];
  let accepted = 0;
  for (const c of cases) {
    const v = await readServer(c.bytes, c.id);
    assert.notEqual(v.code, 'crash', `the server reader must reject, never crash: ${c.id}: ${v.msg}`);
    if (v.outcome === 'accept') accepted++;
    out.push(JSON.stringify(v));
  }
  if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, 'server.jsonl'), out.join('\n') + '\n'); }
  assert.ok(accepted >= 5, `a corpus the server reader accepts nothing from proves nothing (accepted ${accepted})`);
  assert.ok(accepted < cases.length, 'a corpus the server reader accepts everything from proves nothing');
});

test('zip differential: the generator is deterministic and the safety invariant holds on every accepted zip', { skip: corpusDir ? 'the differential script compares the corpus itself' : false }, async () => {
  const a = generateCorpus(1234, 40), b = generateCorpus(1234, 40), c = generateCorpus(4321, 40);
  assert.deepEqual(a.map((x) => sha256Hex(x.bytes)), b.map((x) => sha256Hex(x.bytes)));
  assert.notDeepEqual(a.map((x) => sha256Hex(x.bytes)), c.map((x) => sha256Hex(x.bytes)));
  const bad: string[] = [];
  for (const k of a) {
    const v = await readServer(k.bytes, k.id);
    if (v.outcome !== 'accept') continue;
    for (const [p] of v.files!) {
      if (p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.' || s === '')) bad.push(`unsafe accepted path ${JSON.stringify(p)} in ${k.id}`);
    }
    if (k.expect === 'reject') bad.push(`${k.id} (${k.note}) must be rejected but the server accepted it`);
  }
  assert.deepEqual(bad, []);
});
