// The web app as a browser meets it: a real `next start` on a real port, Better Auth sessions in a real database,
// and accounts-sync's admin API behind it. Needs a production build (`npm run build`) and
//   AUTH_TEST_PG, AO_AUTH_PASSWORD, AO_READONLY_PASSWORD, AO_ADMIN_PASSWORD
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../../accounts-sync/src/api/admin.ts';
import { adminHostAllowed, adminMfaRequired } from '../src/lib/session';

const ownerUrl = process.env.AUTH_TEST_PG;
const skip = !ownerUrl && 'AUTH_TEST_PG not set';
const tag = Date.now().toString(36);
const SERVICE_TOKEN = `service-token-${tag}-0123456789abcdef`;
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const free = async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); const p = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };

let web: ChildProcess, apiServer: Server, base: string, port: number, owner: pg.Client, ro: pg.Pool, adm: pg.Pool;
const emails: string[] = [];
let output = '';
let ips = 1;

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const handler = adminHandler({ ro, admin: adm, tokens: parseTokens(`console:${SERVICE_TOKEN}`) });
  apiServer = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const apiPort = (apiServer.address() as AddressInfo).port;
  port = await free();
  base = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', AUTH_BASE_URL: base, AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
      AUTH_DATABASE_URL: as('ao_auth', process.env.AO_AUTH_PASSWORD), AO_ADMIN_API_URL: `http://127.0.0.1:${apiPort}`, AO_ADMIN_API_TOKEN: SERVICE_TOKEN, ADMIN_HOSTS: '127.0.0.1', AUTH_IP_HEADER: 'x-test-ip' },
  });
  web.stdout?.on('data', (d) => { output += d; }); web.stderr?.on('data', (d) => { output += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`next did not start:\n${output}`);
});
after(async () => {
  if (skip) return;
  web.kill('SIGTERM');
  await owner.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
  apiServer.close();
  await Promise.all([owner.end(), ro.end(), adm.end()]);
});

/** A request with full control of the Host header (fetch will not let us set it). */
const get = (path: string, o: { cookie?: string; host?: string } = {}) => new Promise<{ status: number; location: string | null; body: string }>((resolve, reject) => {
  const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.host ? { host: o.host } : {}) } }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string) ?? null, body }));
  });
  req.on('error', reject); req.end();
});
async function person(name: string, role: 'user' | 'admin', mfa = true) {
  const email = `${name}.${tag}@example.test`; emails.push(email);
  // Each person comes from their own address, as in life, so the sign-up rate limit (on in production) does not meet us.
  const r = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-ip': `10.1.${ips++ % 250}.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ email, password: 'a-long-enough-password', name }) });
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const id = (JSON.parse(text) as { user: { id: string } }).user.id;
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (role === 'admin') await owner.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  const u = { id, email, cookie };
  if (role === 'admin' && mfa) await enroll(u);
  return u;
}


