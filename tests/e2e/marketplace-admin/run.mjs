#!/usr/bin/env node
// The marketplace admin console, end to end, against the REAL accounts-sync admin API on a REAL Postgres. NOT wired into CI.
//
//   node scripts/e2e/marketplace-admin/run.mjs [--out <dir>] [--keep-going]
//
// Starts (all on loopback, all torn down when the run ends, pass or fail):
//   1. a throwaway docker pgvector/pgvector:pg17 on a free port, migrations 0001-latest applied with all five role passwords set;
//   2. services/accounts-sync/scripts/marketplace-admin-e2e-server.ts: the real admin handlers (admin.ts + marketplace-admin.ts) with the real
//      service-token authentication, the real role map and the real validators (in-memory artifact store; only differences from main.ts);
//   3. the control-plane (`next start`, production build) pointed at it, signed in through the console's own signed session cookie;
//   4. a private headless Chrome on a free debug port (never 9351, 9361 or 9399), driven over CDP: real clicks, real form posts.
// It then drives the review, ack, halt, type policy, verification and analyst flows, screenshots each step into --out, and checks
// admin_audit in the database after every mutation. Exit code 0 only if every step passed.
//
// Needs: docker, Google Chrome (AO_E2E_CHROME to override), node 24, python3 for the skill scanner (AO_E2E_PYTHON), npm deps installed in
// services/accounts-sync, and services/control-plane with a real node_modules (a symlink breaks turbopack). The control-plane is built
// (`next build`) when it has no .next.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const sync = join(repo, 'services', 'accounts-sync');
const cp = join(repo, 'services', 'control-plane');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(opt('--out', join(tmpdir(), `ao-mp-admin-e2e-${Date.now()}`)));
mkdirSync(OUT, { recursive: true });
const requireSync = createRequire(join(sync, 'package.json'));
const pg = requireSync('pg');
const { zipSync, strToU8 } = requireSync('fflate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const FORBIDDEN_PORTS = new Set([9351, 9361, 9399]);

// ───────────────────────────────────────────── lifecycle: everything started is torn down
const children = []; let container = null; const tmpDirs = [];
let tornDown = false;
function teardown() {
  if (tornDown) return; tornDown = true;
  for (const c of children.reverse()) { try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
  if (container) { try { execFileSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore' }); } catch { /* gone */ } }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
}
process.on('exit', teardown);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { teardown(); process.exit(130); });

const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => (FORBIDDEN_PORTS.has(p) ? freePort().then(res, rej) : res(p))); }); s.on('error', rej);
});
function start(cmd, argv, o) {
  const c = spawn(cmd, argv, { ...o, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const logFile = join(OUT, `${o.name}.log`); writeFileSync(logFile, '');
  const append = (d) => { try { writeFileSync(logFile, d, { flag: 'a' }); } catch { /* ignore */ } };
  c.stdout.on('data', append); c.stderr.on('data', append);
  children.push(c); return c;
}
async function waitFor(fn, what, ms = 60_000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

// ───────────────────────────────────────────── results
const results = []; let shot = 0;
async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); log(`  ok    ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); log(`  FAIL  ${name}\n        ${e.message}`); await screenshot(`FAIL-${name}`).catch(() => {}); if (!args.includes('--keep-going')) throw e; }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ───────────────────────────────────────────── a small CDP client
let ws, msgId = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 30_000) {
  return new Promise((res, rej) => {
    const id = ++msgId; const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, timeout);
    pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
let base = '';
async function goto(path) {
  await cdp('Page.navigate', { url: base + path });
  await waitFor(async () => (await evaluate('document.readyState')) === 'complete' && (await evaluate('location.pathname + location.search')).startsWith(path.split('?')[0]), `load ${path}`);
  await sleep(400);   // hydration
}
const url = () => evaluate('location.pathname + location.search');
const text = () => evaluate('document.body.innerText');
async function screenshot(name) {
  const file = join(OUT, `${String(++shot).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '_')}.png`);
  // the console scrolls inside a fixed-height shell, so grow the viewport to the tallest scroll area, then put it back
  await waitFor(async () => (await evaluate('document.readyState')) === 'complete', 'page to settle before a screenshot', 15_000);
  const h = Math.ceil(Math.min(Math.max(1000, Number(await evaluate(`Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 4 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY) && e.clientHeight > 300).map((e) => e.scrollHeight + e.getBoundingClientRect().top))`)) || 1000), 5000));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(250);
  try { const r = await cdp('Page.captureScreenshot', { format: 'png' }, 60_000); writeFileSync(file, Buffer.from(r.data, 'base64')); }
  finally { await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); }
  return file;
}
async function mark(finder) {   // finder: JS expression returning an element; tags it and returns its centre after scrolling it into view
  const box = await evaluate(`(() => { const el = (${finder}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!el.disabled }; })()`);
  return box;
}
async function click(finder, what) {
  const box = await mark(finder); must(box, `nothing to click: ${what}`); must(!box.disabled, `${what} is disabled`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const byText = (sel, t) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(t)})`;
