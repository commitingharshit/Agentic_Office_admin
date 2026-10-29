#!/usr/bin/env node
// Audit traceability in the admin console, end to end (copy of marketplace-admin/run.mjs with its own flows), against the REAL accounts-sync admin API on a REAL Postgres. NOT wired into CI.
//
//   node tests/e2e/audit-trace/run.mjs [--out <dir>] [--keep-going]
//
// Starts (all on loopback, all torn down when the run ends, pass or fail):
//   1. a throwaway docker pgvector/pgvector:pg17 on a free port, migrations 0001-latest applied with all five role passwords set;
//   2. services/api/scripts/marketplace-admin-e2e-server.ts: the real admin handlers (admin.ts + marketplace-admin.ts) with the real
//      service-token authentication, the real role map and the real validators (in-memory artifact store; only differences from main.ts);
//   3. the control-plane (`next start`, production build) pointed at it, signed in through the console's own signed session cookie;
//   4. a private headless Chrome on a free debug port (never 9351, 9361 or 9399), driven over CDP: real clicks, real form posts.
// It then drives the review, ack, halt, type policy, verification and analyst flows, screenshots each step into --out, and checks
// admin_audit in the database after every mutation. Exit code 0 only if every step passed.
//
// Needs: docker, Google Chrome (AO_E2E_CHROME to override), node 24, python3 for the skill scanner (AO_E2E_PYTHON), npm deps installed in
// services/api, and apps/console with a real node_modules (a symlink breaks turbopack). The control-plane is built
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
const sync = join(repo, 'services', 'api');
const cp = join(repo, 'apps', 'console');
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
  must(existsSync(join(sync, 'node_modules')), 'run npm ci in services/api first');
  must(existsSync(join(cp, 'node_modules', 'next')), 'apps/console has no node_modules: run npm ci there (a symlink breaks turbopack)');
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
  const mig = execFileSync('node', ['../../database/migrate.ts'], { cwd: sync, env: { ...env0, DATABASE_URL: dburl, ...pw }, encoding: 'utf8' });
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
    must(r.status === 201 && r.json.validation?.ok, `seed submit failed: ${r.status} ${JSON.stringify((r.json?.validation?.checks ?? []).filter((c) => !c.ok))} ${r.text.slice(0, 200)}`); return r.json;
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
  const v = seed.memo.versionId;
  const boss = 'usr_sup';

  // a mutation as a person, through the real console, so the trail has rows written by real clicks and server actions
  await step('a. the version page shows its own History, with the person who submitted it', async () => {
    await signInAs(boss);
    await goto(`/admin/marketplace/versions/${v}`);
    const t = await text();
    must(/History/.test(t), 'no History section');
    must(/Full audit trail/.test(t), 'no link to the full audit trail');
    must(/submit/i.test(t) && /usr_sub/.test(t), `History does not show the submit by usr_sub: ${t.slice(0, 300)}`);
    await screenshot('version-history');
  });

  await step('b. "Full audit trail" opens the audit log already filtered to that version', async () => {
    await click(byText('main a', 'Full audit trail'), 'Full audit trail');
    await waitFor(async () => (await url()).startsWith('/admin/audit'), 'audit page');
    const u = new URL(base + (await url()));
    must(u.searchParams.get('targetType') === 'marketplace_version' && u.searchParams.get('targetId') === v, `filter not carried: ${u.search}`);
    const rows = await evaluate(`[...document.querySelectorAll('main table tbody tr')].map((r) => r.innerText.replace(/\\s+/g, ' '))`);
    must(rows.length >= 1, 'no rows on the filtered trail');
    must(rows.every((r) => /Version/.test(r)), `a row is not about a version: ${rows.find((r) => !/Version/.test(r))}`);
    await screenshot('trail-filtered');
  });

  await step('c. the audit page names the administrator by email and links the subject to its page', async () => {
    await goto('/admin/audit');
    const links = await evaluate(`[...document.querySelectorAll('main table tbody a')].map((a) => ({ t: a.textContent.trim(), h: a.getAttribute('href') }))`);
    must(links.some((l) => /@e2e\.test$/.test(l.t) && l.h.startsWith('/admin/users/')), `no administrator email link: ${JSON.stringify(links.slice(0, 6))}`);
    must(links.some((l) => l.h.startsWith('/admin/marketplace/versions/')), 'no subject link to a version page');
    must(links.some((l) => l.t === 'trail' && l.h.startsWith('/admin/audit?targetType=')), 'no per-subject trail link');
    await screenshot('audit-links');
  });

  await step('d. filters work from the form: administrator, action, subject type, free text', async () => {
    await goto('/admin/audit?admin=usr_sub');
    let rows = await evaluate(`document.querySelectorAll('main table tbody tr').length`);
    must(rows >= 1, 'no rows for usr_sub');
    must(await evaluate(`[...document.querySelectorAll('main table tbody tr')].every((r) => /usr_sub@e2e.test/.test(r.innerText))`), 'a row belongs to someone else');
    await goto('/admin/audit?action=marketplace.submit');
    must(await evaluate(`[...document.querySelectorAll('main table tbody tr')].every((r) => /marketplace\\.submit/.test(r.innerText))`), 'an action filter let another action through');
    const options = await evaluate(`[...document.querySelectorAll('select[name=action] option')].map((o) => o.value)`);
    must(options.includes('marketplace.submit'), `action list lacks marketplace.submit: ${options.slice(0, 8)}`);
    await goto('/admin/audit?q=memo-style');
    rows = await evaluate(`document.querySelectorAll('main table tbody tr').length`);
    must(rows >= 1, 'free text found nothing');
    await goto('/admin/audit?q=zzz-no-such-text-zzz');
    must(/No entries match/.test(await text()), 'an empty result is not explained');
    await goto('/admin/audit?from=2001-01-01&to=2001-01-02');
    must(/No entries match/.test(await text()), 'a past date range returned rows');
    await screenshot('audit-filters');
  });

  await step('e. details open in place and show the full record', async () => {
    await goto('/admin/audit?action=marketplace.submit');
    await click(`document.querySelector('main table tbody details summary')`, 'a detail summary');
    await sleep(200);
    const shown = await evaluate(`(() => { const d = document.querySelector('main table tbody details[open] pre'); return d ? d.innerText : null; })()`);
    must(shown && /versionId/.test(shown), `the opened detail does not show the record: ${shown}`);
  });

  await step('f. breadcrumbs name the page, not just a shortened id', async () => {
    await goto(`/admin/marketplace/versions/${v}`);
    const crumbs = await evaluate(`document.querySelector('.crumbs').innerText.replace(/\\s+/g, ' ')`);
    must(/Version /.test(crumbs), `breadcrumb is not named: ${crumbs}`);
  });

  await step('g. the command palette opens an id as each kind of page, and reads its audit trail', async () => {
    await goto('/admin');
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await waitFor(() => evaluate(`!!document.querySelector('dialog.cmdk[open]')`), 'palette open');
    await type(`document.querySelector('dialog.cmdk input')`, v, 'palette input');
    await sleep(300);
    const labels = await evaluate(`[...document.querySelectorAll('dialog.cmdk li a')].map((a) => a.innerText.replace(/\\s+/g, ' '))`);
    for (const need of ['Open payment', 'Open agent run', 'Open session', 'Open ticket', 'Open marketplace version', 'Audit trail for']) must(labels.some((l) => l.startsWith(need)), `palette lacks "${need}": ${labels.join(' | ')}`);
    await screenshot('palette-id');
    await click(`[...document.querySelectorAll('dialog.cmdk li a')].find((a) => /^Open marketplace version/.test(a.innerText))`, 'open version');
    await waitFor(async () => (await url()) === `/admin/marketplace/versions/${v}`, 'the version page from the palette');
  });

  await step('h. an administrator who may not read the audit log sees no History panel and no audit page', async () => {
    await signInAs('usr_ana');
    await goto(`/admin/marketplace/versions/${v}`);
    const t = await text();
    must(!/Full audit trail/.test(t), 'History shown to a role without audit.read');
    await goto('/admin/audit');
    const t2 = await text();
    must(/cannot read the audit log/.test(t2), `no plain refusal on the audit page: ${t2.slice(0, 200)}`);
    must(!(await evaluate(`!!document.querySelector('main table tbody tr')`)), 'audit rows shown to a role without audit.read');
  });

  await step('i. the audit rows written by this run carry their subject', async () => {
    const rows = await q(`SELECT action, target_type, target_id FROM admin_audit WHERE action = 'marketplace.submit'`);
    must(rows.length >= 2 && rows.every((r) => r.target_type === 'marketplace_version' && r.target_id), `submit rows without a subject: ${JSON.stringify(rows)}`);
    const nulls = await q(`SELECT count(*)::int AS n FROM admin_audit WHERE target_user_id IS NOT NULL AND target_id IS DISTINCT FROM target_user_id`);
    must(nulls[0].n === 0, 'a user-target row disagrees with target_id');
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
