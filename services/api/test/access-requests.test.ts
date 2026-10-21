// Asking for admin access, and deciding on a request.
// This file migrates a database of its own
// (from AO_TEST_PG's server) instead of sharing the one the other test files write to.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens } from '../src/api/admin.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const tag = Date.now().toString(36);
const DB = `ao_access_${tag}`;
const TOKEN = `access-token-${tag}-0123456789abcdef`;
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

const call = async (path: string, init: RequestInit & { acting?: string; token?: string } = {}) => {
  const { acting, token, ...rest } = init;
  const r = await fetch(base + path, { ...rest, headers: { authorization: `Bearer ${token ?? TOKEN}`, 'content-type': 'application/json', ...(acting ? { 'x-ao-acting-admin': acting } : {}) } });
  return { status: r.status, body: (await r.json()) as any };
};
const person = async (name: string, o: { role?: string; status?: string } = {}) => {
  const id = `usr_${name}${tag}`;
  await owner.query(`INSERT INTO users(id, email, role, status) VALUES ($1,$2,$3,$4)`, [id, `${id}@example.test`, o.role ?? 'user', o.status ?? 'active']);
  return id;
};
const setRole = (id: string, role: string, acting?: string) => call(`/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }), acting });
const role = async (id: string) => (await owner.query('SELECT role FROM users WHERE id=$1', [id])).rows[0].role as string;


const post = (path: string, data: unknown = {}, acting?: string) => call(path, { method: 'POST', body: JSON.stringify(data), acting });
const asRole = async (name: string, adminRole: string) => { const id = await person(name, { role: 'admin' }); await owner.query(`INSERT INTO admin_roles(user_id, role) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET role = $2`, [id, adminRole]); return id; };
const ask = (user: string, note?: string) => post('/admin/access-requests', { user_id: user, note });

test('a signed-in person can ask once; asking again shows the same request', { skip }, async () => {
  const u = await person('asker');
  const a = await ask(u, 'I run support for the beta'); assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.reused, false);
  const b = await ask(u); assert.equal(b.body.id, a.body.id); assert.equal(b.body.reused, true);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM access_requests WHERE user_id = $1`, [u])).rows[0].n, 1);
  const [both] = await Promise.all([ask(await person('twice')), ask(await person('twice2'))]);
  assert.equal(both.status, 200);
});

test('simultaneous asks from one person make one request', { skip }, async () => {
  const u = await person('burstasker');
  const rs = await Promise.all(Array.from({ length: 6 }, () => ask(u)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM access_requests WHERE user_id = $1`, [u])).rows[0].n, 1);
});

test('asking is refused for an administrator, a disabled account, an unknown person, a bad id and an oversize note', { skip }, async () => {
  assert.equal((await ask(await person('alreadyadmin', { role: 'admin' }))).status, 409);
  assert.equal((await ask(await person('offperson', { status: 'disabled' }))).status, 409);
  assert.equal((await ask('usr_nobodyhere')).status, 404);
  assert.equal((await ask('usr_x; DROP TABLE users')).status, 400);
  assert.equal((await ask(await person('wordy'), 'x'.repeat(301))).status, 400);
});

test('the request list needs a role that can read roles, and names no more than the person\'s email and note', { skip }, async () => {
  const boss = await asRole('lister', 'superadmin'), noaccess = await asRole('financeonly', 'finance');
  const u = await person('listed'); await ask(u, 'please');
  const l = await call('/admin/access-requests', { acting: boss });
  assert.equal(l.status, 200);
  const mine = l.body.requests.find((r: { user_id: string }) => r.user_id === u);
  assert.ok(mine && mine.note === 'please' && mine.status === 'pending');
  assert.deepEqual(Object.keys(mine).sort(), ['avatar_url', 'created_at', 'decided_at', 'decided_by', 'decided_role', 'decision_note', 'display_name', 'email', 'id', 'note', 'status', 'user_id', 'user_role']);
  assert.equal((await call('/admin/access-requests', { acting: noaccess })).status, 403, 'finance cannot see who is asking for admin access');
});

test('approving makes the person an administrator with the chosen role, once, and only by someone who may change roles', { skip }, async () => {
  const boss = await asRole('approver', 'superadmin'), reader = await asRole('analystonly', 'analyst');
  const u = await person('toapprove'); const rid = (await ask(u)).body.id;
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'support' }, reader)).status, 403, 'an analyst cannot approve');
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'support' })).status, 400, 'the service token alone is not a person');
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'wizard' }, boss)).status, 400);
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, {}, boss)).status, 400);
  assert.equal(await role(u), 'user', 'nothing changed by the refusals');
  const ok = await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'support', note: 'welcome' }, boss);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await role(u), 'admin');
  assert.equal((await owner.query(`SELECT role FROM admin_roles WHERE user_id = $1`, [u])).rows[0].role, 'support');
  const r = (await owner.query(`SELECT status, decided_by, decided_role, decision_note FROM access_requests WHERE id = $1`, [rid])).rows[0];
  assert.deepEqual(r, { status: 'approved', decided_by: boss, decided_role: 'support', decision_note: 'welcome' });
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'superadmin' }, boss)).status, 409, 'decided once');
  assert.equal((await owner.query(`SELECT role FROM admin_roles WHERE user_id = $1`, [u])).rows[0].role, 'support', 'a second approval did not widen the role');
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'approve_access' AND admin_user_id = $1`, [boss])).rows[0].n >= 1, true);
  const again = await ask(u); assert.equal(again.status, 409, 'now an administrator, so there is nothing to ask');
});

test('declining leaves the person as they were, and a declined person can ask again', { skip }, async () => {
  const boss = await asRole('decliner', 'superadmin');
  const u = await person('todecline'); const rid = (await ask(u)).body.id;
  assert.equal((await post(`/admin/access-requests/${rid}/decline`, { note: 'not now' }, boss)).status, 200);
  assert.equal(await role(u), 'user');
  assert.equal((await post(`/admin/access-requests/${rid}/decline`, {}, boss)).status, 409);
  assert.equal((await post(`/admin/access-requests/${rid}/approve`, { admin_role: 'support' }, boss)).status, 409, 'a declined request cannot be approved');
  const second = await ask(u); assert.equal(second.status, 200); assert.notEqual(second.body.id, rid);
});

test('two administrators approving the same request at once: one succeeds', { skip }, async () => {
  const a = await asRole('racea', 'superadmin'), b = await asRole('raceb', 'superadmin');
  const u = await person('raced'); const rid = (await ask(u)).body.id;
  const rs = await Promise.all([post(`/admin/access-requests/${rid}/approve`, { admin_role: 'engineer' }, a), post(`/admin/access-requests/${rid}/approve`, { admin_role: 'finance' }, b)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const granted = (await owner.query(`SELECT role FROM admin_roles WHERE user_id = $1`, [u])).rows[0].role;
  const decided = (await owner.query(`SELECT decided_role FROM access_requests WHERE id = $1`, [rid])).rows[0].decided_role;
  assert.equal(granted, decided, 'the role granted is the one recorded');
});

test('the notification tells people who can decide, and nobody else', { skip }, async () => {
  const boss = await asRole('noticed', 'superadmin'), analyst = await asRole('notnoticed', 'analyst');
  await ask(await person('visible'));
  const s = await call('/admin/attention', { acting: boss });
  const item = s.body.items.find((i: { id: string }) => i.id === 'access-requests');
  assert.ok(item && item.level === 'action' && item.href === '/admin/access');
  assert.equal((await call('/admin/attention', { acting: analyst })).body.items.some((i: { id: string }) => i.id === 'access-requests'), false);
});