const openDialog = `document.querySelector('dialog[open]')`;
async function type(finder, value, what) {
  await evaluate(`(() => { const el = (${finder}); el.scrollIntoView({ block: 'center' }); el.focus(); el.select?.(); })()`);
  await cdp('Input.insertText', { text: value }); await sleep(100); must(await evaluate(`(${finder}).value === ${JSON.stringify(value)}`), `typing into ${what} did not stick`);
}
const isDisabled = (finder) => evaluate(`!!(${finder})?.disabled`);
const flash = async () => evaluate(`(() => { const u = new URL(location.href); return { msg: u.searchParams.get('msg'), err: u.searchParams.get('err') }; })()`);
async function afterSubmit() {   // a server action posts, redirects, and the outcome is in the address
  await waitFor(async () => { const f = await flash(); return f.msg || f.err; }, 'the action outcome in the address', 40_000);
  await sleep(500); return flash();
}
const mutatingControls = () => evaluate(`(() => {
  const posts = (f) => !!f.querySelector('input[name^="$ACTION"]') || f.method === 'post';
  const inForm = [...document.querySelectorAll('main form')].filter(posts).flatMap((f) => [...f.querySelectorAll('button, textarea, select, input:not([type=hidden])')]);
  const openers = [...document.querySelectorAll('main button[type=button]')].filter((e) => !e.closest('form') && !e.closest('dialog'));
  return [...inForm, ...openers].map((e) => (e.textContent || e.name || e.tagName).trim().slice(0, 40));
})()`);

// ───────────────────────────────────────────── database
let owner;
const q = async (sql, params = []) => (await owner.query(sql, params)).rows;
const auditRows = (since, action) => q(`SELECT admin_user_id, action, detail FROM admin_audit WHERE id > $1 AND action = $2 ORDER BY id`, [since, action]);
const auditMax = async () => Number((await q('SELECT COALESCE(max(id), 0) AS m FROM admin_audit'))[0].m);

// ───────────────────────────────────────────── the admin API as a person (for seeding and for the analyst refusals)
let apiBase = ''; const SVC = 'e2e-console-service-token-0123456789';
async function api(path, { acting, method, body, zip } = {}) {
  const headers = { authorization: `Bearer ${SVC}`, ...(acting ? { 'x-ao-acting-admin': acting } : {}) };
  if (zip) headers['content-type'] = 'application/zip'; else if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(apiBase + path, { method: method ?? (zip || body !== undefined ? 'POST' : 'GET'), headers, body: zip ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let json; try { json = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json, text: t };
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
function zipOf(manifest, files) {
  const full = { ...manifest, files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha(b), size: b.length })) };
  return zipSync({ 'agentic.marketplace.json': strToU8(JSON.stringify(full)), ...files });
}
const skillZip = (id, title) => {
  const name = id.split('/')[1];
  return zipOf({ schema: 'agentic.marketplace/1', id, type: 'skill', version: '1.0.0', title, summary: `${title}: a plain documentation skill.`, license: 'MIT', compat: { app: '*' }, dependencies: [], permissions: [], payload: { entry: 'SKILL.md', name } },
    { 'SKILL.md': strToU8(`---\nname: ${name}\ndescription: ${title} for short decision memos.\n---\n\n# ${title}\n\nDecision first, then summary, plan, risks and next steps.\n\nSee [checklist](references/checklist.md).\n`), 'references/checklist.md': strToU8('# Checklist\n\n- Decision\n- Risks\n') });
};

