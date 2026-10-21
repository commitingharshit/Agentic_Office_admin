// The admin console's API: roles (RBAC), charts, sessions, sign-in sessions and devices, usage, plans, runs, admins.
// Runs on a database of its own (migrated from AO_TEST_PG's server) so totals and "the last superadmin" are exact.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';
import { ADMIN_ROLES, PERMISSIONS, can } from '../src/api/rbac.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const tag = Date.now().toString(36);
const DB = `ao_console_${tag}`;
const TOKEN = `console-token-${tag}-0123456789abcdef`;
const urlFor = (db: string, role?: string, pw?: string) => { const u = new URL(ownerUrl!); u.pathname = `/${db}`; if (role) { u.username = role; u.password = pw ?? ''; } return u.toString(); };
let server: Server, base: string, root: pg.Client, owner: pg.Client, ro: pg.Pool, adm: pg.Pool;

before(async () => {
  if (skip) return;
  root = new pg.Client({ connectionString: urlFor('postgres') }); await root.connect();
  // Test files that make their own database run side by side: creating from the same template can briefly collide, so retry.
  for (let i = 0; ; i++) {
    try { await root.query(`CREATE DATABASE ${DB}`); break; }
    catch (e) { if (i >= 20 || !/being accessed by other users|already exists|tuple concurrently/.test(String((e as Error).message))) { await root.end(); throw e; } await new Promise((r) => setTimeout(r, 150 + Math.random() * 350)); }
  }
  // Roles are cluster-wide, so migrating two databases at once can collide on them; that is a race between test files, not a bug.
  for (let i = 0; ; i++) {
    const m = spawnSync(process.execPath, ['db/migrate.ts'], { env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: 'utf8' });
    if (m.status === 0) break;
    if (i >= 8 || !/tuple concurrently|deadlock|already exists|being accessed/.test(m.stderr)) assert.fail(m.stderr);
    await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  }
  owner = new pg.Client({ connectionString: urlFor(DB) }); await owner.connect();
  ro = new pg.Pool({ connectionString: urlFor(DB, 'ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: urlFor(DB, 'ao_admin', process.env.AO_ADMIN_PASSWORD) });
  const handler = adminHandler({ ro, admin: adm, tokens: parseTokens(`console:${TOKEN}`) });
  server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (skip) return;
  server?.close();
  await Promise.all([ro?.end(), adm?.end(), owner?.end()]);
  await root?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await root?.end().catch(() => undefined);
});

type Res = { status: number; body: any; text: string };
const call = async (method: string, path: string, o: { body?: unknown; acting?: string; token?: string } = {}): Promise<Res> => {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${o.token ?? TOKEN}`, 'content-type': 'application/json', ...(o.acting ? { 'x-ao-acting-admin': o.acting } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await r.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, body, text };
};
const person = async (name: string, o: { role?: 'user' | 'admin'; admin_role?: string; status?: string } = {}) => {
  const id = `usr_${name.replace(/_/g, '')}${tag}`;   // real ids are usr_<alphanumerics>; the acting-admin header enforces that
  await owner.query(`INSERT INTO users(id, email, display_name, role, status) VALUES ($1,$2,$3,$4,$5)`, [id, `${name}.${tag}@example.test`, `Name ${name}`, o.role ?? 'user', o.status ?? 'active']);
  if (o.role === 'admin' && o.admin_role) await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,$2)`, [id, o.admin_role]);
  return id;
};

// ── the permission map itself ───────────────────────────────────────────────────────────────────
test('the permission map: superadmin can do everything; nobody else can delete, change roles or run all of it', { skip }, () => {
  for (const p of PERMISSIONS) assert.equal(can('superadmin', p), true, p);
  for (const role of ADMIN_ROLES.filter((r) => r !== 'superadmin')) {
    for (const p of ['users.delete', 'roles.write'] as const) assert.equal(can(role, p), false, `${role} ${p}`);
  }
  assert.equal(can('analyst', 'credits.write'), false);
  assert.equal(can('finance', 'users.write'), false);
  assert.equal(can('support', 'credits.write'), false);
  assert.equal(can('engineer', 'credits.read'), false);
});

// ── RBAC through the real HTTP router ───────────────────────────────────────────────────────────
test('every admin route is checked on the server, per role (the console hiding a button is not the control)', { skip }, async () => {
  const target = await person('victim');
  const ids: Record<string, string> = {};
  for (const role of ADMIN_ROLES) ids[role] = await person(`adm_${role}`, { role: 'admin', admin_role: role });
  // [method, path, body, roles that may] — explicit, written independently of the permission map
  const matrix: Array<[string, string, unknown, string[]]> = [
    ['GET', '/admin/overview', undefined, ['superadmin', 'engineer', 'support', 'finance', 'analyst']],
    ['GET', '/admin/users', undefined, ['superadmin', 'engineer', 'support', 'finance', 'analyst']],
    ['GET', `/admin/users/${target}/export`, undefined, ['superadmin', 'support']],
    ['POST', `/admin/users/${target}/enable`, undefined, ['superadmin', 'support']],
    ['DELETE', `/admin/users/usr_nobody_${tag}`, { confirm: 'x' }, ['superadmin']],
    ['GET', `/admin/users/${target}/credits`, undefined, ['superadmin', 'support', 'finance']],
    ['POST', `/admin/users/${target}/credits`, { amount: 5, reason: 'rbac matrix' }, ['superadmin', 'finance']],
    ['POST', '/admin/coupons', { code: `RBAC-${tag}-X`.toUpperCase(), amount: 1 }, ['superadmin', 'finance']],
    ['POST', `/admin/users/${target}/plan`, { plan_id: 'beta' }, ['superadmin', 'finance']],
    ['GET', `/admin/users/${target}/sign-ins`, undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', `/admin/users/${target}/keycloak`, undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', '/admin/sessions', undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', '/admin/auth-sessions', undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', '/admin/runs', undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', '/admin/reliability', undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['GET', '/admin/analytics', undefined, ['superadmin', 'engineer', 'finance', 'analyst']],
    ['GET', '/admin/flags', undefined, ['superadmin', 'engineer', 'support', 'analyst']],
    ['POST', '/admin/flags', { key: `rbac.${tag}`, enabled: false }, ['superadmin', 'engineer']],
    ['GET', '/admin/announcements', undefined, ['superadmin', 'support']],
    ['POST', '/admin/announcements', { title: 'rbac', body: 'rbac' }, ['superadmin', 'support']],
    ['POST', '/admin/announcements/ann_none/email', {}, ['superadmin', 'support']],
    ['GET', '/admin/tickets', undefined, ['superadmin', 'engineer', 'support']],
    ['POST', '/admin/tickets/tkt_none/reply', { body: 'x' }, ['superadmin', 'support']],
    ['GET', '/admin/usage/summary', undefined, ['superadmin', 'engineer', 'finance', 'analyst']],
    ['GET', '/admin/subscriptions', undefined, ['superadmin', 'support', 'finance', 'analyst']],
    ['GET', '/admin/audit', undefined, ['superadmin', 'engineer', 'support', 'finance']],
    ['POST', '/admin/sql', { sql: 'select 1' }, ['superadmin', 'engineer']],
    ['GET', '/admin/admins', undefined, ['superadmin', 'engineer']],
    ['POST', `/admin/users/${target}/admin-role`, { admin_role: 'analyst' }, ['superadmin']],
    ['POST', `/admin/users/${target}/role`, { role: 'user' }, ['superadmin']],
  ];
  for (const [method, path, body, allowed] of matrix) {
    for (const role of ADMIN_ROLES) {
      const r = await call(method, path, { body, acting: ids[role] });
      const should = allowed.includes(role);
      if (should) assert.notEqual(r.status, 403, `${role} should be allowed ${method} ${path}: ${r.text.slice(0, 120)}`);
      else assert.equal(r.status, 403, `${role} must be refused ${method} ${path}: got ${r.status}`);
    }
  }
  const denied = (await owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'denied'`)).rows[0].n;
  assert.ok(denied > 20, `denials are audited (${denied})`);
  const sample = (await owner.query(`SELECT admin_user_id, detail FROM admin_audit WHERE action = 'denied' AND admin_user_id = $1 LIMIT 1`, [ids.analyst])).rows[0];
  assert.equal(sample.detail.role, 'analyst'); assert.ok(sample.detail.need);
});

test('who may act at all: a plain user, a disabled admin, an unknown id and a malformed header are refused', { skip }, async () => {
  const plain = await person('plainuser'), off = await person('offadmin', { role: 'admin', admin_role: 'superadmin', status: 'disabled' });
  for (const acting of [plain, off, `usr_nobody${tag}`]) assert.equal((await call('GET', '/admin/users', { acting })).status, 403, acting);
  assert.equal((await call('GET', '/admin/users', { acting: 'not-a-user-id' })).status, 400);
  assert.equal((await call('GET', '/admin/users', { token: 'wrong-token-wrong-token-wrong-token' })).status, 403);
  assert.equal((await fetch(`${base}/admin/users`)).status, 401);
});

test('an admin with no admin_roles row keeps full power (how it worked before roles), and /me tells the console what it may do', { skip }, async () => {
  const legacy = await person('legacyadm', { role: 'admin' });
  const me = await call('GET', '/admin/me', { acting: legacy });
  assert.equal(me.body.role, 'superadmin');
  assert.ok(me.body.permissions.includes('roles.write'));
  const sup = await person('meadm_support', { role: 'admin', admin_role: 'support' });
  const m2 = await call('GET', '/admin/me', { acting: sup });
  assert.deepEqual([m2.body.role, m2.body.permissions.includes('credits.write'), m2.body.permissions.includes('users.write')], ['support', false, true]);
  const svc = await call('GET', '/admin/me');
  assert.equal(svc.body.role, 'superadmin', 'the service token is the break-glass superadmin');
});

// ── admin role changes ──────────────────────────────────────────────────────────────────────────
test('promoting records an admin role; demoting removes it; the last superadmin cannot be changed away', { skip }, async () => {
  await owner.query(`UPDATE users SET role = 'user' WHERE role = 'admin'`); await owner.query('DELETE FROM admin_roles');
  const a = await person('sa1'), b = await person('sa2'), c = await person('eng1');
  assert.equal((await call('POST', `/admin/users/${a}/role`, { body: { role: 'admin' } })).status, 200);
  assert.equal((await owner.query('SELECT role FROM admin_roles WHERE user_id = $1', [a])).rows[0].role, 'superadmin', 'default is superadmin');
  assert.equal((await call('POST', `/admin/users/${c}/role`, { body: { role: 'admin', admin_role: 'engineer' } })).status, 200);
  assert.equal((await owner.query('SELECT role FROM admin_roles WHERE user_id = $1', [c])).rows[0].role, 'engineer');
  assert.equal((await call('POST', `/admin/users/${c}/role`, { body: { role: 'admin', admin_role: 'wizard' } })).status, 400);
  // the only superadmin: no demotion, no change to another kind
  assert.equal((await call('POST', `/admin/users/${a}/admin-role`, { body: { admin_role: 'support' } })).status, 409);
  assert.equal((await call('POST', `/admin/users/${a}/role`, { body: { role: 'user' } })).status, 409);
  // an engineer may be demoted freely, and a second superadmin makes the first changeable
  assert.equal((await call('POST', `/admin/users/${c}/role`, { body: { role: 'user' } })).status, 200);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM admin_roles WHERE user_id = $1', [c])).rows[0].n, 0, 'demoting removes the role row');
  assert.equal((await call('POST', `/admin/users/${b}/role`, { body: { role: 'admin' } })).status, 200);
  assert.equal((await call('POST', `/admin/users/${a}/admin-role`, { body: { admin_role: 'support' }, acting: b })).status, 200);
  assert.equal((await call('POST', `/admin/users/${a}/admin-role`, { body: { admin_role: 'support' }, acting: b })).status, 200, 'idempotent');
  // self-changes are refused; a non-admin has no admin role to change
  assert.equal((await call('POST', `/admin/users/${b}/admin-role`, { body: { admin_role: 'analyst' }, acting: b })).status, 409);
  const plain = await person('notadmin');
  assert.equal((await call('POST', `/admin/users/${plain}/admin-role`, { body: { admin_role: 'analyst' } })).status, 409);
  // two superadmins demoted at the same moment: one wins
  await call('POST', `/admin/users/${a}/admin-role`, { body: { admin_role: 'superadmin' }, acting: b });
  const [r1, r2] = await Promise.all([call('POST', `/admin/users/${a}/role`, { body: { role: 'user' } }), call('POST', `/admin/users/${b}/role`, { body: { role: 'user' } })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`)).rows[0].n, 1);
  const list = await call('GET', '/admin/admins');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.roles, [...ADMIN_ROLES]);
  assert.equal(list.body.admins.length, 1);
});