type BrowserPerson = { id: string; email: string; cookie: string };
function cookies(u: BrowserPerson, r: Response) {
  const jar = new Map(u.cookie.split('; ').filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
  for (const raw of r.headers.getSetCookie()) {
    const c = raw.split(';')[0], i = c.indexOf('=');
    jar.set(c.slice(0, i), c.slice(i + 1));
  }
  u.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
async function authPost(u: BrowserPerson, path: string, body: object) {
  const r = await fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { cookie: u.cookie, origin: base, 'content-type': 'application/json', 'x-test-ip': `10.2.${ips++ % 250}.1` }, body: JSON.stringify(body) });
  cookies(u, r);
  return r;
}
function totp(uri: string, now = Date.now()) {
  const secret = new URL(uri).searchParams.get('secret')!;
  let bits = '';
  for (const c of secret.toUpperCase().replace(/=+$/, '')) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function wrongTotp(uri: string) {
  const valid = [-30000, 0, 30000].map((d) => totp(uri, Date.now() + d));
  return ['000000', '111111', '222222', '333333'].find((code) => !valid.includes(code))!;
}
async function enroll(u: BrowserPerson) {
  const r = await authPost(u, 'two-factor/enable', { password: 'a-long-enough-password' });
  assert.equal(r.status, 200, 'enable TOTP');
  const { totpURI } = await r.json();
  const verified = await authPost(u, 'two-factor/verify-totp', { code: totp(totpURI) });
  assert.equal(verified.status, 200, 'verify TOTP');
  return totpURI as string;
}

test('admin MFA: enrollment and a verified code are required on this session, wrong codes cannot grant access', { skip }, async () => {
  const a = await person('mfarequired', 'admin', false);
  for (const path of ['/admin', '/admin/users', `/admin/users/${a.id}`, '/admin/coupons', '/admin/audit']) {
    const r = await get(path, { cookie: a.cookie });
    assert.equal(r.status, 307, path); assert.equal(r.location, '/mfa');
    assert.ok(!r.body.includes(a.email), 'no admin data before MFA');
  }
  assert.match((await get('/mfa', { cookie: a.cookie })).body, /Set up an authenticator/);
  const old = { ...a, cookie: '' };
  assert.equal((await authPost(old, 'sign-in/email', { email: a.email, password: 'a-long-enough-password', adminMfaVerified: true })).status, 200);
  const enabled = await authPost(a, 'two-factor/enable', { password: 'a-long-enough-password' });
  assert.equal(enabled.status, 200);
  const { totpURI } = await enabled.json();
  assert.equal((await get('/admin', { cookie: a.cookie })).location, '/mfa', 'enable is not verification');
  assert.equal((await authPost(a, 'two-factor/verify-totp', { code: wrongTotp(totpURI) })).status, 401);
  assert.equal((await get('/admin', { cookie: a.cookie })).location, '/mfa');
  assert.equal((await authPost(a, 'two-factor/verify-totp', { code: totp(totpURI) })).status, 200);
  assert.equal((await get('/admin', { cookie: a.cookie })).status, 200);
  assert.equal((await get('/admin', { cookie: old.cookie })).location, '/mfa', 'other password sessions gain no proof from enrollment');
  // A separate password sign-in cannot reuse the proof from the enrollment session.
  const fresh = { ...a, cookie: '' };
  const signed = await authPost(fresh, 'sign-in/email', { email: a.email, password: 'a-long-enough-password' });
  assert.equal(signed.status, 200); assert.equal((await signed.json()).twoFactorRedirect, true);
  assert.match((await get('/mfa', { cookie: fresh.cookie })).body, /Authenticator code/);
  assert.notEqual((await get('/admin', { cookie: fresh.cookie })).status, 200);
  assert.equal((await authPost(fresh, 'two-factor/verify-totp', { code: wrongTotp(totpURI) })).status, 401);
  assert.notEqual((await get('/admin', { cookie: fresh.cookie })).status, 200);
  assert.equal((await authPost(fresh, 'two-factor/verify-totp', { code: totp(totpURI) })).status, 200);
  assert.equal((await get('/admin', { cookie: fresh.cookie })).status, 200);
});

test('normal desktop users sign in without MFA', { skip }, async () => {
  const u = await person('nomfa', 'user'); u.cookie = '';
  const r = await authPost(u, 'sign-in/email', { email: u.email, password: 'a-long-enough-password' });
  assert.equal(r.status, 200); const body = await r.json();
  assert.ok(body.token); assert.ok(!body.twoFactorRedirect);
  assert.equal((await get('/', { cookie: u.cookie })).status, 200);
  assert.match((await get('/admin', { cookie: u.cookie })).location ?? '', /denied=1/);
});

test('admin host allow-list: only listed hostnames, no ports tricks, fail closed', () => {
  assert.equal(adminHostAllowed('127.0.0.1:8791', '127.0.0.1'), true);
  assert.equal(adminHostAllowed('100.95.14.113', '100.95.14.113, tanmay-hp'), true);
  assert.equal(adminHostAllowed('TANMAY-HP:8791', '100.95.14.113, tanmay-hp'), true);
  for (const h of ['auth.example.com', '127.0.0.1.evil.test', 'evil.test', '', null, undefined, 'localhost@evil.test']) assert.equal(adminHostAllowed(h as string, '127.0.0.1'), false, String(h));
  assert.equal(adminHostAllowed('localhost', undefined), true, 'unset means loopback only');
  assert.equal(adminHostAllowed('auth.example.com', undefined), false);
  assert.equal(adminHostAllowed('auth.example.com', ''), false, 'an empty list allows nothing');
});

test('the sign-in page renders, and an anonymous visitor is sent there from the admin console', { skip }, async () => {
  const page = await get('/sign-in');
  assert.equal(page.status, 200);
  assert.match(page.body, /Sign in to Agentic Office/);
  assert.match(page.body, /name="email"/);
  const admin = await get('/admin');
  assert.ok([302, 307].includes(admin.status), `got ${admin.status}`);
  assert.match(admin.location ?? '', /\/sign-in\?next=%2Fadmin/);
  assert.equal((await get('/admin/users/usr_x')).status === 404, false);
  assert.equal((await get('/api/health')).status, 200);
});

test('a signed-in person who is not an admin is turned away from every admin page', { skip }, async () => {
  const u = await person('plainuser', 'user');
  for (const path of ['/admin', '/admin/users', `/admin/users/${u.id}`, '/admin/coupons', '/admin/audit']) {
    const r = await get(path, { cookie: u.cookie });
    assert.ok([302, 307].includes(r.status), `${path}: ${r.status}`);
    assert.match(r.location ?? '', /denied=1/, path);
    assert.ok(!r.body.includes(u.email), `${path} leaked the page`);
  }
  assert.match((await get('/?denied=1', { cookie: u.cookie })).body, /administrators/);
});

test('an admin sees the console, with real data, and nothing secret in the page', { skip }, async () => {
  const a = await person('theadmin', 'admin');
  const target = await person('someone', 'user');
  const home = await get('/admin', { cookie: a.cookie });
  assert.equal(home.status, 200, home.body.slice(0, 300));
  assert.match(home.body, /Overview/);
  assert.match(home.body, /How Agentic Office is doing/);
  const users = await get(`/admin/users?q=${encodeURIComponent(target.email)}`, { cookie: a.cookie });
  assert.equal(users.status, 200);
  assert.ok(users.body.includes(target.email), 'the search finds them');
  const detail = await get(`/admin/users/${target.id}`, { cookie: a.cookie });
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes(target.email));
  assert.match(detail.body, /Documents, transcripts and memories are encrypted/);
  const coupons = await get('/admin/coupons', { cookie: a.cookie });
  assert.equal(coupons.status, 200);
  assert.match(coupons.body, /never a credential/);
  assert.equal((await get('/admin/audit', { cookie: a.cookie })).status, 200);
  for (const html of [home.body, users.body, detail.body, coupons.body]) {
    assert.ok(!html.includes(SERVICE_TOKEN), 'the admin API token never reaches the browser');
    assert.ok(!/password|privateKey/i.test(html.replace(/type="password"|autoComplete="[^"]*"|autocomplete="[^"]*"/g, '')) || !html.includes('$argon') );
  }
  // viewing a user is itself audited, naming the admin as a person
  const seen = (await owner.query(`SELECT admin_user_id, detail FROM admin_audit WHERE action = 'view_user' AND target_user_id = $1`, [target.id])).rows;
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].admin_user_id, a.id);
  assert.equal(seen[0].detail.via, 'console');
});

