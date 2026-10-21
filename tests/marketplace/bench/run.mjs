#!/usr/bin/env node
// Marketplace performance harness (Plan 4 Task 15). Real code, no mocks: the compiled desktop installer/lockfile modules
// (apps/desktop/out, so run `cd apps/desktop && node build/next/index.ts transpile` first) against a generated 200-item
// installed set, and the accounts-sync dev server (embedded Postgres, seed data + 30 bulk listings) for the API side.
//
//   node scripts/dev/marketplace-bench/run.mjs [--strict] [--init-budgets] [--check] [--no-server | --server-url <url>]
//        [--runs 15] [--warmup 3] [--requests 120] [--items 200]
//
//   (default)        measure, compare with budgets.json, write docs/audits/2026-10-21-marketplace-perf.{md,json}
//   --check          same without writing the audit files
//   --strict         timing/memory budgets at 1.0x (default: budgets x noiseMultiplier from budgets.json, because this
//                    machine is shared) and never below noiseFloorMs (20 ms) for ms metrics; structural budgets are always exact
//   --init-budgets   write timing/memory budgets from THIS measurement as max(median x 1.5, max), rounded up, into budgets.json
//   --no-server      skip the API side (the structural and client budgets still run)
// Exit code: 0 all within budget, 1 a budget was exceeded (or a structural property broke), 2 the harness could not run.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, cpus, totalmem, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateInstalled, makeHome } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const OUT = join(repo, 'apps', 'desktop', 'out', 'vs');
const imp = (rel) => import(pathToFileURL(join(OUT, rel)).href);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ------------------------------------------------------------------------------------------------ child modes

if (flag('--child')) { await child(opt('--child'), opt('--home'), Number(opt('--items', '0'))); process.exit(0); }

async function child(mode, home, items) {
  const fs = (await import('node:fs')).promises;
  const calls = [];
  for (const key of Object.keys(fs)) {
    const orig = fs[key];
    if (typeof orig !== 'function') continue;
    fs[key] = function (...a) { calls.push({ fn: key, path: typeof a[0] === 'string' ? a[0] : '' }); return orig.apply(this, a); };
  }
  const net = []; const procs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { net.push(String(a[0])); return realFetch(...a); };
  const cp = (await import('node:child_process')).default;
  for (const k of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) { const o = cp[k]; cp[k] = (...a) => { procs.push(k); return o(...a); }; }
  const mem = () => { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed }; };
  const m0 = mem();
  const { MarketplaceInstaller } = await imp('platform/marketplace/node/marketplaceInstaller.js');
  const m1 = mem();
  process.env.AGENTICOFFICE_MARKETPLACE_HOME = home;
  const refuse = async () => { net.push('opts.fetch'); throw new Error('no network'); };
  // exactly what NativeMarketplaceInstallService passes (autoRecover with the 60 s deferral), minus the dialog/log wiring
  const svc = new MarketplaceInstaller({ home, autoRecover: true, autoRecoverDelayMs: 60_000, fetch: refuse, runHermes: async () => { procs.push('runHermes'); return { code: 1, stdout: '', stderr: '', timedOut: false }; }, log: () => undefined });
  await new Promise(r => setTimeout(r, 300));
  const atConstruction = { fs: calls.length, net: net.length, procs: procs.length };
  const m2 = mem();
  calls.length = 0;
  const list = await svc.installed();
  const m3 = mem();
  const store = calls.filter(c => c.path.includes('/store/'));
  const lock = calls.filter(c => c.fn === 'readFile' && c.path.endsWith('installed.lock.json'));
  console.log(JSON.stringify({ mode, items, installedCount: list.length, atConstruction, installed: { fsCalls: calls.length, storeFilesRead: store.length, lockfileReads: lock.length }, net: net.length, procs: procs.length, mem: { import: { rss: m1.rss - m0.rss, heap: m1.heapUsed - m0.heapUsed }, construct: { rss: m2.rss - m1.rss, heap: m2.heapUsed - m1.heapUsed }, installed: { rss: m3.rss - m2.rss, heap: m3.heapUsed - m2.heapUsed } } }));
}