// ── users list: filters, plan, pagination, privacy of CSV ───────────────────────────────────────
test('the user directory filters by role and plan, pages on the server, and exports a safe CSV', { skip }, async () => {
  const beta = await person('betauser'); await owner.query(`INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,'beta')`, [beta]);
  for (let i = 0; i < 7; i++) await person(`bulk${i}`);
  const betas = await call('GET', '/admin/users?plan=beta&pageSize=5');
  assert.ok(betas.body.users.every((u: any) => u.plan_id === 'beta') && betas.body.users.length >= 1);
  const admins = await call('GET', '/admin/users?role=admin');
  assert.ok(admins.body.users.every((u: any) => u.role === 'admin'));
  const p0 = await call('GET', '/admin/users?pageSize=5&page=0&sort=email&dir=asc'), p1 = await call('GET', '/admin/users?pageSize=5&page=1&sort=email&dir=asc');
  assert.equal(p0.body.users.length, 5);
  assert.ok(p0.body.total >= 12 && p1.body.users.length >= 1);
  assert.equal(p0.body.users.some((u: any) => p1.body.users.some((v: any) => v.id === u.id)), false, 'pages do not overlap');
  assert.ok(p0.body.users.every((u: any) => typeof u.promo === 'number' && typeof u.paid === 'number'));
  assert.equal((await call('GET', '/admin/users?pageSize=100000')).body.pageSize, 200, 'the page size is capped');
  const evil = await person('csvinjector'); await owner.query(`UPDATE users SET display_name = '=HYPERLINK("http://evil.test")' WHERE id = $1`, [evil]);
  const csv = await call('GET', '/admin/users?format=csv&q=csvinjector');
  assert.ok(csv.text.includes(`"=HYPERLINK`), 'a formula-looking cell is quoted so a spreadsheet will not run it');
});