// ───────────────────────────────────────────── main
const PEOPLE = { usr_sub: 'engineer', usr_rev: 'engineer', usr_rev2: 'engineer', usr_sup: 'superadmin', usr_ana: 'analyst' };
let sessionMod;
async function signInAs(user) {
  const value = sessionMod.newSession({ id: user, email: `${user}@e2e.test`, name: user });
  await cdp('Network.clearBrowserCookies');
  await cdp('Network.setCookie', { name: sessionMod.SESSION_COOKIE, value, url: base, httpOnly: true });
}

async function main() {
  // preflight
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); } catch { throw new Error('docker is not running'); }
  const CHROME = process.env.AO_E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  must(existsSync(CHROME), `no Chrome at ${CHROME} (set AO_E2E_CHROME)`);
  must(existsSync(join(sync, 'node_modules')), 'run npm ci in services/accounts-sync first');
  must(existsSync(join(cp, 'node_modules', 'next')), 'services/control-plane has no node_modules: run npm ci there (a symlink breaks turbopack)');
  const env0 = { ...process.env }; delete env0.NODE_OPTIONS;

  // 1. Postgres in docker, all five role passwords
  const pgPort = await freePort();
  const pw = { AO_APP_PASSWORD: 'e2e-app-pw', AO_READONLY_PASSWORD: 'e2e-readonly-pw', AO_ADMIN_PASSWORD: 'e2e-admin-pw', AO_AUTH_PASSWORD: 'e2e-auth-pw', AO_BILLING_PASSWORD: 'e2e-billing-pw' };
  container = `ao-mp-admin-e2e-${process.pid}`;
  execFileSync('docker', ['run', '-d', '--name', container, '-e', 'POSTGRES_USER=ao_owner', '-e', 'POSTGRES_PASSWORD=e2e-owner-pw', '-e', 'POSTGRES_DB=agentic_office', '-p', `127.0.0.1:${pgPort}:5432`, 'pgvector/pgvector:pg17'], { stdio: 'ignore' });
  log(`postgres ${container} on 127.0.0.1:${pgPort}`);
  const dburl = `postgres://ao_owner:e2e-owner-pw@127.0.0.1:${pgPort}/agentic_office`;
  await waitFor(async () => { const c = new pg.Client({ connectionString: dburl }); try { await c.connect(); await c.query('SELECT 1'); return true; } finally { await c.end().catch(() => {}); } }, 'postgres', 90_000);
  await sleep(1500);   // the image restarts once after init
  await waitFor(async () => { const c = new pg.Client({ connectionString: dburl }); try { await c.connect(); await c.query('SELECT 1'); return true; } finally { await c.end().catch(() => {}); } }, 'postgres after init', 60_000);
  const mig = execFileSync('node', ['db/migrate.ts'], { cwd: sync, env: { ...env0, DATABASE_URL: dburl, ...pw }, encoding: 'utf8' });
  const applied = (mig.match(/^applied /gm) ?? []).length;
  must(applied >= 30, `expected migrations 0001-0030 applied, saw ${applied}`);
  owner = new pg.Client({ connectionString: dburl }); await owner.connect();
  log(`migrations applied: ${applied}`);

  // people and a publisher (the console's admin sign-in itself is Keycloak's job and is not under test here)
  for (const [id, role] of Object.entries(PEOPLE)) {
    await q(`INSERT INTO users(id, email, role, display_name) VALUES ($1, $2, 'admin', $1)`, [id, `${id}@e2e.test`]);
    await q(`INSERT INTO admin_roles(user_id, role) VALUES ($1, $2)`, [id, role]);
  }
  await q(`INSERT INTO users(id, email) VALUES ('usr_pub', 'pub@e2e.test'), ('usr_dev', 'dev@e2e.test')`);
  await q(`INSERT INTO devices(id, user_id) VALUES ('dev-device', 'usr_dev')`);
  await q(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme', 'Acme', 'usr_pub', true)`);

  // 2. the real admin API
  const apiPort = await freePort(); apiBase = `http://127.0.0.1:${apiPort}`;
  const roles = ['console:superadmin', ...Object.entries(PEOPLE).map(([k, v]) => `${k}:${v}`)].join(',');
  start('node', ['scripts/marketplace-admin-e2e-server.ts', '--port', String(apiPort), '--state', join(OUT, 'api-state.json')], {
    name: 'accounts-sync', cwd: sync, env: { ...env0, PG_PORT: String(pgPort), ...pw, AO_ADMIN_TOKENS: `console:${SVC}`, AO_MARKETPLACE_ROLES: roles, AO_E2E_PYTHON: process.env.AO_E2E_PYTHON || 'python3' } });
  await waitFor(async () => (await fetch(`${apiBase}/healthz`)).ok, 'accounts-sync admin API');
  log(`admin API ${apiBase}`);

  // 3. the control-plane, production build
  if (!existsSync(join(cp, '.next', 'BUILD_ID'))) { log('building the control-plane (next build)...'); execFileSync('npx', ['next', 'build'], { cwd: cp, env: { ...env0, NEXT_TELEMETRY_DISABLED: '1' }, stdio: 'ignore' }); }
  const cpPort = await freePort(); base = `http://localhost:${cpPort}`;
  const authSecret = 'e2e-auth-secret-0123456789abcdef0123456789';
  process.env.AUTH_SECRET = authSecret;   // the signed session cookie below is minted with the console's own code
  sessionMod = await import(pathToFileURL(join(cp, 'src', 'lib', 'keycloak.ts')).href);
  start(join(cp, 'node_modules', '.bin', 'next'), ['start', '-p', String(cpPort), '-H', '127.0.0.1'], {
    name: 'control-plane', cwd: cp, env: { ...env0, NEXT_TELEMETRY_DISABLED: '1', AUTH_SECRET: authSecret, AUTH_BASE_URL: base, KEYCLOAK_ISSUER: 'http://127.0.0.1:9/realms/none', KEYCLOAK_CONSOLE_SECRET: 'unused-in-this-run',
      AO_ADMIN_API_URL: apiBase, AO_ADMIN_API_TOKEN: SVC, ADMIN_HOSTS: 'localhost,127.0.0.1' } });
  await waitFor(async () => (await fetch(`${base}/admin/login`, { redirect: 'manual' })).status > 0, 'control-plane', 90_000);
  log(`control-plane ${base}`);

  // seed through the real admin API, as people (submitter, reviewer, superadmin)
  const seed = await seedPackages();

  // 4. private headless Chrome
  const chromePort = await freePort(); const udd = mkdtempSync(join(tmpdir(), 'ao-mp-admin-chrome-')); tmpDirs.push(udd);
  start(CHROME, ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'], { name: 'chrome' });
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((t) => t.type === 'page'), 'chrome');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp(m);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  log(`chrome on :${chromePort}\n`);

  await flows(seed);
}