test('through the public hostname the admin console does not exist, even for an admin', { skip }, async () => {
  const a = await person('publicadmin', 'admin');
  for (const host of ['auth.agenticoffice.example', 'evil.test', '127.0.0.1.evil.test']) {
    for (const path of ['/admin', '/admin/users', '/admin/coupons']) {
      const r = await get(path, { cookie: a.cookie, host });
      assert.equal(r.status, 404, `${host}${path}: ${r.status}`);
    }
  }
  assert.equal((await get('/sign-in', { host: 'auth.agenticoffice.example' })).status, 200, 'sign-in still works on the public name');
  assert.equal((await get('/admin', { cookie: a.cookie })).status, 200, 'and the private name still works');
});

test('a disabled admin loses the console at once', { skip }, async () => {
  const a = await person('fired', 'admin');
  assert.equal((await get('/admin', { cookie: a.cookie })).status, 200);
  await owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [a.id]);
  const r = await get('/admin', { cookie: a.cookie });
  assert.ok([302, 307].includes(r.status), String(r.status));
  assert.match(r.location ?? '', /disabled=1|denied=1|sign-in/);
});

test('reliability and analytics say who the numbers cover, and are empty rather than zero when nobody shares', { skip }, async () => {
  const a = await person('thereliab', 'admin');
  for (const [path, title, hint] of [['/admin/reliability', 'Reliability', /No shared runs in this period|active users share usage/], ['/admin/analytics', 'Product Analytics', /Nobody is sharing usage yet|active users share usage/]] as const) {
    const r = await get(path, { cookie: a.cookie });
    assert.equal(r.status, 200, `${path}: ${r.body.slice(0, 200)}`);
    assert.match(r.body, new RegExp(title)); assert.match(r.body, hint);
    assert.match(r.body, /active users share usage/, 'every figure is read against the people sharing');
    assert.doesNotMatch(r.body, /Not available yet/, 'built pages, not placeholders');
  }
});