// ── charts and activity ─────────────────────────────────────────────────────────────────────────
test('the overview series equals what is in the database, day by day', { skip }, async () => {
  const u = await person('chartuser');
  await owner.query(`DELETE FROM session_events; DELETE FROM usage_events; DELETE FROM credit_reservations; DELETE FROM credit_ledger`);
  await owner.query(`INSERT INTO sessions(id, user_id) VALUES ($1,$2)`, [`ses_c_${tag}`, u]);
  for (let i = 1; i <= 4; i++) await owner.query(`INSERT INTO session_events(event_id, user_id, session_id, sequence, type, created_at) VALUES ($1,$2,$3,$4,'tool.call', now())`, [`ev_c${i}_${tag}`, u, `ses_c_${tag}`, i]);
  await owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason) VALUES ($1,'grant','paid',500,'t'), ($1,'grant','promo',70,'t')`, [u]);
  await owner.query(`INSERT INTO credit_reservations(id, user_id, amount, status, request_id, expires_at) VALUES (9001,$1,40,'settled','r1', now() + interval '1 hour')`, [u]);
  await owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id) VALUES ($1,'settle','paid',-40,9001)`, [u]);
  await owner.query(`INSERT INTO usage_events(user_id, reservation_id, request_id, model, tokens_in, tokens_out, cost) VALUES ($1,9001,'q1','m-a',100,50,40)`, [u]);
  const s = await call('GET', '/admin/overview/series?days=7');
  assert.equal(s.status, 200);
  assert.equal(s.body.series.length, 7);
  const today = s.body.series[6];
  assert.equal(today.sync_events, 4); assert.equal(today.model_requests, 1); assert.equal(today.tokens, 150);
  assert.equal(today.credits_granted, 570); assert.equal(today.credits_spent, 40);
  assert.equal(today.active_users, 1, 'one person synced and used a model today');
  assert.ok(today.signups >= 1);
  assert.equal(s.body.totals.credits_granted, 570);
  assert.ok(s.body.note.includes('not a login count'));
  assert.equal((await call('GET', '/admin/overview/series?days=100000')).body.series.length, 90, 'the window is capped');
  assert.equal((await call('GET', '/admin/overview/series?days=abc')).body.series.length, 14, 'a bad value falls back to the default');
});