// ------------------------------------------------------------------------------------------------ helpers

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const r3 = (x) => Math.round(x * 1000) / 1000;
async function timed(fn, { runs, warmup }) {
  for (let i = 0; i < warmup; i++) await fn();
  const t = [];
  for (let i = 0; i < runs; i++) { const a = performance.now(); await fn(); t.push(performance.now() - a); }
  return t;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ main

const RUNS = Number(opt('--runs', '15')), WARM = Number(opt('--warmup', '3')), REQS = Number(opt('--requests', '120')), ITEMS = Number(opt('--items', '200'));
if (!existsSync(join(OUT, 'platform/marketplace/node/marketplaceInstaller.js'))) {
  console.error('marketplace-bench: apps/desktop/out is missing; run `cd apps/desktop && node build/next/index.ts transpile` first.');
  process.exit(2);
}
const uptime = spawnSync('uptime', { encoding: 'utf8' }).stdout.trim();
const machine = { os: `${platform()} ${release()}`, cores: cpus().length, ramGb: Math.round(totalmem() / 2 ** 30), node: process.version, loadAverageAtStart: loadavg().map(r3), uptime };
const values = {};        // metric -> { value, unit, kind, samples? }
const noteT = (name, t, extra = {}) => note(name, median(t), 'ms', 'timing', { samples: t, ...extra });
const note = (name, value, unit, kind, extra = {}) => { values[name] = { value: r3(value), unit, kind, ...extra }; };

const cleanup = [];
let exit = 0;
try {
  const { readLockfileBytes, parseLockfile, normaliseItem } = await imp('platform/marketplace/node/lockfile.js');
  const { MarketplaceInstaller } = await imp('platform/marketplace/node/marketplaceInstaller.js');
  const { INITIAL_DELAY_MS } = await imp('workbench/contrib/marketplace/common/marketplaceReconcileSchedule.js');

  // ---- fixtures
  const home = makeHome(); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const fx = generateInstalled(home, ITEMS);
  const home0 = makeHome('mkt-bench-empty-'); cleanup.push(() => rmSync(home0, { recursive: true, force: true }));
  const home2k = makeHome('mkt-bench-2k-'); cleanup.push(() => rmSync(home2k, { recursive: true, force: true }));
  generateInstalled(home2k, 2000, { withStore: false });
  const lock = join(home, 'installed.lock.json'), lock2k = join(home2k, 'installed.lock.json');

  // ---- lockfile read + parse + normalise
  const parse = (p) => async () => parseLockfile(await readLockfileBytes(p)).items.map(normaliseItem);
  noteT(`lockfile.parse${ITEMS}.ms`, await timed(parse(lock), { runs: RUNS * 4, warmup: WARM * 2 }), { bytes: fx.lockfileBytes });
  noteT('lockfile.parse2000.ms', await timed(parse(lock2k), { runs: RUNS * 2, warmup: WARM }));

  // ---- installed() and reconcile planning (no network: fetch refuses)
  const noNet = async () => { throw new Error('offline'); };
  const mk = () => new MarketplaceInstaller({ home, fetch: noNet, runHermes: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }), deviceId: () => 'bench-device', log: () => undefined });
  const svc = mk();
  noteT(`installed${ITEMS}.ms`, await timed(() => svc.installed(), { runs: RUNS * 2, warmup: WARM }));
  const signed = { server: 'http://127.0.0.1:9', token: 'bench-token' };
  let rr;
  noteT(`reconcile${ITEMS}.offlineSignedIn.ms`, await timed(async () => { rr = await svc.reconcile(signed); }, { runs: RUNS, warmup: WARM }));
  if (!rr?.offline) throw new Error('reconcile did not take the offline path; the benchmark is not measuring what it claims');
  noteT(`reconcile${ITEMS}.offlineAnonymous.ms`, await timed(async () => { rr = await svc.reconcile({ server: signed.server }); }, { runs: RUNS, warmup: WARM }));

  // ---- structural + memory, in fresh child processes
  const runChild = (h, items) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child', 'startup', '--home', h, '--items', String(items)], { encoding: 'utf8', env: { ...process.env, AGENTICOFFICE_MARKETPLACE_HOME: h } }));
  const kids = Array.from({ length: 5 }, () => runChild(home, ITEMS));
  const kids0 = Array.from({ length: 5 }, () => runChild(home0, 0));
  const k = kids[0];
  if (k.installedCount !== ITEMS) throw new Error(`child saw ${k.installedCount} items, expected ${ITEMS}`);
  for (const kid of kids) {
    if (kid.atConstruction.net || kid.atConstruction.fs || kid.atConstruction.procs || kid.net || kid.procs) throw new Error('startup probe saw I/O: ' + JSON.stringify(kid));
  }
  note('startup.networkCalls', Math.max(...kids.map(x => x.atConstruction.net + x.net)), 'count', 'structural');
  note('startup.fsCallsAtConstruction', Math.max(...kids.map(x => x.atConstruction.fs)), 'count', 'structural');
  note('startup.processesSpawned', Math.max(...kids.map(x => x.atConstruction.procs + x.procs)), 'count', 'structural');
  note('startup.storeFilesRead', 0, 'count', 'structural'); // construction touched no file at all (above); installed() is checked next
  note('installed.storeFilesRead', Math.max(...kids.map(x => x.installed.storeFilesRead)), 'count', 'structural');
  note('lockfile.readsForInstalled', Math.max(...kids.map(x => x.installed.lockfileReads)), 'count', 'structural');
  note('reconcileSchedule.initialDelayMs', INITIAL_DELAY_MS, 'ms', 'structural');
  const MB = 1024 * 1024;
  note('memory.moduleImport.heapMB', median(kids.map(x => x.mem.import.heap)) / MB, 'MB', 'memory', { note: 'heapUsed growth from importing the installer, lockfile and adapters modules' });
  note(`memory.installed${ITEMS}.heapDeltaMB`, (median(kids.map(x => x.mem.installed.heap + x.mem.construct.heap)) - median(kids0.map(x => x.mem.installed.heap + x.mem.construct.heap))) / MB, 'MB', 'memory', { note: `heapUsed for constructing the service and calling installed() with ${ITEMS} items minus the same with 0 items` });
  note(`memory.installed${ITEMS}.rssDeltaMB`, (median(kids.map(x => x.mem.installed.rss + x.mem.construct.rss)) - median(kids0.map(x => x.mem.installed.rss + x.mem.construct.rss))) / MB, 'MB', 'memory', { note: 'RSS is page-granular and noisy: informational, not budgeted' , informational: true });

  // ---- API side
  if (!flag('--no-server')) await serverBench();

  // ---- budgets
  const budgetsPath = join(here, 'budgets.json');
  const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  budgets.timing ??= {};
  if (flag('--init-budgets')) {
    for (const [name, v] of Object.entries(values)) {
      if (v.kind === 'structural' || v.informational) continue;
      const m = v.samples ? Math.max(...v.samples) : v.value;
      const budget = Math.ceil(Math.max(v.value * 1.5, m) * 100) / 100 || 0.01;
      budgets.timing[name] = { budget, unit: v.unit, measured: { median: v.value, max: r3(m), n: v.samples?.length ?? RUNS, loadAverageAtStart: machine.loadAverageAtStart[0] }, why: 'max(median x 1.5, max) of the first measurement, taken on a loaded shared machine (see machine.loadAverageAtStart); a later run compares its median against this x noiseMultiplier.' };
    }
    writeFileSync(budgetsPath, JSON.stringify(budgets, null, 2) + '\n');
    console.log('wrote timing/memory budgets to', budgetsPath);
  }
  const mult = flag('--strict') ? 1 : budgets.noiseMultiplier ?? 2;
  const rows = [];
  for (const [name, b] of Object.entries(budgets.structural)) {
    const v = values[name];
    if (!v) { if (flag('--no-server')) continue; rows.push({ name, kind: 'structural', status: 'MISSING', budget: b.budget }); continue; }
    const ok = b.cmp === 'gte' ? v.value >= b.budget : v.value <= b.budget;
    rows.push({ name, kind: 'structural', value: v.value, unit: v.unit, budget: b.budget, effective: b.budget, cmp: b.cmp ?? 'lte', status: ok ? 'PASS' : 'FAIL' });
  }
  for (const [name, v] of Object.entries(values)) {
    if (v.kind === 'structural' || v.informational) continue;
    const b = budgets.timing[name];
    if (!b) { rows.push({ name, kind: v.kind, value: v.value, unit: v.unit, status: 'NO-BUDGET' }); continue; }
    const floor = flag('--strict') || v.unit !== 'ms' ? 0 : budgets.noiseFloorMs ?? 0; // sub-10 ms medians move by multiples under scheduler load
    const eff = Math.max(b.budget * mult, floor);
    rows.push({ name, kind: v.kind, value: v.value, unit: v.unit, budget: b.budget, effective: r3(eff), status: v.value <= eff ? 'PASS' : 'FAIL' });
  }
  for (const [name, b] of Object.entries(budgets.timing)) if (!values[name] && !flag('--no-server')) rows.push({ name, kind: 'timing', status: 'MISSING', budget: b.budget });
  const failed = rows.filter(r => r.status === 'FAIL' || r.status === 'MISSING');
  const unbudgeted = rows.filter(r => r.status === 'NO-BUDGET');
  for (const r of rows) console.log(`${r.status.padEnd(9)} ${r.name.padEnd(42)} ${r.value ?? '-'} ${r.unit ?? ''}  (budget ${r.budget ?? '-'}${r.effective !== undefined && r.effective !== r.budget ? `, effective ${r.effective}` : ''})`);
  console.log(`load average at start ${machine.loadAverageAtStart.join(' ')}; at end ${loadavg().map(r3).join(' ')}; multiplier ${mult}${flag('--strict') ? ' (strict)' : ''}`);
  if (failed.length) { console.error(`${failed.length} budget(s) exceeded or missing`); exit = 1; }
  if (unbudgeted.length) console.warn(`${unbudgeted.length} metric(s) have no budget yet (run with --init-budgets after a trusted measurement)`);

  const result = { task: 'marketplace plan 4 task 15', date: new Date().toISOString().slice(0, 10), machine: { ...machine, loadAverageAtEnd: loadavg().map(r3) }, mode: { strict: flag('--strict'), multiplier: mult, runs: RUNS, warmup: WARM, requests: REQS, items: ITEMS }, metrics: Object.fromEntries(Object.entries(values).map(([n, v]) => [n, { value: v.value, unit: v.unit, kind: v.kind, ...(v.samples ? { n: v.samples.length, max: r3(Math.max(...v.samples)) } : {}), ...(v.note ? { note: v.note } : {}), ...(v.informational ? { informational: true } : {}) }])), results: rows, ok: exit === 0 };
  if (!flag('--check')) {
    const dir = join(repo, 'docs', 'audits'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10-21-marketplace-perf.json'), JSON.stringify(result, null, 2) + '\n');
    writeFileSync(join(dir, '2026-10-21-marketplace-perf.md'), render(result));
    console.log('wrote docs/audits/2026-10-21-marketplace-perf.{md,json}');
  }
} catch (e) {
  console.error('marketplace-bench:', e?.stack ?? e);
  exit = 2;
} finally {
  for (const c of cleanup) try { c(); } catch { /* ignore */ }
}
process.exit(exit);

