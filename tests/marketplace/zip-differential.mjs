#!/usr/bin/env node
// Three-reader zip differential for marketplace packages (Plan 4, Task 9).
//
// The three readers cannot share a runtime: the server (services/api/src/marketplace/artifacts.ts), the
// desktop (apps/desktop/src/vs/platform/marketplace/node/safeUnzip.ts) and Hermes (tools/skill_sources/agentic_marketplace.py,
// Python zipfile). So: generate a deterministic corpus into a temp dir, run each reader's runner on it, and compare the
// per-zip verdicts here.
//
//   node tests/marketplace/zip-differential.mjs [--iters N] [--seed N] [--out DIR] [--keep] [--json]
//   FUZZ_ITERS (default 400) and FUZZ_SEED override the defaults; HERMES_PYTHON picks the Python with Hermes' dependencies.
//
// Rules enforced (exit 1 on any violation):
//   safety      every accepted path is relative, has no ./.. segments, no backslash/colon/control chars, and no two accepted
//               paths collide after NFC + lowercase or sit one under the other as file and directory.
//   content     all readers that accept a zip yield identical (path, sha256) sets (so identical names, bytes and counts).
//   expectation a zip the generator marks 'reject' (zip-slip, symlink, ...) must be rejected by every reader; 'accept' by none rejecting
//               unless documented.
//   agreement   one reader accepting while another rejects is only allowed for a class listed, with a reason, in
//               known-divergences.json. A rejection with a policy code (zip-slip, symlink, bad-path, duplicate, too-large,
//               too-many-files) is never covered by a wildcard: the entry must set "allowPolicy": true and say why.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const iters = Number(arg('--iters', process.env.FUZZ_ITERS ?? 400));
const seed = Number(arg('--seed', process.env.FUZZ_SEED ?? NaN));
const keep = argv.includes('--keep');
const READERS = ['server', 'desktop', 'python'];
const POLICY = new Set(['zip-slip', 'symlink', 'bad-path', 'duplicate', 'too-large', 'too-many-files']);

const fuzz = await import(pathToFileURL(join(repo, 'services/api/test/lib/zipfuzz.ts')).href);
const work = arg('--out', mkdtempSync(join(tmpdir(), 'zipdiff-')));
const corpusDir = join(work, 'corpus'), outDir = join(work, 'out');
mkdirSync(outDir, { recursive: true });
const useSeed = Number.isFinite(seed) ? seed : fuzz.DEFAULT_SEED;
const cases = fuzz.generateCorpus(useSeed, iters);
fuzz.writeCorpus(corpusDir, cases, { seed: useSeed, iters });
console.log(`corpus: ${cases.length} zips (seed ${useSeed}, iters ${iters}) in ${corpusDir}`);

// ---------------------------------------------------------------- run the three readers
const env = { ...process.env, ZIPDIFF_CORPUS: corpusDir, ZIPDIFF_OUT: outDir };
const py = process.env.HERMES_PYTHON
  ?? ['/Users/harshitverma/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python', join(repo, 'vendor/hermes-agent/venv/bin/python')].find(existsSync) ?? 'python3';
const runs = {
  server: ['node', ['--test', 'test/marketplace-zipdiff.test.ts'], join(repo, 'services/api')],
  desktop: ['node', ['--experimental-transform-types', '--no-warnings', join(here, 'marketplace-zip-differential/desktop-driver.mjs'),
    join(repo, 'apps/desktop/src/vs/platform/marketplace/test/node/zipCorpus.test.ts')], repo],
  python: [py, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/tools/test_agentic_marketplace_zip_corpus.py'], join(repo, 'vendor/hermes-agent')],
};
const runnerFailures = [];
for (const [name, [cmd, args, cwd]] of Object.entries(runs)) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 15 * 60_000 });
  if (r.status !== 0) { runnerFailures.push(`${name} runner exited ${r.status}\n${(r.stdout + r.stderr).split('\n').slice(-25).join('\n')}`); }
}

const load = (n) => {
  const f = join(outDir, `${n}.jsonl`);
  const m = new Map();
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) if (l.trim()) { const v = JSON.parse(l); m.set(v.id, v); }
  return m;
};
const verdicts = { server: load('server'), desktop: load('desktop'), python: load('hermes') };