test('the activity feed leaves out page views and names real events', { skip }, async () => {
  const u = await person('activityuser');
  await call('POST', `/admin/users/${u}/credits`, { body: { amount: 12, reason: 'feed check' }, acting: undefined });
  await call('GET', `/admin/users/${u}`);   // a view: must not appear
  const feed = await call('GET', '/admin/activity?limit=50');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.events.some((e: any) => /^(view_|list_)/.test(e.label)), false);
  assert.ok(feed.body.events.some((e: any) => e.kind === 'credits' && /grant paid 12/.test(e.label)));
  assert.ok(feed.body.events.some((e: any) => e.kind === 'signup'));
  const times = feed.body.events.map((e: any) => +new Date(e.at)); assert.deepEqual(times, [...times].sort((x, y) => y - x), 'newest first');
});

// ── sessions: ids, counts and types only ────────────────────────────────────────────────────────
test('sessions show ids, counts, types and times, never titles, workspace names or payloads', { skip }, async () => {
  const u = await person('sessionuser');
  await owner.query(`INSERT INTO workspaces(id, user_id, name) VALUES ($1,$2,'SECRET-WORKSPACE-NAME')`, [`ws_s_${tag}`, u]);
  await owner.query(`INSERT INTO sessions(id, user_id, workspace_id, title) VALUES ($1,$2,$3,'SECRET-SESSION-TITLE')`, [`ses_s_${tag}`, u, `ws_s_${tag}`]);
  const kinds = ['user.message', 'assistant.message', 'tool.call', 'tool.call', 'run.state'];
  for (let i = 0; i < kinds.length; i++) await owner.query(`INSERT INTO session_events(event_id, user_id, session_id, sequence, type, payload, created_at) VALUES ($1,$2,$3,$4,$5, $6, now())`, [`ev_s${i}_${tag}`, u, `ses_s_${tag}`, i + 1, kinds[i], Buffer.from('SECRET-PAYLOAD-BYTES')]);
  await owner.query(`INSERT INTO agent_runs(run_id, user_id, session_id, agent_id, state, started_at, tokens_in, tokens_out) VALUES ($1,$2,$3,'agent-x','succeeded', now(), 10, 20)`, [`run_s_${tag}`, u, `ses_s_${tag}`]);
  const list = await call('GET', `/admin/sessions?user_id=${u}`);
  const detail = await call('GET', `/admin/sessions/ses_s_${tag}`);
  assert.equal(list.status, 200); assert.equal(detail.status, 200);
  assert.equal(list.body.sessions[0].events, 5);
  assert.deepEqual(detail.body.types.map((t: any) => [t.type, t.events]).sort(), [['assistant.message', 1], ['run.state', 1], ['tool.call', 2], ['user.message', 1]]);
  assert.equal(detail.body.summary.last_sequence, 5);
  assert.equal(detail.body.runs.length, 1);
  for (const r of [list, detail, await call('GET', `/admin/users/${u}`), await call('GET', `/admin/users/${u}/export`), await call('GET', '/admin/sessions')]) {
    for (const secret of ['SECRET-SESSION-TITLE', 'SECRET-WORKSPACE-NAME', 'SECRET-PAYLOAD-BYTES', Buffer.from('SECRET-PAYLOAD-BYTES').toString('base64')])
      assert.equal(r.text.includes(secret), false, `a response leaked ${secret}`);
  }
  assert.equal((await call('GET', '/admin/sessions/ses_nope')).status, 404);
  assert.equal((await call('GET', `/admin/sessions?user_id=${encodeURIComponent("x'; drop table users;--")}`)).status, 400);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0, true, 'and the injection attempt did nothing');
});

