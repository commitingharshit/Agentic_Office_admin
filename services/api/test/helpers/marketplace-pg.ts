// Shared harness: a throwaway embedded Postgres with stub users/devices/admin_audit tables, migration
// 0021 applied, and the roles ao_owner / ao_app / ao_admin (ao_app and ao_admin are what RLS is judged as).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
// every marketplace migration, in order (0021_marketplace.sql, then the later *_marketplace*.sql ones)
const migDir = join(here, '..', '..', '..', '..', 'database', 'migrations');
const migration = readdirSync(migDir).filter((f) => /^\d{4}_marketplace.*\.sql$/.test(f)).sort().map((f) => readFileSync(join(migDir, f), 'utf8')).join('\n;\n');

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
  /** A pg.Pool connecting as `user` (ao_app, ao_admin ...), ended by stop(): what the HTTP handlers need. */
  pool(user: string, max?: number, extra?: pg.PoolConfig): pg.Pool;
  stop(): Promise<void>;
}

export async function startMarketplacePg(): Promise<MarketplacePg> {
  const dir = mkdtempSync(join(tmpdir(), 'ao-mkt-pg-'));
  const port = await freePort();
  const clients: pg.Client[] = [];
  const pools: pg.Pool[] = [];
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
    CREATE TABLE users (id text PRIMARY KEY, email text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE devices (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE);
    ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_rows ON devices USING (user_id = current_setting('app.user_id', true));
    GRANT SELECT ON devices TO ao_app;
    CREATE TABLE admin_audit (
      id bigserial PRIMARY KEY, admin_user_id text NOT NULL, action text NOT NULL, target_user_id text, target_type text, target_id text,
      detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now());
    GRANT SELECT ON users, devices TO ao_admin, ao_readonly;
    GRANT SELECT, INSERT ON admin_audit TO ao_admin;
    GRANT SELECT ON admin_audit TO ao_readonly;
    GRANT USAGE ON SEQUENCE admin_audit_id_seq TO ao_admin;
    GRANT INSERT ON users TO ao_admin;`);
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
    pool(user, max = 4, extra = {}) { const p = new pg.Pool({ host: '127.0.0.1', port, user, password: 'pw', database: 'mkt', max, ...extra }); pools.push(p); return p; },
    async stop() {
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
      await server.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