// ---------------------------------------------------------------- independent safety invariant
function pathProblem(p) {
  if (!p || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p) || /[\x00-\x1f\x7f:]/.test(p)) return 'unsafe characters or absolute';
  for (const s of p.split('/')) if (s === '' || s === '.' || s === '..') return 'empty, . or .. segment';
  return null;
}
function collisions(paths) {
  const seen = new Map();
  for (const p of paths) { const k = p.normalize('NFC').toLowerCase(); if (seen.has(k)) return `${p} collides with ${seen.get(k)}`; seen.set(k, p); }
  const keys = new Set([...seen.keys()]);
  for (const k of keys) { const parts = k.split('/'); for (let i = 1; i < parts.length; i++) if (keys.has(parts.slice(0, i).join('/'))) return `${k} is below a file`; }
  return null;
}

// ---------------------------------------------------------------- comparison
const known = JSON.parse(readFileSync(join(here, 'marketplace-zip-differential/known-divergences.json'), 'utf8'));
const allowOpen = argv.includes('--allow-open-holes');
const usedKnown = new Map([...known.entries, ...(known.openHoles ?? [])].map((e) => [e.id, 0]));
const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const matches = (e, c, acc, rej, v) => new RegExp(`^(${e.match.cls})$`).test(c.cls) && same(e.match.accept ?? [], acc) && same(e.match.reject ?? [], rej)
  && (!e.match.rejectCodes || rej.every((r) => e.match.rejectCodes.includes(v[r].code)))
  && Object.entries(e.match.rejectMsg ?? {}).every(([r, re]) => !rej.includes(r) || new RegExp(re).test(v[r].msg ?? ''));
const rule = (c, acc, rej, v) => known.entries.find((e) => matches(e, c, acc, rej, v));
const openRule = (c, acc, rej, v) => (known.openHoles ?? []).find((e) => e.kind !== 'CONTENT' && matches(e, c, acc, rej, v));
const openContent = (c) => (known.openHoles ?? []).find((e) => e.kind === 'CONTENT' && new RegExp(`^(${e.match.cls})$`).test(c.cls));
const openFound = {};
const fileKey = (v) => JSON.stringify((v.files ?? []).map(([p, h]) => [p, h]));

const failures = [], tally = { server: { accept: 0, reject: 0 }, desktop: { accept: 0, reject: 0 }, python: { accept: 0, reject: 0 } };
const divergences = [], perCase = [], crashes = {};
let agreeAccept = 0, agreeReject = 0;
for (const c of cases) {
  const v = Object.fromEntries(READERS.map((r) => [r, verdicts[r].get(c.id)]));
  const miss = READERS.filter((r) => !v[r]);
  if (miss.length) { failures.push(`${c.id}: no verdict from ${miss.join(', ')}`); continue; }
  for (const r of READERS) tally[r][v[r].outcome]++;
  const acc = READERS.filter((r) => v[r].outcome === 'accept'), rej = READERS.filter((r) => v[r].outcome === 'reject');
  perCase.push({ id: c.id, cls: c.cls, expect: c.expect, ...Object.fromEntries(READERS.map((r) => [r, v[r].outcome + (v[r].code ? `:${v[r].code}` : '')])) });
  for (const r of rej) if (v[r].code === 'crash') {
    // a reader that throws something other than its own rejection error: fail-closed, but a robustness bug unless documented
    const k = (known.crashes ?? []).find((x) => x.reader === r && new RegExp(x.msg).test(v[r].msg));
    if (k) { crashes[k.id] = (crashes[k.id] ?? 0) + 1; v[r] = { ...v[r], code: 'crash-documented' }; } else failures.push(`CRASH ${c.id} (${c.note}): ${r}: ${v[r].msg}`);
  }
  for (const r of acc) {
    for (const [p] of v[r].files) { const pr = pathProblem(p); if (pr) failures.push(`SAFETY ${c.id}: ${r} accepted unsafe path ${JSON.stringify(p)} (${pr})`); }
    const col = collisions(v[r].files.map((f) => f[0])); if (col) failures.push(`SAFETY ${c.id}: ${r} accepted colliding paths: ${col}`);
  }
  if (acc.length > 1 && new Set(acc.map((r) => fileKey(v[r]))).size > 1)
  {
    const oh = openContent(c), what = `${c.id} (${c.note}): readers ${acc.join('+')} accepted different content: ${acc.map((r) => `${r}=${v[r].files.map((f) => f[1].slice(0, 8)).join('/')}`).join(', ')}`;
    if (oh) { (openFound[oh.id] ??= []).push(c.id); usedKnown.set(oh.id, usedKnown.get(oh.id) + 1); } else failures.push(`CONTENT ${what}`);
  }
  const k0 = acc.length && rej.length ? rule(c, acc, rej, v) : undefined;
  if (c.expect === 'reject' && acc.length && !(k0 && k0.waiveExpect)) failures.push(`UNSAFE-ACCEPT ${c.id} (${c.note}): accepted by ${acc.join(', ')}`);
  if (c.expect === 'accept' && !acc.length) failures.push(`VALID-REJECTED ${c.id} (${c.note}): rejected by all (${READERS.map((r) => v[r].code).join(', ')})`);
  if (acc.length && rej.length) {
    const codes = rej.map((r) => v[r].code);
    const k = k0, oh = k ? undefined : openRule(c, acc, rej, v);
    const policy = codes.some((x) => POLICY.has(x));
    if (oh) { (openFound[oh.id] ??= []).push(c.id); usedKnown.set(oh.id, usedKnown.get(oh.id) + 1); }
    else if (!k) failures.push(`${policy ? 'SECURITY-DIVERGENCE' : 'UNDOCUMENTED-DIVERGENCE'} ${c.id} [${c.cls}] (${c.note}): accept=${acc.join('+')} reject=${rej.map((r) => `${r}:${v[r].code}`).join('+')}`);
    else {
      usedKnown.set(k.id, usedKnown.get(k.id) + 1);
      if (policy && !k.allowPolicy) failures.push(`SECURITY-DIVERGENCE ${c.id} [${c.cls}]: known entry ${k.id} covers a policy rejection (${codes.join(',')}) but does not set allowPolicy`);
      divergences.push({ id: c.id, rule: k.id });
    }
  } else if (acc.length) agreeAccept++; else agreeReject++;
}
const openCount = Object.values(openFound).reduce((n, a) => n + a.length, 0);
for (const [id, n] of usedKnown) if (n === 0) console.log(`note: known divergence ${id} matched nothing in this corpus`);

