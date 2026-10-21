// The Plan 2 marketplace admin pages as a browser meets them: a real `next start` (Keycloak mode, so a signed cookie is a session), with a
// stub admin API behind it that serves exactly the shapes accounts-sync returns and records every request. What is under test is ours:
// the pages show only what the API said, mark what is not available, hide what the viewer cannot use, and never call an endpoint the
// viewer's role would be refused. Needs a production build (`npm run build`); no database.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { existsSync } from 'node:fs';
import { sign } from '../src/lib/keycloak.ts';

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
process.env.AUTH_SECRET = SECRET;
const built = existsSync('.next/BUILD_ID');
const skip = !built && 'no production build (npm run build)';
const free = async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); const p = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };

const CHECKS = [
  { name: 'compiles', ok: true, detail: 'hermes-profile-distribution 1' },
  { name: 'dry-run', ok: true, detail: '5 step(s)' },
  { name: 'permissions-subset', ok: true, detail: 'derived: fs.workspace.read, network; declared: fs.workspace.read' },
  { name: 'unsupported-reported', ok: true, detail: 'not available yet: hookBindings' },
];
const AGENT_VERSION = {
  id: 'ver_agent1', listingId: 'acme/analyst', version: '1.0.0', state: 'in_review', scanVerdict: 'clean', sha256: 'a'.repeat(64), size: 2048, compat: {}, createdAt: '2026-10-21T10:00:00Z', publishedAt: null,
  manifest: { type: 'agent', title: 'M&A Analyst', summary: 'Reads deals.', license: 'MIT', permissions: [{ capability: 'fs.workspace.read', scope: 'docs/**', reason: 'read' }], payload: { components: ['identity', 'skillReferences', 'hookBindings'] } },
  validation: { ok: true, verified: true, verdict: 'clean' }, scans: [{ id: 's1', scanner: 'validation', verdict: 'clean', findings: { ok: true, verified: true, checks: CHECKS }, at: '2026-10-21T10:00:01Z' }],
  events: [], dependencies: [{ id: 'acme/pdf-notes', range: '^1.0.0' }], submission: { state: 'in_review' },
};
const BUNDLE_VERSION = {
  ...AGENT_VERSION, id: 'ver_bundle1', listingId: 'acme/toolkit',
  manifest: { type: 'bundle', title: 'Deal toolkit', summary: 'x', license: 'MIT', permissions: [], dependencies: [{ id: 'acme/analyst', range: '=1.0.0' }, { id: 'acme/loose', range: '^2.0.0' }] },
  scans: [{ id: 's2', scanner: 'validation', verdict: 'clean', findings: { ok: true, verified: true, checks: [{ name: 'closure-complete', ok: true }, { name: 'permissions-union', ok: true, detail: 'ok' }, { name: 'manual-review-required', ok: true, detail: 'elevated member(s): acme/analyst' }] }, at: 'x' }],
  dependencies: [],
};
const PERMS: Record<string, string[]> = {
  root: ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate', 'marketplace.policy'],
  ana: ['marketplace.read'],
};
const seen: string[] = [];
let api: Server, web: ChildProcess, port = 0, output = '';

before(async () => {
  if (skip) return;
  api = createServer((req, res) => {
    const who = String(req.headers['x-ao-acting-admin']);
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    seen.push(`${who} ${req.method} ${path}`);
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (path === '/healthz') return send({ ok: true });
    if (path === '/admin/me') return send({ role: who === 'root' ? 'superadmin' : 'analyst', permissions: ['overview.read'] });
    if (path === '/admin/attention') return send({ items: [] });
    if (path === '/admin/marketplace/me') return send({ role: who === 'root' ? 'superadmin' : 'analyst', permissions: PERMS[who] ?? [] });
    if (path === '/admin/marketplace/versions/ver_agent1') return send(AGENT_VERSION);
    if (path === '/admin/marketplace/versions/ver_bundle1') return send(BUNDLE_VERSION);
    if (path === '/admin/marketplace/submissions/ver_agent1') return send({ manualReview: true, highRisk: ['exec.script'], summary: { text: 'Agent blueprint\n- acme/pdf-notes', truncated: false }, summarySha256: 'b'.repeat(64) });
    if (path === '/admin/marketplace/submissions/ver_bundle1') return send({ manualReview: false, summary: { text: '', truncated: false }, summarySha256: 'e'.repeat(64) });
    if (path === '/admin/marketplace/policies/org') return PERMS[who]?.includes('marketplace.policy') ? send({ mode: 'allowlist', minTrust: 'verified', requireCleanScan: true, configured: true, rules: [{ effect: 'deny', matchKind: 'type', matchValue: 'hook' }] }) : send({ error: 'no' }, 403);
    if (path === '/admin/marketplace/team-assignments') return send({ items: [
      { id: 'a1', teamId: 'team_1', listingId: 'acme/toolkit', title: 'Deal toolkit', type: 'bundle', pinnedVersion: '1.0.0', pinSha256: 'c'.repeat(64), mode: 'required', versionState: 'published', blocked: false },
      { id: 'a2', teamId: 'team_1', listingId: 'acme/old', title: 'Old agent', type: 'agent', pinnedVersion: '0.9.0', pinSha256: 'd'.repeat(64), mode: 'optional', versionState: 'revoked', blocked: true }] });
    if (path === '/admin/marketplace/catalog') return send({ items: [{ id: 'acme/analyst', name: 'M&A Analyst', type: 'agent', publisher: 'acme', visibility: 'private', state: 'in_review', latestVersionId: 'ver_agent1', latestVersion: '1.0.0', updatedAt: '2026-10-21T10:00:00Z' }], nextPage: null });
    if (path === '/admin/marketplace/publishers') return send({ items: [{ id: 'acme', displayName: 'Acme', verified: true }] });
    return send({ error: 'unexpected ' + path }, 404);
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiPort = (api.address() as AddressInfo).port;
  port = await free();
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', AUTH_BASE_URL: `http://127.0.0.1:${port}`, AUTH_SECRET: SECRET, AO_ADMIN_API_URL: `http://127.0.0.1:${apiPort}`, AO_ADMIN_API_TOKEN: 'stub-token-0123456789abcdef',
      ADMIN_HOSTS: '127.0.0.1', KEYCLOAK_ISSUER: 'http://127.0.0.1:1/realms/x', KEYCLOAK_CONSOLE_SECRET: 'x'.repeat(24), AO_SYNC_API_URL: '', KEYCLOAK_INTERNAL_URL: '', KEYCLOAK_CONSOLE_CLIENT_ID: '' },
  });
  web.stdout?.on('data', (d) => { output += d; }); web.stderr?.on('data', (d) => { output += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`next did not start:\n${output}`);
});
after(() => { web?.kill('SIGTERM'); api?.close(); });