// ── sign-in sessions and devices ────────────────────────────────────────────────────────────────
test('sign-in sessions list without secrets, and a device or browser session can be revoked, only for its own person', { skip }, async () => {
  const u = await person('authuser'), other = await person('otherauth');
  await owner.query(`INSERT INTO auth_sessions(id, user_id, token, expires_at, ip_address, user_agent) VALUES ('bs1_${tag}',$1,'SECRET-BROWSER-TOKEN-1', now() + interval '1 day','10.0.0.5','Test Agent'), ('bs2_${tag}',$1,'SECRET-BROWSER-TOKEN-2', now() + interval '1 day','10.0.0.6','Other Agent')`, [u]);
  await owner.query(`INSERT INTO device_tokens(id, user_id, token_hash, device_name, platform, expires_at) VALUES ('dt1_${tag}',$1,'HASH-SECRET-1','laptop','darwin', now() + interval '30 days'), ('dt2_${tag}',$1,'HASH-SECRET-2','desktop','win32', now() + interval '30 days')`, [u]);
  const l = await call('GET', `/admin/auth-sessions?user_id=${u}`);
  assert.equal(l.body.browser.length, 2); assert.equal(l.body.devices.length, 2);
  assert.equal(l.text.includes('SECRET-BROWSER-TOKEN'), false, 'browser tokens are never shown');
  assert.equal(l.text.includes('HASH-SECRET'), false, 'token hashes are never shown');
  assert.ok(l.body.devices.every((d: any) => d.live === true));
  // revoke one device: only that person's, only once
  assert.equal((await call('POST', `/admin/users/${other}/devices/dt1_${tag}/revoke`)).status, 404, 'someone else\'s device');
  assert.equal((await call('POST', `/admin/users/${u}/devices/dt1_${tag}/revoke`)).status, 200);
  assert.equal((await call('POST', `/admin/users/${u}/devices/dt1_${tag}/revoke`)).status, 404, 'already revoked');
  const after = await call('GET', `/admin/auth-sessions?user_id=${u}`);
  assert.deepEqual(after.body.devices.map((d: any) => [d.id, d.live]).sort(), [[`dt1_${tag}`, false], [`dt2_${tag}`, true]]);
  // browser sessions: one, then the rest
  assert.equal((await call('POST', `/admin/users/${other}/browser-sessions/revoke`, { body: { session_id: `bs1_${tag}` } })).body.revoked, 0, 'not theirs');
  assert.equal((await call('POST', `/admin/users/${u}/browser-sessions/revoke`, { body: { session_id: `bs1_${tag}` } })).body.revoked, 1);
  assert.equal((await call('POST', `/admin/users/${u}/browser-sessions/revoke`, { body: {} })).body.revoked, 1);
  assert.equal((await call('GET', `/admin/auth-sessions?user_id=${u}`)).body.browser.length, 0);
  const audit = (await owner.query(`SELECT action FROM admin_audit WHERE target_user_id = $1 ORDER BY id`, [u])).rows.map((r) => r.action);
  assert.ok(audit.includes('revoke_device') && audit.includes('revoke_browser_sessions'));
});

