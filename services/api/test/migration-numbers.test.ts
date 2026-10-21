// The migrator applies db/migrations by filename, once each. Two files sharing a numeric prefix applied in a
// different order on different branches before they met; this refuses a clash and a gap-free-ness regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

test('every migration is NNNN_name.sql', () => {
  for (const f of files) assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, f);
});

test('no two migrations share a numeric prefix', () => {
  const seen = new Map<string, string>();
  for (const f of files) {
    const n = f.slice(0, 4);
    assert.ok(!seen.has(n), `${f} and ${seen.get(n)} share the number ${n}: renumber the one that has not been applied anywhere`);
    seen.set(n, f);
  }
});

test('applied migrations keep their names (live databases hold them in schema_migrations)', () => {
  const fixed = ['0016_keycloak_signin.sql', '0017_pricing_and_signins.sql', '0018_plans_and_payments.sql', '0019_access_requests.sql', '0020_admin_invites.sql'];
  for (const f of fixed) assert.ok(files.includes(f), `${f} must not be renumbered or removed`);
});