async function seedPackages() {
  const { advancedSeeds } = await import(pathToFileURL(join(sync, 'scripts', 'dev-seed', 'advanced.ts')).href);
  const submit = async (as, zip) => {
    const r = await api('/admin/marketplace/submissions?publisher=acme&visibility=public', { acting: as, zip });
    must(r.status === 201 && r.json.validation?.ok, `seed submit failed: ${r.status} ${r.text.slice(0, 300)}`); return r.json;
  };
  const out = {};
  out.memo = await submit('usr_sub', skillZip('acme/memo-style', 'Memo Style'));
  out.notes = await submit('usr_sub', skillZip('acme/outline-notes', 'Outline Notes'));
  for (const s of advancedSeeds({})) {
    const built = zipOf({ ...s.manifest, id: s.manifest.id.replace('dev-advanced/', 'acme/') }, s.files);
    out[s.manifest.type] = await submit('usr_sub', built);
  }
  for (const t of ['memory', 'hook']) {   // published through the real flow, by two other people, so there is something live to halt
    const v = out[t];
    let r = await api(`/admin/marketplace/versions/${v.versionId}/approve`, { acting: 'usr_rev', body: { ack_summary_sha256: v.summarySha256 } });
    must(r.status === 200, `seed approve ${t}: ${r.status} ${r.text.slice(0, 300)}`);
    r = await api(`/admin/marketplace/versions/${v.versionId}/publish`, { acting: 'usr_sup', body: {} });
    must(r.status === 200, `seed publish ${t}: ${r.status} ${r.text.slice(0, 300)}`);
  }
  log(`seeded: ${Object.entries(out).map(([k, v]) => `${k}=${v.versionId}`).join(' ')}`);
  return out;
}