test('operations pages render for an admin and take real input: a flag, an announcement, a ticket reply', { skip }, async () => {
  const a = await person('theops', 'admin');
  for (const [path, text] of [['/admin/flags', /Feature Flags/], ['/admin/communications', /Communications/], ['/admin/support', /Support/], ['/admin/infrastructure', /Infrastructure/], ['/admin/settings', /Integrations/]] as const) {
    const r = await get(path, { cookie: a.cookie });
    assert.equal(r.status, 200, `${path}: ${r.body.slice(0, 160)}`);
    assert.match(r.body, text); assert.doesNotMatch(r.body, /Not available yet/);
  }
  const key = `web.${tag}`;
  const page = await get('/admin/flags', { cookie: a.cookie });
  const made = await postForm('/admin/flags', renderedForm(page.body, 'Save flag', { key, rollout_pct: '50' }), a.cookie);
  assert.equal(made.status, 303, made.body.slice(0, 200)); assert.match(made.location, /msg=/);
  const row = (await owner.query('SELECT enabled, rollout_pct, updated_by FROM feature_flags WHERE key = $1', [key])).rows[0];
  assert.deepEqual([row.enabled, row.rollout_pct, row.updated_by], [false, 50, a.id]);
  const ann = await postForm('/admin/communications', renderedForm((await get('/admin/communications', { cookie: a.cookie })).body, 'Publish', { title: `Web ${tag}`, body: 'hello' }), a.cookie);
  assert.equal(ann.status, 303); assert.match(ann.location, /msg=/);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM announcements WHERE title = $1', [`Web ${tag}`])).rows[0].n, 1);
  const u = await person('theticketer', 'user');
  await owner.query(`INSERT INTO support_tickets(id, user_id, subject) VALUES ($1,$2,'Help') `, [`tkt_web_${tag}`, u.id]);
  await owner.query(`INSERT INTO support_messages(ticket_id, user_id, author, body) VALUES ($1,$2,'user','It is broken')`, [`tkt_web_${tag}`, u.id]);
  const tp = await get(`/admin/support/tkt_web_${tag}`, { cookie: a.cookie });
  assert.match(tp.body, /It is broken/);
  const rep = await postForm(`/admin/support/tkt_web_${tag}`, renderedForm(tp.body, 'Send reply', { body: 'We are on it.' }), a.cookie);
  assert.equal(rep.status, 303); assert.match(rep.location, /msg=/);
  assert.deepEqual((await owner.query(`SELECT author, admin_user_id FROM support_messages WHERE ticket_id = $1 ORDER BY id`, [`tkt_web_${tag}`])).rows.map((r) => [r.author, r.admin_user_id]), [['user', null], ['admin', a.id]]);
  await owner.query('DELETE FROM feature_flags WHERE key = $1', [key]); await owner.query('DELETE FROM announcements WHERE title = $1', [`Web ${tag}`]);
});

test('the billing page shows what plans cost and a new plan is created with its price, switched off until it is on purpose', { skip }, async () => {
  const a = await person('thebilling', 'admin');
  const page = await get('/admin/billing', { cookie: a.cookie });
  assert.equal(page.status, 200); assert.match(page.body, /Free/); assert.match(page.body, /No price set/, 'the draft plans say they have no price');
  const id = `webplan${tag}`.slice(0, 30);
  const made = await postForm('/admin/billing', renderedForm(page.body, 'Create plan', { id, name: 'Web plan', price: '12.50', billing_interval: 'month', monthly_credits: '2500', max_concurrent_runs: '3', requests_per_minute: '90', allowed_models: 'model-a, model-b' }), a.cookie);
  assert.equal(made.status, 303, made.body.slice(0, 200)); assert.match(made.location, /msg=/);
  const row = (await owner.query(`SELECT pp.amount_minor, pp.currency, pp.billing_interval, p.monthly_credits, p.active, p.max_concurrent_runs, p.requests_per_minute, p.allowed_models FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id WHERE p.id = $1`, [id])).rows[0];
  assert.deepEqual([Number(row.amount_minor), row.currency, row.billing_interval, Number(row.monthly_credits), row.active], [1250, 'inr', 'month', 2500, true], 'rupees became paise in the price table; a priced plan is on');
  assert.deepEqual([row.max_concurrent_runs, row.requests_per_minute, row.allowed_models], [3, 90, ['model-a', 'model-b']], 'the limits the form carries are saved on the plan');
  const after = await get('/admin/billing', { cookie: a.cookie });
  assert.match(after.body, /₹12\.50 \/ month/);
  await owner.query('DELETE FROM plans WHERE id = $1', [id]);
});

