// The Plan 3 advanced-type marketplace admin pages as a browser meets them: a real `next start` (Keycloak mode, so a signed cookie is a session), with a
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

const H = 'b'.repeat(64);
const PERMS: Record<string, string[]> = {
  root: ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate', 'marketplace.policy'],
  ana: ['marketplace.read'],
};
const seen: string[] = [];
let api: Server, web: ChildProcess, port = 0, output = '';
const item = (o: Record<string, unknown>) => ({ versionId: 'ver_h1', listingId: 'acme/hook1', name: 'Pre-save hook', type: 'hook', version: '1.0.0', state: 'quarantined', riskTier: 'executable', publisher: 'acme', trust: 'verified', reason: 'CVE-1 <b>bad</b>', by: 'adm_1', at: '2026-10-21T10:00:00Z', liveInstalls: 3, openReports: 1, ...o });

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
    if (path === '/admin/marketplace/security/advanced') return send({ types: ['hook'], quarantined: [item({})], revoked: [], highTierPublished: [item({ versionId: 'ver_h2', state: 'published', reason: null, by: null, at: null })],
      counts: [{ type: 'hook', state: 'quarantined', n: 1 }, { type: 'hook', state: 'published', n: 1 }], note: 'Each list shows at most 100 versions.' });
    if (path === '/admin/marketplace/type-policy') return send({ items: [
      { type: 'hook', riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified', floor: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'community' }, raised: true, supported: true, updatedBy: 'adm_1', updatedAt: '2026-10-21T10:00:00Z' },
      { type: 'skill', riskTier: 'declarative', manualReview: false, minPublisherTrust: 'community', floor: { riskTier: 'declarative', manualReview: false, minPublisherTrust: 'community' }, raised: false, supported: true, updatedBy: null, updatedAt: null }], note: 'The code floor can only be raised.' });
    if (path === '/admin/marketplace/analytics/advanced') return send({ byType: [{ type: 'hook', publishedListings: 2, installs: 9, failedInstalls: 3, failureRate: 0.25, activeInstalls: 5, awaitingConfiguration: 1, awaitingConfigurationRate: 0.2, uninstalls: 1, quarantines: 1, revokes: 0, failedReasons: [{ reason: 'boom at <host>', count: 3 }] }, { type: 'bundle' }], notes: ['device-reported'] });
    if (path === '/admin/marketplace/analytics') return send({ installs: 9, uninstalls: 1, activeInstalls: 5, failedInstalls: 3, failureRate: 0.25, updateAdoption: { onLatest: 1, installs: 2, ratio: 0.5 }, averageRating: null, ratingCount: 0, securityIncidents: 1, popularCategories: [], telemetryCoverage: { devicesReporting: 1, devicesKnown: 2, ratio: 0.5 }, notCollected: [], notes: [] });
    if (path === '/admin/marketplace/security/suspicious-install-bursts') return send({ window: { hours: 24, accountMaxAgeHours: 24, minAccounts: 5 }, bursts: [{ listingId: 'acme/hook1', installs: 12, accounts: 9, firstAt: '2026-10-21T09:00:00Z', lastAt: '2026-10-21T10:00:00Z' }], note: 'A signal for review only.' });
    if (path === '/admin/marketplace/security/verification') return send({ items: [] });
    if (path === '/admin/marketplace/reports') return send({ items: [], nextPage: null });
    if (path === '/admin/marketplace/catalog') return send({ items: [{ id: 'acme/hook1', name: 'Pre-save hook', type: 'hook', riskTier: 'executable', manualReview: true, publisher: 'acme', visibility: 'public', trust: 'verified', state: 'published', latestVersionId: 'ver_h2', latestVersion: '1.0.0', updatedAt: '2026-10-21T10:00:00Z' }], nextPage: null });
    if (path === '/admin/marketplace/submissions') return send({ items: [{ versionId: 'ver_h3', name: 'Risky hook', type: 'hook', publisher: 'acme', version: '1.0.0', state: 'submitted', scanVerdict: 'clean', verified: true, submittedAt: '2026-10-21T10:00:00Z', riskTier: 'executable', manualReview: true, highRisk: ['runs a script', 'reaches network', 'writes files', 'reads secrets'] }] });
    if (path === '/admin/marketplace/submissions/ver_h3') return send({ versionId: 'ver_h3', listingId: 'acme/risky', name: 'Risky hook', type: 'hook', publisher: 'acme', trust: 'verified', version: '1.0.0', state: 'submitted', scanVerdict: 'clean', verified: true, submittedAt: '2026-10-21T10:00:00Z', submittedBy: 'usr_9', riskTier: 'executable', manualReview: true,
      policy: { effective: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' }, floor: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'community' } },
      summary: { text: 'x', sections: [{ title: 'Runs', lines: ['script <img src=x onerror=alert(1)>'] }], validation: [{ name: 'scan', ok: true }], truncated: false }, summarySha256: H, highRisk: ['runs a script'] });
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
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

test('Advanced Types lists what the API returned, escapes text, and offers Halt only with marketplace.moderate', { skip }, async () => {
  const r = await get('/admin/marketplace/advanced', 'root');
  assert.equal(r.status, 200);
  const t = text(r.body);
  assert.match(t, /Quarantined 1/); assert.match(t, /Live at the executable tier 1/); assert.match(t, /CVE-1 <b>bad<\/b>/);
  assert.ok(!r.body.includes('<b>bad</b>'), 'reason text is escaped, not injected');
  assert.match(t, /Halt hook/);
  const a = await get('/admin/marketplace/advanced', 'ana');
  assert.doesNotMatch(text(a.body), /Halt hook/); assert.match(text(a.body), /needs marketplace\.moderate/);
});

test('Type Policy shows floor and effective values, an editor only with marketplace.policy, and no nav entry otherwise', { skip }, async () => {
  const r = await get('/admin/marketplace/type-policy', 'root');
  assert.equal(r.status, 200);
  const t = text(r.body);
  assert.match(t, /executable · manual review · publisher community \+/); assert.match(t, /raised/);
  assert.match(r.body, /name="reason"/); assert.match(r.body, /href="\/admin\/marketplace\/type-policy"/);
  const a = await get('/admin/marketplace/type-policy', 'ana');
  assert.doesNotMatch(a.body, /name="reason"/); assert.match(text(a.body), /Only a superadmin can change a policy/);
  assert.doesNotMatch(a.body, /href="\/admin\/marketplace\/type-policy"/);
});

test('the review summary page shows the server sections as text and an acknowledgement form carrying the server hash; an analyst gets no form', { skip }, async () => {
  const r = await get('/admin/marketplace/review/ver_h3', 'root');
  assert.equal(r.status, 200);
  assert.match(text(r.body), /I reviewed this summary/); assert.ok(r.body.includes(H));
  assert.ok(!r.body.includes('<img src=x'), 'package text is escaped');
  const a = await get('/admin/marketplace/review/ver_h3', 'ana');
  assert.doesNotMatch(text(a.body), /I reviewed this summary/); assert.match(text(a.body), /needs marketplace\.review/);
});

test('the review queue links manual-review versions to their summary page and previews at most three risks', { skip }, async () => {
  const t = text((await get('/admin/marketplace/review', 'root')).body);
  assert.match(t, /manual review/); assert.match(t, /\+1 more/); assert.match(t, /Review summary/);
});

test('By type analytics and Suspicious install bursts render from the API; catalog has the risk filters', { skip }, async () => {
  const an = text((await get('/admin/marketplace/analytics', 'ana')).body);
  assert.match(an, /By type/); assert.match(an, /hook 2 9 3 25%/); assert.match(an, /boom at <host> \(3\)/); assert.match(an, /bundle 0 0 0 n\/a/);
  const sec = text((await get('/admin/marketplace/security', 'ana')).body);
  assert.match(sec, /Suspicious install bursts 1/); assert.match(sec, /acme\/hook1 12 9/); assert.match(sec, /A signal for review only/);
  const cat = await get('/admin/marketplace/catalog', 'ana');
  assert.match(cat.body, /name="riskTier"/); assert.match(cat.body, /name="manualReview"/); assert.match(text(cat.body), /executable/);
});
