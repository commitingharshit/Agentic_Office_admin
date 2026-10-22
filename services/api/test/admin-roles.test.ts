// Who may administer, and who is named in the audit log when the web console acts for them.
// "The last admin" depends on every admin in the database, so this file migrates a database of its own
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
const DB = `ao_roles_${tag}`;
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
    const m = spawnSync(process.execPath, ['../../database/migrate.ts'], { env: { ...process.env, DATABASE_URL: urlFor(DB) }, encoding: 'utf8' });
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

test('the service token can make the first admin, and the change is audited', { skip }, async () => {
  const a = await person('first');
  const r = await setRole(a, 'admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await role(a), 'admin');
  const row = (await owner.query(`SELECT admin_user_id, detail FROM admin_audit WHERE action='set_role' AND target_user_id=$1`, [a])).rows[0];
  assert.equal(row.admin_user_id, 'console');
  assert.equal(row.detail.role, 'admin');
});

test('invalid roles, unknown people and inactive accounts are refused', { skip }, async () => {
  const u = await person('plain'), off = await person('disabledone', { status: 'disabled' });
  assert.equal((await setRole(u, 'superuser')).status, 400);
  assert.equal((await setRole(u, '')).status, 400);
  assert.equal((await setRole('usr_nobody', 'admin')).status, 404);
  assert.equal((await setRole(off, 'admin')).status, 409, 'a disabled account cannot be made an admin');
  assert.equal(await role(u), 'user');
});

test('the audit log names the person the web console acts for, and says it was the console', { skip }, async () => {
  const boss = await person('boss', { role: 'admin' }), u = await person('target');
  const r = await setRole(u, 'admin', boss);
  assert.equal(r.status, 200);
  const row = (await owner.query(`SELECT admin_user_id, detail FROM admin_audit WHERE action='set_role' AND target_user_id=$1`, [u])).rows[0];
  assert.equal(row.admin_user_id, boss, 'a person, not a shared token name');
  assert.equal(row.detail.via, 'console');
  const view = await call(`/admin/users/${u}`, { acting: boss });
  assert.equal(view.status, 200);
  assert.equal((await owner.query(`SELECT admin_user_id FROM admin_audit WHERE action='view_user' AND target_user_id=$1`, [u])).rows[0].admin_user_id, boss);
});

test('the acting-admin header must be a user id; anything else is refused before it acts', { skip }, async () => {
  const u = await person('victim');
  for (const acting of ['admin', 'usr_', 'usr_ABC', 'usr_x; DROP TABLE users', "usr_a'b", 'x'.repeat(100), 'console']) {
    const r = await call(`/admin/users/${u}/disable`, { method: 'POST', acting });
    assert.equal(r.status, 400, acting);
  }
  assert.equal((await owner.query('SELECT status FROM users WHERE id=$1', [u])).rows[0].status, 'active', 'nothing happened');
});

test('nobody changes their own role', { skip }, async () => {
  const a = await person('selfish', { role: 'admin' });
  const r = await setRole(a, 'user', a);
  assert.equal(r.status, 409);
  assert.equal(await role(a), 'admin');
});

test('the last admin cannot be demoted, but one of two can', { skip }, async () => {
  // This database is ours: make every existing admin go away except the two we create here.
  await owner.query(`UPDATE users SET role = 'user' WHERE role = 'admin'`);
  const a = await person('one', { role: 'admin' }), b = await person('two', { role: 'admin' });
  assert.equal((await setRole(a, 'user', b)).status, 200);
  assert.equal(await role(a), 'user');
  // `a` was just demoted, so it can no longer act at all; the guard is checked with the service token.
  assert.equal((await setRole(b, 'user', a)).status, 403, 'a demoted person cannot act');
  const last = await setRole(b, 'user');
  assert.equal(last.status, 409);
  assert.match(last.body.error, /last admin/);
  assert.equal(await role(b), 'admin');
  assert.equal((await setRole(b, 'user')).status, 409, 'the service token cannot remove the last admin either');
});

test('two admins demoted at the same moment: one succeeds, one admin always remains', { skip }, async () => {
  await owner.query(`UPDATE users SET role = 'user' WHERE role = 'admin'`);
  const a = await person('race1', { role: 'admin' }), b = await person('race2', { role: 'admin' });
  const [ra, rb] = await Promise.all([setRole(a, 'user'), setRole(b, 'user')]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  assert.equal((await owner.query(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND status='active'`)).rows[0].n, 1);
});

test('admin-only: a request with no token or a wrong one cannot change roles', { skip }, async () => {
  const u = await person('guarded');
  const none = await fetch(`${base}/admin/users/${u}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }) });
  assert.equal(none.status, 401);
  assert.equal((await call(`/admin/users/${u}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin' }), token: 'wrong-token-wrong-token-wrong-token' })).status, 403);
  assert.equal(await role(u), 'user');
});