test('an admin API failure is shown as a message, not a crash', { skip }, async () => {
  const a = await person('unlucky', 'admin');
  const r = await get('/admin/users/usr_does_not_exist', { cookie: a.cookie });
  assert.equal(r.status, 200);
  assert.match(r.body, /No such user/);
});

test('sign-in attempts are rate limited per client address, and one noisy address does not lock out another', { skip }, async () => {
  const email = `ratelimit.${tag}@example.test`;
  const attempt = (ip: string) => fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-test-ip': ip }, body: JSON.stringify({ email, password: 'wrong-password-wrong' }) });
  const statuses: number[] = [];
  for (let i = 0; i < 15; i++) statuses.push((await attempt('203.0.113.7')).status);
  assert.ok(statuses.includes(429), `15 rapid failures from one address were never limited: ${statuses.join(',')}`);
  assert.notEqual((await attempt('203.0.113.99')).status, 429, 'another address is unaffected');
});

// Submit the rendered form, including React's generated $ACTION_* fields. This deliberately
// does not import actions.ts or call the backing API: Next's browser POST path is under test.
const unhtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (html: string, key: string) => unhtml(new RegExp(`\\b${key}="([^"]*)"`).exec(html)?.[1] ?? '');
function renderedForm(html: string, button: string, values: Record<string, string>) {
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[0]);
  const selected = forms.filter((f) => [...f.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].some((m) => unhtml(m[1]) === button));
  assert.equal(selected.length, 1, `expected exactly one ${button} form`);
  const form = selected[0], data = new FormData();
  for (const [input] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(input, 'name');
    if (name && !/\bdisabled(?:[\s=>])/.test(input)) data.append(name, attr(input, 'value'));
  }
  for (const [select, options] of form.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)) {
    const name = attr(select, 'name');
    const opts = [...options.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
    const chosen = opts.find((m) => /\bselected/.test(m[1])) ?? opts[0];
    if (name && chosen) data.append(name, /\bvalue=/.test(chosen[1]) ? attr(chosen[1], 'value') : unhtml(chosen[2]));
  }
  for (const [area, content] of form.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/g)) { const name = attr(area, 'name'); if (name) data.append(name, unhtml(content)); }
  assert.ok([...data.keys()].some((k) => k.startsWith('$ACTION_')), 'Next generated action fields must be present');
  for (const [k, v] of Object.entries(values)) { assert.ok(data.has(k), `rendered control ${k}`); data.set(k, v); }
  return data;
}
async function postForm(path: string, data: FormData, cookie: string, host = `127.0.0.1:${port}`) {
  const encoded = new Response(data), bytes = Buffer.from(await encoded.arrayBuffer());
  return new Promise<{ status: number; location: string; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: {
      host, origin: `http://${host}`, cookie, accept: 'text/html', 'content-type': encoded.headers.get('content-type')!, 'content-length': bytes.length,
    } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? ''), body }));
    });
    req.on('error', reject); req.end(bytes);
  });
}