// ------------------------------------------------------------------------------------------------ API side

async function serverBench() {
  let base = opt('--server-url'), proc, stateFile;
  if (!base) {
    const dir = makeHome('mkt-bench-srv-'); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    stateFile = join(dir, 'state.json');
    const port = 8794 + Math.floor(Math.random() * 100);
    proc = spawn(process.execPath, ['scripts/marketplace-dev-server.ts', '--http', '--bulk', '30', '--port', String(port), '--state', stateFile], { cwd: join(repo, 'services', 'accounts-sync'), stdio: ['ignore', 'ignore', 'pipe'] });
    cleanup.push(() => { try { proc.kill('SIGTERM'); } catch { /* gone */ } });
    let err = ''; proc.stderr.on('data', d => { err += d; });
    const t0 = Date.now();
    while (!existsSync(stateFile)) {
      if (proc.exitCode !== null) throw new Error('dev server exited early: ' + err.slice(-400));
      if (Date.now() - t0 > 420_000) throw new Error('dev server did not start in 420 s');
      await sleep(500);
    }
    await sleep(200);
    base = JSON.parse(readFileSync(stateFile, 'utf8')).url;
    console.log(`dev server up in ${Math.round((Date.now() - t0) / 1000)} s at ${base}`);
  }
  const B = `${base.replace(/\/$/, '')}/v1/marketplace`;
  const auth = { authorization: 'Bearer dev-token' };
  let limited = 0;
  const get = async (path, headers = {}) => {
    for (;;) {
      const a = performance.now();
      const r = await fetch(`${B}/${path}`, { headers });
      const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer();
      const ms = performance.now() - a;
      if (r.status === 429) { limited++; await sleep((Number(r.headers.get('retry-after')) || 1) * 1000 + 100); continue; }
      return { ms, status: r.status, body };
    }
  };
  // first paint of the catalog: the first page request on a cold server, then warm
  const cold = await get('listings?limit=24');
  if (cold.status !== 200 || cold.body.items.length < 24) throw new Error(`first page has ${cold.body?.items?.length} items (status ${cold.status}); need a 24-item page (is --bulk 30 seeded?)`);
  note('server.list24.coldFirstRequest.ms', cold.ms, 'ms', 'timing', { informational: true, note: 'first request after server start, includes connection setup' });
  const verId = cold.body.items.find(i => i.previews > 0)?.latestVersionId;
  const lid = cold.body.items[0].id;
  const series = async (name, path, n, headers) => {
    for (let i = 0; i < 3; i++) await get(path(i), headers); // warmup (counts against the read limiter: 300/min per client)
    const t = []; for (let i = 0; i < n; i++) { const r = await get(path(i), headers); if (r.status !== 200) throw new Error(`${name}: status ${r.status}`); t.push(r.ms); }
    note(`server.${name}.p50.ms`, median(t), 'ms', 'timing', { samples: t });
    note(`server.${name}.p95.ms`, pct(t, 0.95), 'ms', 'timing', { samples: [pct(t, 0.95)] });
  };
  await series('list24', () => 'listings?limit=24', REQS);
  await series('search', (i) => `listings?q=${['memo', 'outline', 'board', 'style', 'copy'][i % 5]}&limit=24`, Math.round(REQS / 3));
  await series('detail', () => `listings/${lid}`, Math.round(REQS / 4));
  await series('preview', () => `versions/${verId}/preview/0`, Math.round(REQS / 4));
  await series('compare', () => `listings/${lid}/compare?base=${verId}&head=${verId}`, Math.round(REQS / 6), auth);
  note('server.rateLimited429', limited, 'count', 'timing', { informational: true, note: 'requests answered 429 and retried after Retry-After (the in-process read limiter allows 300/min per client); retried requests are not in the samples' });
}

