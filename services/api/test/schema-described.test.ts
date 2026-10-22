// Every table must say what it is for. A migration that adds a table without COMMENT ON TABLE fails here, so the data dictionary never has a hole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const url = process.env.AO_TEST_PG;
test('every table has a description', { skip: !url }, async () => {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  const r = await c.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname <> 'schema_migrations' AND coalesce(obj_description(c.oid), '') = '' ORDER BY 1`);
  await c.end();
  assert.deepEqual(r.rows.map((x) => x.relname), [], 'add COMMENT ON TABLE in the migration that creates the table');
});