// ---------------------------------------------------------------- report
const byRule = {};
for (const d of divergences) byRule[d.rule] = (byRule[d.rule] ?? 0) + 1;
console.log(`\nper-reader verdicts (accept/reject):`);
for (const r of READERS) console.log(`  ${r.padEnd(8)} ${tally[r].accept} / ${tally[r].reject}`);
console.log(`agreement: all accept ${agreeAccept}, all reject ${agreeReject}, documented divergences ${divergences.length}`);
for (const [id, n] of Object.entries(byRule)) console.log(`  ${String(n).padStart(4)}  ${id}`);
if (openCount) {
  console.log(`\nOPEN SECURITY GAPS (documented in known-divergences.json openHoles, fix pending in the owning task): ${openCount} zips`);
  for (const [id, ids] of Object.entries(openFound)) console.log(`  ${id}: ${ids.length} zip(s), e.g. ${ids.slice(0, 3).join(', ')}`);
}
for (const [id, n] of Object.entries(crashes)) console.log(`  ${String(n).padStart(4)}  documented crash: ${id}`);
for (const f of runnerFailures) console.log(`\nRUNNER FAILURE: ${f}`);
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ corpus: cases.length, openHoles: openFound, seed: useSeed, iters, tally, agreeAccept, agreeReject, divergences: byRule, failures, perCase }, null, 1));
if (arg('--json') !== undefined || argv.includes('--json')) console.log(JSON.stringify({ corpus: cases.length, tally, divergences: byRule, failures: failures.length }));
if (openCount && !allowOpen) failures.push(`${openCount} zip(s) hit a documented OPEN security gap (pass --allow-open-holes to accept them until the owning task lands the fix)`);
if (failures.length || runnerFailures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures.slice(0, 200)) console.log(`  ${f}`);
  if (failures.length > 200) console.log(`  ... ${failures.length - 200} more (see ${join(outDir, 'results.json')})`);
  console.log(`\nfull results: ${join(outDir, 'results.json')}`);
  process.exit(1);
}
console.log(`OK: ${cases.length} zips, no undocumented divergence, no content or safety violation`);
if (!keep && !argv.includes('--out')) rmSync(work, { recursive: true, force: true });