const cookie = (id: string) => `ao_admin_session=${sign({ id, email: `${id}@example.test`, name: id, exp: Math.floor(Date.now() / 1000) + 3600 })}`;
const get = (path: string, id: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { cookie: cookie(id) } }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject); req.end();
});
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('an agent version page shows the component table, derived vs declared permissions, the dry run and the dependencies, all from the API', { skip }, async () => {
  const r = await get('/admin/marketplace/versions/ver_agent1', 'root');
  assert.equal(r.status, 200);
  const t = text(r.body);
  assert.match(t, /Blueprint components/);
  assert.match(t, /hookBindings Not available yet/);
  assert.match(t, /skillReferences Supported/);
  assert.match(t, /Derived from the blueprint fs\.workspace\.read, network/);
  assert.match(t, /Derived but not declared: network/);
  assert.match(t, /Dry run passed 5 step\(s\)/);
  assert.match(t, /acme\/pdf-notes/);
  assert.match(t, /not available yet: hookBindings/);
});

test('a manual-review agent shows the server summary and an approve form that sends the server hash; an analyst gets neither the form nor the summary request', { skip }, async () => {
  const r = await get('/admin/marketplace/versions/ver_agent1', 'root');
  const t = text(r.body);
  assert.match(t, /Manual review summary/); assert.match(t, /I read the summary: approve/);
  assert.ok(r.body.includes('b'.repeat(64)), 'the hash the server computed is what the form carries');
  seen.length = 0;
  const a = await get('/admin/marketplace/versions/ver_agent1', 'ana');
  assert.doesNotMatch(text(a.body), /I read the summary/);
  assert.ok(!seen.some((s) => s.startsWith('ana') && s.includes('/submissions/')), 'no summary request without marketplace.review');
});

test('a bundle version page lists members and flags a member that is not pinned', { skip }, async () => {
  const t = text((await get('/admin/marketplace/versions/ver_bundle1', 'root')).body);
  assert.match(t, /Members/); assert.match(t, /acme\/analyst 1\.0\.0/); assert.match(t, /acme\/loose not pinned \( \^2\.0\.0 \)/);
  assert.match(t, /Dependency closure complete passed/);
  assert.match(t, /Manual review is required: elevated member\(s\): acme\/analyst/);
});

test('the policy page is editable for marketplace.policy and, without it, disabled and never fetches the policy', { skip }, async () => {
  const r = await get('/admin/marketplace/policies', 'root');
  assert.equal(r.status, 200);
  assert.match(r.body, /<option value="allowlist" selected/); assert.ok(r.body.includes('deny type hook'));
  assert.doesNotMatch(r.body, /<fieldset[^>]*disabled/);
  seen.length = 0;
  const a = await get('/admin/marketplace/policies', 'ana');
  assert.match(a.body, /<fieldset[^>]*disabled/);
  assert.match(text(a.body), /needs marketplace\.policy/);
  assert.ok(!seen.some((s) => s.includes('/policies/org')), 'no policy request for a role without marketplace.policy');
});

test('the team assignments page shows pins and marks a revoked pin as blocked', { skip }, async () => {
  const t = text((await get('/admin/marketplace/team-assignments', 'ana')).body);
  assert.match(t, /Deal toolkit/); assert.match(t, /1\.0\.0/); assert.match(t, /Blocked: this version was revoked/);
  assert.match(t, /Members cannot install it/);
});

test('the Marketplace nav shows policy only to marketplace.policy, and agents/bundles replace the old "not available" page', { skip }, async () => {
  const root = (await get('/admin/marketplace/team-assignments', 'root')).body, ana = (await get('/admin/marketplace/team-assignments', 'ana')).body;
  assert.match(root, /href="\/admin\/marketplace\/policies"/); assert.doesNotMatch(ana, /href="\/admin\/marketplace\/policies"/);
  const c = text((await get('/admin/marketplace/collections', 'ana')).body);
  assert.match(c, /Agents/); assert.match(c, /M&A Analyst/); assert.doesNotMatch(c, /Not available in this release/);
});

test('publish offers agent and bundle with their package layout', { skip }, async () => {
  const t = text((await get('/admin/marketplace/publish?type=agent', 'root')).body);
  assert.match(t, /blueprint\.json/); assert.match(t, /SOUL\.md/);
  const b = text((await get('/admin/marketplace/publish?type=bundle', 'root')).body);
  assert.match(b, /bundle\.json/);
  const s = text((await get('/admin/marketplace/publish', 'root')).body);
  assert.doesNotMatch(s, /agent\s+Not available/);
});
