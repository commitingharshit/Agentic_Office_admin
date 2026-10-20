// Shared harness: a throwaway embedded Postgres with stub users/devices/admin_audit tables, migration
// 0015 applied, and the roles ao_owner / ao_app / ao_admin (ao_app and ao_admin are what RLS is judged as).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '..', '..', 'db', 'migrations', '0015_marketplace.sql'), 'utf8');

let EmbeddedPostgres: any;
export let skip: string | false = false;
try { EmbeddedPostgres = (await import('embedded-postgres')).default; } catch (e: any) { skip = `embedded-postgres unavailable: ${e.message}`; }

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); s.on('error', rej);
});

export interface MarketplacePg {
  owner: pg.Client; app: pg.Client; admin: pg.Client;
  /** Run fn in a transaction as `userId` (app.user_id set), then roll back. */
  asUser<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  /** Same, but commit (for state a later step reads back). */
  asUserCommit(userId: string, fn: () => Promise<unknown>): Promise<void>;
  stop(): Promise<void>;
}

export async function startMarketplacePg(): Promise<MarketplacePg> {
  const dir = mkdtempSync(join(tmpdir(), 'ao-mkt-pg-'));
  const port = await freePort();
  const clients: pg.Client[] = [];
  const connect = async (user: string, database = 'mkt') => {
    const c = new pg.Client({ host: '127.0.0.1', port, user, password: 'pw', database }); await c.connect(); clients.push(c); return c;
  };
  const server = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const su = await connect('postgres', 'postgres');
  await su.query(`CREATE ROLE ao_owner LOGIN PASSWORD 'pw'`);
  await su.query(`CREATE ROLE ao_app LOGIN PASSWORD 'pw'`);
  await su.query(`CREATE ROLE ao_readonly LOGIN BYPASSRLS PASSWORD 'pw'`);
  await su.query(`CREATE ROLE ao_admin LOGIN BYPASSRLS PASSWORD 'pw'`);
  await su.query(`CREATE DATABASE mkt OWNER ao_owner`);
  const owner = await connect('ao_owner');
  await owner.query(`
    CREATE TABLE users (id text PRIMARY KEY, email text);
    CREATE TABLE devices (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_rows ON devices USING (user_id = current_setting('app.user_id', true));
    GRANT SELECT ON devices TO ao_app;
    CREATE TABLE admin_audit (id bigserial PRIMARY KEY);`);
  await owner.query(migration);
  const app = await connect('ao_app'); const admin = await connect('ao_admin');
  return {
    owner, app, admin,
    async asUser(userId, fn) {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      try { return await fn(); } finally { await app.query('ROLLBACK'); }
    },
    async asUserCommit(userId, fn) {
      await app.query('BEGIN');
      try { await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]); await fn(); await app.query('COMMIT'); }
      catch (e) { await app.query('ROLLBACK'); throw e; }
    },
    async stop() {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
      await server.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