// ── usage, subscriptions, plans ─────────────────────────────────────────────────────────────────
test('usage summaries add up by model, user and day, and say only managed inference is counted', { skip }, async () => {
  const a = await person('usagea'), b = await person('usageb');
  await owner.query(`DELETE FROM usage_events; DELETE FROM credit_reservations`);
  for (const [i, [u, model, tin, tout, cost]] of ([[a, 'm-a', 100, 50, 40], [a, 'm-a', 10, 5, 4], [b, 'm-b', 1000, 500, 400]] as Array<[string, string, number, number, number]>).entries()) {
    await owner.query(`INSERT INTO credit_reservations(id, user_id, amount, status, request_id, expires_at) VALUES ($1,$2,$3,'settled',$4, now() + interval '1 hour')`, [9100 + i, u, cost, `rq${i}`]);
    await owner.query(`INSERT INTO usage_events(user_id, reservation_id, request_id, model, tokens_in, tokens_out, cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [u, 9100 + i, `rq${i}`, model, tin, tout, cost]);
  }
  const byModel = await call('GET', '/admin/usage/summary?by=model&days=30');
  assert.deepEqual(byModel.body.rows.map((r: any) => [r.key, r.requests, r.cost]), [['m-b', 1, 400], ['m-a', 2, 44]]);
  assert.deepEqual([byModel.body.totals.requests, byModel.body.totals.cost, byModel.body.totals.tokens_in], [3, 444, 1110]);
  const byUser = await call('GET', '/admin/usage/summary?by=user');
  assert.equal(byUser.body.rows[0].label, `usageb.${tag}@example.test`);
  assert.equal((await call('GET', '/admin/usage/summary?by=day')).body.rows.length, 1);
  assert.ok(/own API key|local model/.test(byModel.body.note));
  assert.equal((await call('GET', '/admin/usage/summary?by=garbage;drop')).body.by, 'model', 'an unknown grouping falls back, it is never put in SQL');
});

test('plans can be created and changed with guards; subscriptions list; the free plan stays', { skip }, async () => {
  const bad = ['', 'UPPER', 'has space', 'x'.repeat(41), 'a;b'];
  for (const id of bad) assert.equal((await call('POST', '/admin/plans', { body: { id, name: 'X' } })).status, 400, id);
  assert.equal((await call('POST', '/admin/plans', { body: { id: 'proplus', name: '' } })).status, 400);
  assert.equal((await call('POST', '/admin/plans', { body: { id: 'proplus', name: 'Pro plus', price_cents: 1000, managed_inference: true, features: { seats: 1 } } })).status, 201);
  assert.equal((await call('POST', '/admin/plans', { body: { id: 'proplus', name: 'Again', price_cents: 1 } })).status, 409);
  assert.equal((await call('POST', '/admin/plans/proplus', { body: { name: 'Pro Plus', managed_inference: false } })).status, 200);
  const plans = (await call('GET', '/admin/plans')).body.plans;
  const pro = plans.find((p: any) => p.id === 'proplus');
  assert.deepEqual([pro.name, pro.managed_inference, pro.features], ['Pro Plus', false, { seats: 1 }]);
  assert.equal((await call('POST', '/admin/plans/free', { body: { active: false } })).status, 409, 'the default plan cannot be switched off');
  assert.equal((await call('POST', '/admin/plans/proplus', { body: {} })).status, 400, 'nothing to change');
  assert.equal((await call('POST', '/admin/plans/nope', { body: { name: 'x' } })).status, 404);
  const u = await person('subuser');
  assert.equal((await call('POST', `/admin/users/${u}/plan`, { body: { plan_id: 'proplus' } })).status, 200);
  const subs = await call('GET', '/admin/subscriptions?plan=proplus');
  assert.ok(subs.body.subscriptions.some((s: any) => s.user_id === u && s.plan_id === 'proplus'));
  assert.ok(typeof subs.body.on_default_plan === 'number');
  assert.equal((await call('GET', `/admin/users?plan=proplus`)).body.users.some((x: any) => x.id === u), true);
});

// ── runs (empty until people share usage) ───────────────────────────────────────────────────────
test('runs list and detail work, show how many people have data, and are empty rather than invented', { skip }, async () => {
  await owner.query('DELETE FROM agent_runs');
  const empty = await call('GET', '/admin/runs');
  assert.equal(empty.status, 200); assert.equal(empty.body.total, 0); assert.equal(empty.body.coverage.users_with_runs, 0);
  const u = await person('runuser');
  await owner.query(`INSERT INTO sessions(id, user_id) VALUES ($1,$2)`, [`ses_r_${tag}`, u]);
  await owner.query(`INSERT INTO agent_runs(run_id, user_id, session_id, agent_id, state, started_at, ended_at, tokens_in, tokens_out) VALUES ($1,$2,$3,'planner','succeeded', now() - interval '2 minutes', now() - interval '1 minute', 100, 200)`, [`run_p_${tag}`, u, `ses_r_${tag}`]);
  await owner.query(`INSERT INTO agent_runs(run_id, user_id, session_id, parent_run_id, agent_id, state, started_at, tokens_in, tokens_out) VALUES ($1,$2,$3,$4,'word-specialist','failed', now() - interval '90 seconds', 5, 6)`, [`run_c_${tag}`, u, `ses_r_${tag}`, `run_p_${tag}`]);
  const list = await call('GET', `/admin/runs?user_id=${u}`);
  assert.equal(list.body.total, 2); assert.equal(list.body.coverage.users_with_runs, 1);
  assert.deepEqual((await call('GET', `/admin/runs?state=failed&user_id=${u}`)).body.runs.map((r: any) => r.run_id), [`run_c_${tag}`]);
  const d = await call('GET', `/admin/runs/run_p_${tag}`);
  assert.equal(d.body.run.agent_id, 'planner'); assert.deepEqual(d.body.children.map((c: any) => [c.agent_id, c.state]), [['word-specialist', 'failed']]);
  assert.equal((await call('GET', '/admin/runs/run_nope')).status, 404);
});

test('reliability and analytics are computed from shared runs only, exactly, and say who the numbers cover', { skip }, async () => {
  await owner.query('DELETE FROM agent_runs'); await owner.query('DELETE FROM usage_consent');
  const empty = await call('GET', '/admin/reliability?days=30');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.totals.runs, 0); assert.equal(empty.body.totals.success_rate, null, 'no runs: no rate, not 0%');
  assert.equal(empty.body.coverage.users_sharing, 0);
  const a = await person('relia'), b = await person('relib'), c = await person('reliac');
  for (const u of [a, b]) await owner.query(`INSERT INTO usage_consent(user_id, shared) VALUES ($1, true)`, [u]);
  const run = (id: string, u: string, state: string, secs: number | null, extra: Record<string, unknown> = {}) => owner.query(
    `INSERT INTO agent_runs(run_id, user_id, agent_id, state, started_at, ended_at, tokens_in, tokens_out, model, mode, failure_category, client_version) VALUES ($1,$2,$3,$4, now() - interval '1 hour', CASE WHEN $5::int IS NULL THEN NULL ELSE now() - interval '1 hour' + ($5::int * interval '1 second') END, 10, 20, $6, $7, $8, '1.0.0')`,
    [`rel_${id}_${tag}`, u, extra.agent ?? 'executor', state, secs, extra.model ?? 'm-small', extra.mode ?? 'managed', extra.failure ?? null]);
  await run('1', a, 'succeeded', 10); await run('2', a, 'succeeded', 20); await run('3', a, 'succeeded', 30); await run('4', b, 'failed', 5, { failure: 'tool_error' });
  await run('5', b, 'failed', 8, { failure: 'timeout', model: 'm-big' }); await run('6', b, 'cancelled', 2); await run('7', a, 'running', null);
  await owner.query(`INSERT INTO run_steps(run_id, step_id, user_id, kind, state, tool_name, retries) VALUES ($1,'t1',$2,'tool','failed','docx.insert_table',2), ($1,'t2',$2,'tool','succeeded','docx.insert_table',0)`, [`rel_4_${tag}`, b]);
  await owner.query(`INSERT INTO verification_results(run_id, verifier, user_id, format, verdict, defect_count) VALUES ($1,'v',$2,'docx','pass',0), ($3,'v',$4,'xlsx','fail',3)`, [`rel_1_${tag}`, a, `rel_4_${tag}`, b]);
  const r = (await call('GET', '/admin/reliability?days=30')).body;
  assert.deepEqual([r.totals.runs, r.totals.succeeded, r.totals.failed, r.totals.cancelled, r.totals.running, r.totals.finished], [7, 3, 2, 1, 1, 5]);
  assert.equal(r.totals.success_rate, 3 / 5, 'cancelled and running are not in the rate');
  assert.equal(r.totals.p50_s, 9, 'median of 2,5,8,10,20,30'); assert.equal(r.totals.p95_s, 27.5);
  assert.deepEqual(r.failures.map((f: any) => [f.category, f.runs]).sort(), [['timeout', 1], ['tool_error', 1]]);
  assert.deepEqual(r.tools, [{ name: 'docx.insert_table', steps: 2, failed: 1, retries: 2 }]);
  assert.deepEqual(r.models.map((m: any) => [m.name, m.runs, m.failed]).sort(), [['m-big', 1, 1], ['m-small', 6, 1]]);
  assert.deepEqual(r.verification.map((v: any) => [v.format, v.verdict, v.n]), [['docx', 'pass', 1], ['xlsx', 'fail', 1]]);
  assert.deepEqual([r.coverage.users_sharing, r.coverage.users_with_runs], [2, 2], 'two share, two have runs, and c is neither');
  const an = (await call('GET', '/admin/analytics?days=30')).body;
  assert.deepEqual(an.activation, { sharing: 2, ran_a_run: 2, had_a_success: 1 });
  assert.deepEqual(an.by_mode, [{ mode: 'managed', runs: 7, users: 2 }]);
  assert.deepEqual(an.by_format.map((f: any) => [f.format, f.runs]).sort(), [['docx', 1], ['xlsx', 1]]);
  assert.equal((await call('GET', '/admin/reliability?days=0')).body.days, 1, 'the window is clamped');
  assert.ok(c);
});

test('pricing plans: draft plans exist but are off, a plan needs a price before it can be switched on, and bad prices are refused', { skip }, async () => {
  const list = (await call('GET', '/admin/plans')).body.plans as any[];
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.deepEqual([by.free.price_cents, by.free.active], [0, true]);
  for (const id of ['pro', 'max5x', 'max20x']) assert.deepEqual([by[id].active, by[id].price_cents, by[id].managed_inference, by[id].monthly_credits], [false, null, true, 0], `${id} is a draft: off, unpriced, no included credits`);
  assert.equal(by.team, undefined, 'the old placeholder plan is gone');
  assert.deepEqual(list.map((p) => p.id).filter((id) => ['free', 'pro', 'max5x', 'max20x', 'beta'].includes(id)), ['free', 'pro', 'max5x', 'max20x', 'beta'], 'the four plans in order, then the early-access plan');
  assert.equal((await call('POST', '/admin/plans/pro', { body: { active: true } })).status, 409, 'no price, no switching on');
  for (const bad of [{ price_cents: -1 }, { price_cents: 9.5 }, { price_cents: 'free' }, { currency: 'dollars' }, { billing_interval: 'week' }, { monthly_credits: -5 }, { sort_order: 5000 }, { name: ' ' }])
    assert.equal((await call('POST', '/admin/plans/pro', { body: bad })).status, 400, JSON.stringify(bad));
  const set = await call('POST', '/admin/plans/pro', { body: { price_cents: 2000, currency: 'INR', billing_interval: 'month', monthly_credits: 500000, description: 'Pro plan' } });
  assert.equal(set.status, 200);
  assert.equal((await call('POST', '/admin/plans/pro', { body: { active: true } })).status, 200, 'now it can be switched on');
  const pro = ((await call('GET', '/admin/plans')).body.plans as any[]).find((p) => p.id === 'pro');
  assert.deepEqual([pro.price_cents, pro.currency, pro.billing_interval, pro.monthly_credits, pro.active], [2000, 'inr', 'month', 500000, true]);
  assert.equal((await call('POST', '/admin/plans/pro', { body: { price_cents: null, active: true } })).status, 409, 'and the price cannot be removed while it is on');
  const made = await call('POST', '/admin/plans', { body: { id: `custom${tag}`.slice(0, 20), name: 'Custom', price_cents: 500, billing_interval: 'year', monthly_credits: 10 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await call('POST', '/admin/plans', { body: { id: `bad${tag}`.slice(0, 20), name: 'Bad', active: true } })).status, 409, 'a new plan cannot be created switched on without a price');
  await call('POST', '/admin/plans/pro', { body: { active: false } });   // leave the drafts as they were found
});

test("a person's sign-in history is listed newest first, only for that person", { skip }, async () => {
  const a = await person('hist1'), b = await person('hist2');
  await owner.query(`INSERT INTO sign_in_events(user_id, provider, client, device_name, platform, ip, created_at) VALUES ($1,'keycloak','agentic-office-desktop','Mac','darwin','203.0.113.1', now() - interval '2 hours'), ($1,'keycloak','ao-admin-console','admin console','web','203.0.113.2', now()), ($2,'keycloak','agentic-office-desktop','Other','darwin','203.0.113.3', now())`, [a, b]);
  const r = await call('GET', `/admin/users/${a}/sign-ins`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sign_ins.map((x: any) => x.client), ['ao-admin-console', 'agentic-office-desktop']);
  assert.ok(!JSON.stringify(r.body).includes('203.0.113.3'), "another person's sign-in is not here");
  assert.equal((await call('GET', '/admin/users/bad id/sign-ins')).status, 400);
});