const catalogIds = async () => {   // what a signed-in client is served
  const r = await fetch(`${apiBase}/v1/marketplace/listings?limit=100`, { headers: { authorization: 'Bearer dev-token' } });
  const j = await r.json(); return (j.items ?? j.listings ?? []).map((l) => l.id);
};

async function flows(seed) {
  log('flows');
  // ---- (a) a reviewer approves a version
  await signInAs('usr_rev');
  await step('a. reviewer opens the review queue and sees the submissions', async () => {
    await goto('/admin/marketplace/review'); await screenshot('a-queue');
    const t = await text(); must(t.includes('Memo Style') && t.includes('Outline Notes'), 'queue does not list the submitted skills');
  });
  await step('a. reviewer approves a plain version (no manual review) from the queue', async () => {
    const id = seed.memo.versionId, mark0 = await auditMax();
    await click(`[...document.querySelector('a[href="/admin/marketplace/review/${id}"]').closest('tr').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Approve')`, 'Approve in the row');
    must(/Approve/.test((await evaluate(`document.querySelector('dialog[open] h3')?.textContent`)) ?? ''), 'the approve dialog did not open');
    await screenshot('a-approve-dialog');
    await click(byText('dialog[open] button', 'Approve'), 'Approve (dialog)');
    const f = await afterSubmit(); await screenshot('a-approved');
    must(f.msg === 'Version approved.', `outcome: ${JSON.stringify(f)}`);
    must((await q('SELECT state FROM marketplace_versions WHERE id=$1', [id]))[0].state === 'approved', 'version is not approved in the database');
    const rows = await auditRows(mark0, 'marketplace.approve'); must(rows.length === 1 && rows[0].admin_user_id === 'usr_rev', `audit: ${JSON.stringify(rows)}`);
    state.audit.push(['approve', 'usr_rev']);
  });

  // ---- (b) manual review needs the acknowledgement
  await step('b. a manual-review version has no one-click Approve; its review page keeps Approve disabled until the box is ticked', async () => {
    const id = seed.routine.versionId;
    await goto('/admin/marketplace/review'); await screenshot('b-queue');
    const row = await evaluate(`(() => { const tr = document.querySelector('a[href="/admin/marketplace/review/${id}"]').closest('tr'); return [...tr.querySelectorAll('button, a.btn')].map((e) => e.textContent.trim()); })()`);
    must(!row.includes('Approve') && row.includes('Review summary'), `queue row offers: ${JSON.stringify(row)}`);
    await goto(`/admin/marketplace/review/${id}`); await screenshot('b-review-page');
    must(await isDisabled(byText('main button', 'Approve this version')), 'Approve this version must be disabled before the box is ticked');
  });
  await step('b. the server itself refuses approval without the acknowledgement (no ack, wrong hash)', async () => {
    const id = seed.routine.versionId;
    for (const body of [{}, { ack_summary_sha256: 'f'.repeat(64) }]) {
      const r = await api(`/admin/marketplace/versions/${id}/approve`, { acting: 'usr_rev', body });
      must(r.status === 409 || r.status === 400, `expected a refusal, got ${r.status} ${r.text.slice(0, 200)}`);
    }
    must((await q('SELECT state FROM marketplace_versions WHERE id=$1', [id]))[0].state === 'submitted', 'a refused approval changed the state');
  });
  await step('b. the submitter cannot approve their own manual-review version, even with the right hash', async () => {
    const r = await api(`/admin/marketplace/versions/${seed.routine.versionId}/approve`, { acting: 'usr_sub', body: { ack_summary_sha256: seed.routine.summarySha256 } });
    must(r.status === 403 || r.status === 409, `expected separation of duties, got ${r.status} ${r.text.slice(0, 200)}`);
  });
  await step('b. ticking the box enables Approve; approving with the acknowledgement works and is audited', async () => {
    const id = seed.routine.versionId, mark0 = await auditMax();
    await click(`document.querySelector('input[name=reviewed]')`, 'the reviewed checkbox');
    must(!(await isDisabled(byText('main button', 'Approve this version'))), 'Approve this version stayed disabled after ticking');
    await screenshot('b-ticked');
    await click(byText('main button', 'Approve this version'), 'Approve this version');
    const f = await afterSubmit(); await screenshot('b-approved');
    must(f.msg === 'Version approved.', `outcome: ${JSON.stringify(f)}`);
    must((await q('SELECT state FROM marketplace_versions WHERE id=$1', [id]))[0].state === 'approved', 'not approved in the database');
    const rows = await auditRows(mark0, 'marketplace.approve'); must(rows.length === 1 && rows[0].admin_user_id === 'usr_rev', `audit: ${JSON.stringify(rows)}`);
    const ev = await q(`SELECT detail FROM marketplace_release_events WHERE version_id=$1 AND event='approved'`, [id]);
    must(ev[0]?.detail?.ackSummarySha256 === seed.routine.summarySha256, 'the acknowledged hash is not recorded on the release event');
  });

  // ---- (e) run verification and see the verdict
  await step('e. run verification on a version and see the verdict', async () => {
    const id = seed.notes.versionId, mark0 = await auditMax();
    await goto(`/admin/marketplace/versions/${id}`); await screenshot('e-before');
    must((await text()).includes('Not yet verified'), 'expected the not-yet-verified state first');
    await click(byText('button', 'Run verification'), 'Run verification'); await screenshot('e-dialog');
    await click(byText('dialog[open] button', 'Run'), 'Run (dialog)');
    const f = await afterSubmit(); must(f.msg, `outcome: ${JSON.stringify(f)}`);
    await goto(`/admin/marketplace/versions/${id}`); await screenshot('e-verdict');
    const t = await text(); must(!t.includes('Not yet verified'), 'no verdict is shown after the run');
    const rows = await q(`SELECT verdict FROM marketplace_verifications WHERE version_id=$1 ORDER BY seq DESC`, [id]); must(rows.length >= 1, 'no verification row in the database');
    const a = await auditRows(mark0, 'marketplace.verify'); must(a.length === 1 && a[0].admin_user_id === 'usr_rev', `audit: ${JSON.stringify(a)}`);
    state.verdict = rows[0].verdict; log(`        verdict: ${state.verdict}`);
  });

  // ---- (c) halt a type
  await signInAs('usr_sup');
  await step('c. superadmin halts a type with the typed confirmation and a reason; the catalog stops serving it', async () => {
    const before_ = await catalogIds(); must(before_.some((i) => i === 'acme/doc-guard'), `the hook is not served before the halt: ${JSON.stringify(before_)}`);
    await goto('/admin/marketplace/advanced'); await screenshot('c-page');
    await click(byText('button', 'Halt hook'), 'Halt hook'); await screenshot('c-dialog-empty');
    must(await isDisabled(`document.querySelector('dialog[open] .dialog-foot button.danger')`), 'the confirm button must be disabled before typing');
    await type(`document.querySelector('dialog[open] input[name=confirm]')`, 'bridge', 'confirmation');   // the wrong word
    must(await isDisabled(`document.querySelector('dialog[open] .dialog-foot button.danger')`), 'a wrong confirmation word must keep the button disabled');
    await type(`document.querySelector('dialog[open] input[name=confirm]')`, 'hook', 'confirmation');
    await type(`document.querySelector('dialog[open] textarea[name=reason]')`, 'E2E: emergency stop of the hook type', 'reason');
    await screenshot('c-dialog-filled');
    const mark0 = await auditMax();
    await click(`document.querySelector('dialog[open] .dialog-foot button.danger')`, 'Halt hook (dialog)');
    const f = await afterSubmit(); await screenshot('c-halted');
    must(/Halted hook: 1 version/.test(f.msg ?? ''), `outcome: ${JSON.stringify(f)}`);
    must((await q(`SELECT v.state FROM marketplace_versions v JOIN marketplace_listings l ON l.id=v.listing_id WHERE l.type='hook'`))[0].state === 'quarantined', 'the hook version is not quarantined');
    const after_ = await catalogIds(); must(!after_.includes('acme/doc-guard'), `the catalog still serves the halted hook: ${JSON.stringify(after_)}`);
    must(after_.includes('acme/local-memory'), 'halting hook must not take memory down');
    const rows = await auditRows(mark0, 'marketplace.halt_type'); must(rows.length === 1 && rows[0].admin_user_id === 'usr_sup', `audit: ${JSON.stringify(rows)}`);
    must(/emergency stop/.test(JSON.stringify(rows[0].detail)), 'the reason is not in the audit detail');
  });

  // ---- (d) save a type policy
  await step('d. superadmin raises a type policy; the page and the database show the change', async () => {
    await goto('/admin/marketplace/type-policy'); await screenshot('d-page');
    const mark0 = await auditMax();
    const row = `[...document.querySelectorAll('table.dt tbody tr')].find((tr) => tr.querySelector('td.mono')?.textContent.trim() === 'template')`;
    await click(`(${row}).querySelector('input[name=manualReview]')`, 'manual review checkbox');
    await type(`(${row}).querySelector('input[name=reason]')`, 'E2E: templates now need a manual review', 'reason');
    await screenshot('d-filled');
    await click(`(${row}).querySelector('button')`, 'Save');
    const f = await afterSubmit(); await screenshot('d-saved');
    must(f.msg === 'Policy of template saved.', `outcome: ${JSON.stringify(f)}`);
    const rows = await q(`SELECT manual_review, updated_by FROM marketplace_type_policy WHERE type='template'`); must(rows[0]?.manual_review === true && rows[0].updated_by === 'usr_sup', `policy row: ${JSON.stringify(rows)}`);
    must((await text()).includes('raised'), 'the page does not show the raised badge');
    const a = await auditRows(mark0, 'marketplace.set_type_policy'); must(a.length === 1 && a[0].admin_user_id === 'usr_sup', `audit: ${JSON.stringify(a)}`);
  });
  await step('d. a policy cannot be lowered below the built-in floor (the server refuses)', async () => {
    const r = await api('/admin/marketplace/type-policy/hook', { acting: 'usr_sup', method: 'PUT', body: { riskTier: 'data', reason: 'E2E try to lower' } });
    must(r.status === 400 || r.status === 409 || r.status === 422, `expected a refusal, got ${r.status} ${r.text.slice(0, 200)}`);
  });

  // ---- (f) analyst
  await signInAs('usr_ana');
  await step('f. an analyst sees no mutating control on any marketplace page', async () => {
    for (const [name, path] of [['review', '/admin/marketplace/review'], ['review-detail', `/admin/marketplace/review/${seed.routine.versionId}`], ['version', `/admin/marketplace/versions/${seed.notes.versionId}`],
      ['advanced', '/admin/marketplace/advanced'], ['type-policy', '/admin/marketplace/type-policy'], ['publish', '/admin/marketplace/publish'], ['catalog', '/admin/marketplace/catalog']]) {
      await goto(path); await screenshot(`f-${name}`);
      const c = await mutatingControls(); must(c.length === 0, `${path} shows controls to an analyst: ${JSON.stringify(c)}`);
    }
  });
  await step('f. an analyst is refused on every mutating action in the API, and nothing changes (no rows, no audit)', async () => {
    const counts = () => q(`SELECT (SELECT count(*) FROM marketplace_versions)::int v, (SELECT count(*) FROM marketplace_release_events)::int e, (SELECT count(*) FROM marketplace_type_policy)::int p, (SELECT count(*) FROM admin_audit)::int a, (SELECT string_agg(id||state, ',' ORDER BY id) FROM marketplace_versions) s`);
    const b = await counts(); const vid = seed.notes.versionId;
    const calls = [
      ['submit', '/admin/marketplace/submissions?publisher=acme&visibility=public', 'POST', undefined, skillZip('acme/analyst-try', 'Analyst Try')],
      ...['claim', 'approve', 'reject', 'publish', 'deprecate', 'quarantine', 'revoke', 'rescan', 'verify'].map((a) => [a, `/admin/marketplace/versions/${vid}/${a}`, 'POST', { reason: 'E2E analyst', ack_summary_sha256: seed.routine.summarySha256 }]),
      ['halt', '/admin/marketplace/types/memory/halt', 'POST', { reason: 'E2E analyst' }],
      ['type-policy', '/admin/marketplace/type-policy/memory', 'PUT', { manualReview: true, reason: 'E2E analyst' }],
      ['publisher', '/admin/marketplace/publishers', 'POST', { id: 'evil', trust: 'official', displayName: 'Evil' }],
      ['org-policy', '/admin/marketplace/policies/org', 'PUT', { mode: 'allow_all' }],
    ];
    for (const [name, path, method, body, zip] of calls) {
      const r = await api(path, { acting: 'usr_ana', method, body, zip });
      must(r.status === 403, `${name}: expected 403 for an analyst, got ${r.status} ${r.text.slice(0, 160)}`);
    }
    must(JSON.stringify(await counts()) === JSON.stringify(b), 'a refused analyst call changed rows');
    const me = await api('/admin/marketplace/me', { acting: 'usr_ana' }); must(me.json.role === 'analyst' && me.json.permissions.join() === 'marketplace.read', `analyst /me: ${me.text}`);
  });
  await step('f. an analyst who opens the halt and policy pages is told so, with no form', async () => {
    await goto('/admin/marketplace/advanced'); must((await text()).includes('your role can read this page only'), 'no read-only notice on the advanced page');
    await goto('/admin/marketplace/type-policy'); must((await text()).includes('Only a superadmin can change a policy'), 'no read-only notice on the policy page');
  });

  // ---- visual: no table cell may clip its content (the Type Policy table clipped its Floor and Now text)
  await signInAs('usr_sup');
  await step('v. no marketplace table cell clips its text or its controls', async () => {
    const pages = ['review', `review/${seed.routine.versionId}`, 'advanced', 'type-policy', 'catalog', 'submissions', 'publishers', 'installations', 'reviews', 'security', 'releases', 'analytics', 'collections', 'evidence', 'team-assignments', 'policies', 'settings'];
    const clipped = [];
    for (const p of pages) {
      await goto(`/admin/marketplace/${p}`);
      const hits = await evaluate(`[...document.querySelectorAll('main td, main th')].filter((e) => e.scrollWidth > e.clientWidth + 1 || [...e.querySelectorAll('*')].some((c) => c.getBoundingClientRect().right > e.getBoundingClientRect().right + 1 && getComputedStyle(e).overflow !== 'visible')).map((e) => e.textContent.trim().slice(0, 50))`);
      if (hits.length) { clipped.push(`${p}: ${hits.slice(0, 3).join(' | ')}${hits.length > 3 ? ` (+${hits.length - 3})` : ''}`); await screenshot(`v-clipped-${p.split('/')[0]}`); }
    }
    must(!clipped.length, `clipped cells: ${clipped.join(' ;; ')}`);
  });

  // ---- (g) audit trail, as a whole
  await step('g. every mutation of this run left an admin_audit row naming the person, none under the service token', async () => {
    const rows = await q(`SELECT action, admin_user_id FROM admin_audit WHERE action LIKE 'marketplace.%' AND action NOT LIKE '%view%' ORDER BY id`);
    const bad = rows.filter((r) => !/^usr_/.test(r.admin_user_id)); must(!bad.length, `audit rows under a service token name: ${JSON.stringify(bad)}`);
    const need = ['marketplace.submit', 'marketplace.approve', 'marketplace.publish', 'marketplace.verify', 'marketplace.halt_type', 'marketplace.set_type_policy'];
    for (const a of need) must(rows.some((r) => r.action === a), `no ${a} audit row`);
    writeFileSync(join(OUT, 'audit.json'), JSON.stringify(rows, null, 1));
  });
}
const state = { audit: [], verdict: null };

let failed = false;
try { await main(); } catch (e) { failed = true; log(`\nrun aborted: ${e.message}`); }
finally {
  try { ws?.close(); } catch { /* closed */ }
  try { await owner?.end(); } catch { /* closed */ }
  teardown();
}
const ok = results.filter((r) => r.ok).length;
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, verdict: state.verdict }, null, 1));
log(`\n${ok}/${results.length} steps passed. Screenshots and logs: ${OUT}`);
process.exit(failed || ok !== results.length ? 1 : 0);
