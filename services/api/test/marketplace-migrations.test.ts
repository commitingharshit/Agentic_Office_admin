// Plan 4 Task 19: release-readiness checks for the marketplace migrations.
//  1. numbering: unique and strictly increasing (gaps are allowed: other branches reserve ranges), and every marketplace migration
//     has a rollback script under db/rollback/ named after it;
//  2. the whole marketplace chain applies in order on an empty embedded Postgres, rolls back in reverse order leaving no marketplace_*
//     table, function or view behind, and applies again (so a rollback is a real way back, not a comment).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const db = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'database');
const files = readdirSync(join(db, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const mkt = files.filter((f) => /^\d{4}_marketplace/.test(f));

describe('marketplace migration numbering and rollback scripts', () => {
  test('numbers are unique and strictly increasing', () => {
    const nums = files.map((f) => Number(f.slice(0, 4)));
    for (let i = 1; i < nums.length; i++) assert.ok(nums[i] > nums[i - 1], `${files[i]} does not follow ${files[i - 1]}`);
  });
  test('the marketplace migrations are 0021 to 0028 in order (a renumber at merge must update the rollback names too)', () => {
    assert.deepEqual(mkt.map((f) => f.slice(0, 4)), ['0021', '0022', '0023', '0024', '0025', '0026', '0027', '0028']);
  });
  test('every marketplace migration has exactly one rollback script, in a transaction, and no orphan rollback exists', () => {
    const down = readdirSync(join(db, 'rollback')).filter((f) => f.endsWith('.down.sql')).sort();
    assert.deepEqual(down, mkt.map((f) => f.replace(/\.sql$/, '.down.sql')));
    for (const f of down) {
      const sql = readFileSync(join(db, 'rollback', f), 'utf8');
      assert.match(sql, /^BEGIN;$/m, f); assert.match(sql, /^COMMIT;$/m, f);
      assert.ok(!/\bDROP\s+(TABLE|SCHEMA|DATABASE)\s+(?!IF EXISTS)/i.test(sql), `${f}: every DROP must be IF EXISTS`);
      assert.ok(!/\b(users|devices|admin_audit)\b[^;]*CASCADE/i.test(sql.replace(/--.*$/gm, '')), `${f} must not touch non-marketplace tables`);
    }
  });
});

describe('the marketplace chain rolls back and applies again on a real Postgres', { skip }, () => {
  let h: MarketplacePg;
  before(async () => { h = await startMarketplacePg(); });
  after(async () => { await h?.stop(); });
  const leftovers = async () => (await h.owner.query(`
    SELECT 'table' k, c.relname n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relname LIKE 'marketplace\\_%' AND c.relkind IN ('r','v','S')
    UNION ALL SELECT 'function', p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname LIKE 'marketplace\\_%'`)).rows.map((r) => `${r.k} ${r.n}`);

  test('applied: the chain created objects; rolled back in reverse: none are left', async () => {
    assert.ok((await leftovers()).length > 30, 'the chain should have created many marketplace objects');
    for (const f of [...mkt].reverse()) await h.owner.query(readFileSync(join(db, 'rollback', f.replace(/\.sql$/, '.down.sql')), 'utf8'));
    assert.deepEqual(await leftovers(), []);
  });
  test('and it applies again on the rolled-back database', async () => {
    for (const f of mkt) await h.owner.query(readFileSync(join(db, 'migrations', f), 'utf8'));
    assert.ok((await leftovers()).length > 30);
  });
});