// ------------------------------------------------------------------------------------------------ report

function render(r) {
  const L = [];
  L.push('# Marketplace performance (Plan 4, Task 15), 2026-10-21', '');
  L.push(`Machine: ${r.machine.os}, ${r.machine.cores} cores, ${r.machine.ramGb} GB, node ${r.machine.node}. **Shared with other agents: timings are upper bounds.**`);
  L.push(`Load average (1/5/15 min) at start: ${r.machine.loadAverageAtStart.join(' / ')}; at end: ${r.machine.loadAverageAtEnd.join(' / ')}.`);
  L.push(`\`uptime\`: ${r.machine.uptime}`, '');
  L.push(`Run: ${r.mode.runs} measured runs after ${r.mode.warmup} warm-up runs (medians), ${r.mode.requests} list requests, ${r.mode.items}-item synthetic installed set, ${r.mode.strict ? 'strict (budgets x1)' : `noise multiplier x${r.mode.multiplier}`}. Result: **${r.ok ? 'within budget' : 'BUDGET EXCEEDED'}**.`);
  L.push('Machine-readable copy: [2026-10-21-marketplace-perf.json](2026-10-21-marketplace-perf.json). Budgets and their justification: `scripts/dev/marketplace-bench/budgets.json`.', '');
  L.push('| Metric | Kind | Measured | Budget | Effective limit | Result |', '|---|---|---|---|---|---|');
  for (const x of r.results) L.push(`| \`${x.name}\` | ${x.kind} | ${x.value ?? '-'} ${x.unit ?? ''} | ${x.budget ?? '-'} | ${x.effective ?? '-'} | ${x.status} |`);
  const info = Object.entries(r.metrics).filter(([, m]) => m.informational);
  if (info.length) { L.push('', 'Informational (not budgeted):', ''); for (const [n, m] of info) L.push(`- \`${n}\`: ${m.value} ${m.unit}${m.note ? ` (${m.note})` : ''}`); }
  L.push('', '## What each number is', '',
    '- `lockfile.parse*`: read `installed.lock.json` + `parseLockfile` + `normaliseItem` on every entry (the real modules).',
    '- `installed200`: `MarketplaceInstaller.installed()` on a throwaway `AGENTICOFFICE_MARKETPLACE_HOME` with 200 items (150 skills with `store/<sha>/SKILL.md`, 50 templates).',
    '- `reconcile200.offline*`: `reconcile()` planning cost with no network (the fetch refuses): recovery pass (journal, store sweep), lockfile read, device lookup, request construction. Server cost is not included.',
    '- `startup.*` and `installed.storeFilesRead`: structural, measured in a fresh child process with `fs.promises`, `fetch` and `child_process` instrumented. Construction uses exactly the options `NativeMarketplaceInstallService` passes (autoRecover with the 60 s deferral).',
    '- `memory.*`: `process.memoryUsage()` deltas in fresh children (median of 5), 200 items minus 0 items.',
    '- `server.*`: wall time of one HTTP request including body read and JSON parse, against `services/accounts-sync/scripts/marketplace-dev-server.ts --http --bulk 30` (embedded Postgres, 34 listings). `list24` is the first catalog page (24 items) and is the closest thing to first paint that can be measured without a window; the DOM first paint is covered by the real-window flow (Task 16).',
    '', '## Renderer startup (audited, not timed)', '',
    'Checked by `apps/desktop/src/vs/workbench/contrib/marketplace/test/node/marketplaceLazyLoading.test.ts`: the background reconcile registers in `WorkbenchPhase.Eventually`, its constructor only arms a 30 s timer and focus/online listeners, `MarketplaceService` is a delayed singleton with an empty constructor, nothing statically reachable imports node or main-process modules, and the Templates gallery merge reads only `installed()`. The lockfile is first read when the 30 s timer fires with a configured marketplace (`session()` then `installed()`), or when the Marketplace tab or gallery asks.');
  L.push('');
  return L.join('\n');
}
