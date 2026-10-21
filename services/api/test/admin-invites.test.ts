// Adding an administrator by email: now if the person exists, as an invite otherwise.
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
const DB = `ao_invites_${tag}`;
const TOKEN = `invite-token-${tag}-0123456789abcdef`;
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

const verifiedPerson = async (name: string, email: string, verified = true) => {
  const id = `usr_${name}${tag}`;
  await owner.query(`INSERT INTO users(id, email, role, status, email_verified) VALUES ($1,$2,'user','active',$3)`, [id, email, verified]);
  return id;
};
const addAdmin = (email: string, adminRole: string, acting?: string) => post('/admin/admin-invites', { email, admin_role: adminRole }, acting);

test('adding someone who already has an account makes them an administrator at once', { skip }, async () => {
  const boss = await asRole('inviter1', 'superadmin');
  const u = await person('existing');
  const r = await addAdmin(`${u}@example.test`.toUpperCase(), 'support', boss); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'granted'); assert.equal(await role(u), 'admin');
  assert.equal((await owner.query('SELECT role FROM admin_roles WHERE user_id=$1', [u])).rows[0].role, 'support');
  assert.equal((await addAdmin(`${u}@example.test`, 'support', boss)).status, 409, 'already an administrator');
});

test('adding someone new waits as an invite, and is claimed once at their first verified sign-in', { skip }, async () => {
  const boss = await asRole('inviter2', 'superadmin');
  const email = `newbie${tag}@example.test`;
  const r = await addAdmin(email, 'finance', boss); assert.equal(r.body.status, 'invited');
  assert.equal((await call('/admin/admin-invites', { acting: boss })).body.invites.some((i: { email: string }) => i.email === email), true);
  const u = await verifiedPerson('newbie', email);
  const c = await post('/admin/admin-invites/claim', { user_id: u }); assert.equal(c.body.claimed, true, JSON.stringify(c.body));
  assert.equal(await role(u), 'admin');
  assert.equal((await owner.query('SELECT role FROM admin_roles WHERE user_id=$1', [u])).rows[0].role, 'finance');
  assert.equal((await call('/admin/admin-invites', { acting: boss })).body.invites.some((i: { email: string }) => i.email === email), false, 'used invites leave the list');
  assert.equal((await post('/admin/admin-invites/claim', { user_id: u })).body.claimed, false, 'used once');
});

test('an unverified email never claims an invite', { skip }, async () => {
  const boss = await asRole('inviter3', 'superadmin'); const email = `liar${tag}@example.test`;
  await addAdmin(email, 'superadmin', boss);
  const u = await verifiedPerson('liar', email, false);
  assert.equal((await post('/admin/admin-invites/claim', { user_id: u })).body.claimed, false);
  assert.equal(await role(u), 'user');
});

test('two windows signing in at once use an invite once', { skip }, async () => {
  const boss = await asRole('inviter4', 'superadmin'); const email = `race${tag}@example.test`;
  await addAdmin(email, 'analyst', boss);
  const u = await verifiedPerson('race', email);
  const rs = await Promise.all(Array.from({ length: 5 }, () => post('/admin/admin-invites/claim', { user_id: u })));
  assert.equal(rs.filter((r) => r.body.claimed).length, 1);
  assert.equal(await role(u), 'admin');
});

test('a revoked invite cannot be claimed; a person without roles.write cannot add or revoke', { skip }, async () => {
  const boss = await asRole('inviter5', 'superadmin'), fin = await asRole('finance5', 'finance'); const email = `gone${tag}@example.test`;
  assert.equal((await addAdmin(email, 'support', fin)).status, 403);
  await addAdmin(email, 'support', boss);
  assert.equal((await post('/admin/admin-invites/revoke', { email }, fin)).status, 403);
  assert.equal((await post('/admin/admin-invites/revoke', { email }, boss)).status, 200);
  const u = await verifiedPerson('gone', email);
  assert.equal((await post('/admin/admin-invites/claim', { user_id: u })).body.claimed, false);
  assert.equal((await post('/admin/admin-invites/revoke', { email }, boss)).status, 404);
});

test('bad input is refused', { skip }, async () => {
  const boss = await asRole('inviter6', 'superadmin');
  assert.equal((await addAdmin('not an email', 'support', boss)).status, 400);
  assert.equal((await addAdmin(`ok${tag}@example.test`, 'wizard', boss)).status, 400);
  assert.equal((await post('/admin/admin-invites/claim', { user_id: 'x; drop' })).status, 400);
  const off = await person('offacct'); await owner.query(`UPDATE users SET status='disabled' WHERE id=$1`, [off]);
  assert.equal((await addAdmin(`${off}@example.test`, 'support', boss)).status, 409, 'a disabled account cannot be made an administrator');
});
