#!/usr/bin/env node
// Applies services/accounts-sync/db/migrations/*.sql in order, once each, in a transaction per
// file, and sets the role passwords from the environment.
//   DATABASE_URL=postgres://ao_owner:…@host:5432/agentic_office \
//   AO_APP_PASSWORD=… AO_READONLY_PASSWORD=… AO_ADMIN_PASSWORD=… AO_AUTH_PASSWORD=… AO_BILLING_PASSWORD=… node services/accounts-sync/db/migrate.ts [--status]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(2); }
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r: { name: string }) => r.name));
const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

if (process.argv.includes('--status')) {
  for (const f of files) console.log(`${done.has(f) ? 'applied' : 'pending'}  ${f}`);
  await client.end();
  process.exit(0);
}

// Files renumbered after some database had already applied them under the old name (same SQL, new prefix): record the new name instead of running them twice.
const RENAMED: Record<string, string> = { '0029_growth.sql': '0021_growth.sql', '0030_releases_email.sql': '0022_releases_email.sql', '0035_laya_shadow.sql': '0034_laya_shadow.sql', '0036_laya_shadow_app.sql': '0035_laya_shadow_app.sql' };

for (const f of files) {
  if (done.has(f)) continue;
  if (RENAMED[f] && done.has(RENAMED[f])) {
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    console.log(`already applied as ${RENAMED[f]}  ${f}`);
    continue;
  }
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(join(dir, f), 'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`applied  ${f}`);
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error(`FAILED   ${f}: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}
const ROLES: Array<[string, string]> = [['ao_app', 'AO_APP_PASSWORD'], ['ao_readonly', 'AO_READONLY_PASSWORD'], ['ao_admin', 'AO_ADMIN_PASSWORD'], ['ao_auth', 'AO_AUTH_PASSWORD'], ['ao_billing', 'AO_BILLING_PASSWORD']];
for (const [role, env] of ROLES) {
  const pw = process.env[env];
  if (pw) await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(pw)}`);
  else console.warn(`${env} not set — ${role} cannot log in yet`);
}
await client.end();