for (const action of ['grant credits', 'set plan', 'set role', 'disable user', 'create coupon', 'disable coupon']) {
  test(`rendered admin form: ${action}, persisted and audited; non-admin, password-only admin and wrong host cannot mutate`, { skip }, async () => {
    const a = await person(`formadmin${action.replaceAll(' ', '')}`, 'admin');
    const u = await person(`formuser${action.replaceAll(' ', '')}`, 'user');
    const weak = await person(`weakadmin${action.replaceAll(' ', '')}`, 'admin', false);
    const coupon = action.includes('coupon'), code = `FORM-${action.replaceAll(' ', '-').toUpperCase()}-${tag.toUpperCase()}`;
    const path = coupon ? '/admin/coupons' : `/admin/users/${u.id}`;
    if (action === 'disable coupon') {
      const page = await get(path, { cookie: a.cookie });
      const made = await postForm(path, renderedForm(page.body, 'Create', { code, amount: '83', note: 'form fixture' }), a.cookie);
      assert.equal(made.status, 303); assert.match(made.location, /msg=/);
    }
    const buttons: Record<string, string> = { 'grant credits': 'Record', 'set plan': 'Set plan', 'set role': 'Change role', 'disable user': 'Disable account', 'create coupon': 'Create', 'disable coupon': 'Disable' };
    const values: Record<string, Record<string, string>> = {
      'grant credits': { amount: '123', reason: 'form integration grant', pool: 'paid', kind: 'grant' },
      'set plan': { plan_id: 'beta' }, 'set role': { role: 'admin' }, 'disable user': {},
      'create coupon': { code, amount: '83', pool: 'promo', max_redemptions: '4', note: 'form integration coupon' },
      'disable coupon': {},
    };
    const page = await get(path, { cookie: a.cookie }); assert.equal(page.status, 200);
    // A page can contain several coupon rows. Keep the real target form, with its action fields.
    const html = action === 'disable coupon' ? [...page.body.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]).find((f) => f.includes(`value="${code}"`))! : page.body;
    const form = () => renderedForm(html, buttons[action], values[action]);
    const snapshot = async () => (await owner.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(u)) FROM users u WHERE id = $1) AS person,
      (SELECT jsonb_agg(to_jsonb(s)) FROM subscriptions s WHERE user_id = $1) AS subscription,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM credit_ledger l WHERE user_id = $1) AS ledger,
      (SELECT jsonb_agg(to_jsonb(c)) FROM coupons c WHERE code = $2) AS coupon,
      (SELECT count(*)::int FROM admin_audit) AS audits`, [u.id, code])).rows[0];
    for (const [who, host] of [[u, undefined], [weak, undefined], [a, 'public.example.test']] as const) {
      const before = await snapshot();
      const denied = await postForm(path, form(), who.cookie, host);
      assert.ok([303, 307, 404].includes(denied.status), `denied POST: ${denied.status}`);
      assert.deepEqual(await snapshot(), before, 'denied POST must change neither data nor audit');
    }
    const auditBefore = (await owner.query('SELECT count(*)::int AS n FROM admin_audit WHERE admin_user_id = $1', [a.id])).rows[0].n;
    const result = await postForm(path, form(), a.cookie);
    assert.equal(result.status, 303, result.body.slice(0, 300));
    assert.match(result.location, /msg=/); assert.doesNotMatch(result.location, /err=/);
    const actions: Record<string, string> = { 'grant credits': 'adjust_credits', 'set plan': 'set_plan', 'set role': 'set_role', 'disable user': 'disable', 'create coupon': 'create_coupon', 'disable coupon': 'disable_coupon' };
    const audit = (await owner.query('SELECT * FROM admin_audit WHERE admin_user_id = $1 AND action = $2', [a.id, actions[action]])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].detail.via, 'console');
    assert.equal(audit[0].target_user_id, coupon ? null : u.id);
    assert.ok((await owner.query('SELECT count(*)::int AS n FROM admin_audit WHERE admin_user_id = $1', [a.id])).rows[0].n > auditBefore);
    if (action === 'grant credits') {
      const ledger = (await owner.query('SELECT amount::text, pool, kind, reason, created_by FROM credit_ledger WHERE user_id = $1', [u.id])).rows;
      assert.deepEqual(ledger, [{ amount: '123', pool: 'paid', kind: 'grant', reason: 'form integration grant', created_by: a.id }]);
      assert.equal(audit[0].detail.amount, 123);
    } else if (action === 'set plan') {
      const sub = (await owner.query('SELECT plan_id, source FROM subscriptions WHERE user_id = $1', [u.id])).rows[0];
      assert.deepEqual(sub, { plan_id: 'beta', source: `admin ${a.id}` }); assert.equal(audit[0].detail.plan_id, 'beta');
    } else if (action === 'set role') {
      assert.equal((await owner.query('SELECT role FROM users WHERE id = $1', [u.id])).rows[0].role, 'admin'); assert.equal(audit[0].detail.role, 'admin');
    } else if (action === 'disable user') {
      assert.equal((await owner.query('SELECT status FROM users WHERE id = $1', [u.id])).rows[0].status, 'disabled');
      assert.equal((await authPost(u, 'sign-in/email', { email: u.email, password: 'a-long-enough-password' })).ok, false, 'a disabled person cannot sign in');
    } else {
      const row = (await owner.query('SELECT amount::text, active, created_by FROM coupons WHERE code = $1', [code])).rows[0];
      assert.deepEqual(row, { amount: '83', active: action === 'create coupon', created_by: a.id }); assert.equal(audit[0].detail.code, code);
    }
  });
}

test('admin two-factor is on by default and only an exact "false" switches it off', () => {
  assert.equal(adminMfaRequired(undefined), true);
  assert.equal(adminMfaRequired(''), true);
  assert.equal(adminMfaRequired('true'), true);
  for (const typo of ['flase', 'off', '0', 'no', 'fals', 'false-ish']) assert.equal(adminMfaRequired(typo), true, typo);
  assert.equal(adminMfaRequired('false'), false);
  assert.equal(adminMfaRequired(' FALSE '), false);
});

test('payments and notifications pages: a finance admin sees them, an analyst cannot settle, and the bell lists what needs attention', { skip }, async () => {
  const fin = await person('thefinance', 'admin');
  await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,'finance') ON CONFLICT (user_id) DO UPDATE SET role='finance'`, [fin.id]);
  const list = await get('/admin/payments', { cookie: fin.cookie });
  assert.equal(list.status, 200); assert.match(list.body, /Payments/);
  assert.match((await get('/admin/notifications', { cookie: fin.cookie })).body, /Notifications/);
  const an = await person('theanalyst', 'admin');
  await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,'analyst') ON CONFLICT (user_id) DO UPDATE SET role='analyst'`, [an.id]);
  const denied = await get('/admin/payments', { cookie: an.cookie });
  assert.match(denied.body, /not allowed|forbidden|permission|You do not have/i, 'an analyst has no payments page');
  const bad = await get('/admin/payments/ord_doesnotexist12345', { cookie: fin.cookie });
  assert.equal(bad.status, 404);
});

test('growth pages: an analyst can read them but has no way to change anything; a superadmin creates a campaign through the rendered form, persisted and audited', { skip }, async () => {
  const boss = await person('growthboss', 'admin');
  await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,'superadmin') ON CONFLICT (user_id) DO UPDATE SET role='superadmin'`, [boss.id]);
  const an = await person('growthanalyst', 'admin');
  await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,'analyst') ON CONFLICT (user_id) DO UPDATE SET role='analyst'`, [an.id]);
  for (const [path, title] of [['/admin/growth', /Growth/], ['/admin/growth/campaigns', /Campaigns/], ['/admin/growth/releases', /Releases/], ['/admin/growth/email', /Campaign email/]] as const) {
    const r = await get(path, { cookie: boss.cookie });
    assert.equal(r.status, 200, path); assert.match(r.body, title, path);
    assert.equal((await get(path, { cookie: an.cookie })).status, 200, `${path} readable by an analyst`);
  }
  const anList = await get('/admin/growth/campaigns', { cookie: an.cookie });
  assert.doesNotMatch(anList.body, /New campaign/, 'an analyst is not offered the form');
  const page = await get('/admin/growth/campaigns', { cookie: boss.cookie });
  const name = `Launch ${tag}`;
  const form = renderedForm(page.body, 'Create', { name });
  const sent = await postForm('/admin/growth/campaigns', form, boss.cookie);
  assert.ok([200, 303].includes(sent.status), `status ${sent.status}`);
  const row = (await owner.query(`SELECT id, status, created_by FROM campaigns WHERE name = $1`, [name])).rows[0];
  assert.ok(row, 'the campaign was stored'); assert.equal(row.status, 'draft'); assert.equal(row.created_by, boss.id);
  assert.ok((await owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE admin_user_id = $1 AND action ILIKE '%campaign%'`, [boss.id])).rows[0].n > 0, 'the change is on the audit trail');
  // the same form, replayed with an analyst's session, changes nothing
  const forged = await postForm('/admin/growth/campaigns', renderedForm(page.body, 'Create', { name: `Forged ${tag}` }), an.cookie);
  assert.ok(forged.status < 500);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM campaigns WHERE name = $1`, [`Forged ${tag}`])).rows[0].n, 0, 'an analyst cannot create a campaign');
  const detail = await get(`/admin/growth/campaigns/${row.id}`, { cookie: boss.cookie });
  assert.equal(detail.status, 200);
  await owner.query('DELETE FROM campaigns WHERE name = $1', [name]);
});
