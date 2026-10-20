// Marketplace schema (migration 0013).
//  - The PGlite suite loads a minimal stub of the tables 0013 references (users, devices) and then
//    runs the real 0013 SQL. Role GRANT/POLICY statements sit in a guarded trailing section, so they
//    are no-ops there; roles and RLS are only exercised by the full-chain suite below.
//  - The full-chain suite runs the real db/migrate.ts chain and needs AO_TEST_PG (owner URL).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '..', 'db', 'migrations', '0013_marketplace.sql'), 'utf8');
const STUB = `
  CREATE TABLE users (id text PRIMARY KEY, email text);
  CREATE TABLE devices (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE);
`;
const SHA = (c: string) => c.repeat(64);

describe('marketplace schema (pglite)', () => {
  let db: PGlite;
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;

  before(async () => {
    db = new PGlite();
    await db.exec(STUB);
    await db.exec(migration);
    await db.exec(`INSERT INTO users(id) VALUES ('usr_a'),('usr_b'),('usr_c'),('usr_d');
                   INSERT INTO devices(id, user_id) VALUES ('dev_a','usr_a');
                   INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('acme','Acme','usr_a');`);
  });
  after(async () => { await db.close(); });

  async function listing(extra = ''): Promise<string> {
    const lid = `acme/thing-${++n}`;
    await db.query(
      `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary, tags)
       VALUES ($1,'skill','acme','usr_a','public','community','Title','Summary',ARRAY['x'])`, [lid]);
    void extra;
    return lid;
  }
  async function version(lid: string, v = '1.0.0', state = 'published', sha = SHA('a')): Promise<string> {
    const vid = id('ver');
    await db.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1, 10, $2) ON CONFLICT DO NOTHING`, [sha, `k/${sha}`]);
    const [major, minor, patch] = v.split('.').map(Number);
    await db.query(
      `INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, compat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{"a":1}'::jsonb,$8,10,'{}'::jsonb)`, [vid, lid, v, major, minor, patch, state, sha]);
    return vid;
  }

  test('rejects_second_review_by_same_user', async () => {
    const lid = await listing();
    await db.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, body) VALUES ($1,$2,'usr_a',5,'great')`, [id('rev'), lid]);
    await assert.rejects(db.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, body) VALUES ($1,$2,'usr_a',4,'again')`, [id('rev'), lid]), /unique|duplicate/i);
  });

  test('published_version_is_immutable', async () => {
    const lid = await listing();
    const vid = await version(lid);
    await assert.rejects(db.query(`UPDATE marketplace_versions SET manifest = '{"a":2}'::jsonb WHERE id = $1`, [vid]), /immutable/i);
    await assert.rejects(db.query(`UPDATE marketplace_versions SET sha256 = $2 WHERE id = $1`, [vid, SHA('b')]), /immutable|foreign key/i);
    await assert.rejects(db.query(`UPDATE marketplace_versions SET version = '9.9.9' WHERE id = $1`, [vid]), /immutable/i);
    await db.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [vid]);
    const r = await db.query<{ state: string }>(`SELECT state FROM marketplace_versions WHERE id = $1`, [vid]);
    assert.equal(r.rows[0].state, 'revoked');
  });

  test('draft_version_remains_editable', async () => {
    const lid = await listing();
    const vid = await version(lid, '0.1.0', 'draft');
    await db.query(`UPDATE marketplace_versions SET manifest = '{"a":3}'::jsonb WHERE id = $1`, [vid]);
  });

  test('duplicate_version_rejected', async () => {
    const lid = await listing();
    await version(lid, '1.2.3');
    await assert.rejects(version(lid, '1.2.3'), /unique|duplicate/i);
  });

  test('install_events_are_append_only', async () => {
    const eid = id('ev');
    await db.query(`INSERT INTO marketplace_install_events(id, user_id, device_id, listing_id, event) VALUES ($1,'usr_a','dev_a','acme/x','requested')`, [eid]);
    await assert.rejects(db.query(`UPDATE marketplace_install_events SET event = 'installed' WHERE id = $1`, [eid]), /append-only/i);
    await assert.rejects(db.query(`DELETE FROM marketplace_install_events WHERE id = $1`, [eid]), /append-only/i);
  });

  test('review_stars_out_of_range_rejected', async () => {
    const lid = await listing();
    for (const stars of [0, 6]) {
      await assert.rejects(db.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars) VALUES ($1,$2,'usr_b',$3)`, [id('rev'), lid, stars]), /check/i);
    }
  });

  test('bad_sha256_rejected', async () => {
    await assert.rejects(db.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('xyz', 1, 'k')`), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1, 1, 'k')`, [SHA('A')]), /check/i);   // uppercase is not canonical
    const lid = await listing();
    await db.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1, 1, 'k2') ON CONFLICT DO NOTHING`, [SHA('c')]);
    await assert.rejects(db.query(
      `INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, compat)
       VALUES ($1,$2,'1.0.0',1,0,0,'draft','{}','short',1,'{}')`, [id('ver'), lid]), /check/i);
  });

  test('state_enums_are_checked', async () => {
    const lid = await listing();
    await assert.rejects(version(lid, '3.0.0', 'bogus'), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary) VALUES ('acme/bad','nope','acme','usr_a','public','community','t','s')`), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ('i1','usr_a','dev_a',$1,'weird','user')`, [lid]), /check/i);
  });

  test('install_unique_per_user_device_listing', async () => {
    const lid = await listing();
    const ins = `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ($1,'usr_a','dev_a',$2,'installed','user')`;
    await db.query(ins, [id('inst'), lid]);
    await assert.rejects(db.query(ins, [id('inst'), lid]), /unique|duplicate/i);
  });

  test('listing_stats_view_computes_from_rows', async () => {
    const lid = await listing();
    const empty = await db.query<{ rating_count: number; rating_avg: string | null; favorite_count: number; install_count: number }>(
      `SELECT * FROM marketplace_listing_stats WHERE listing_id = $1`, [lid]);
    assert.equal(Number(empty.rows[0].rating_count), 0);
    assert.equal(empty.rows[0].rating_avg, null);
    for (const [u, s] of [['usr_a', 5], ['usr_b', 4], ['usr_c', 3]] as const) {
      await db.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars) VALUES ($1,$2,$3,$4)`, [id('rev'), lid, u, s]);
    }
    await db.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ($1,'usr_a')`, [lid]);
    await db.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ($1,'usr_a','dev_a',$2,'enabled','user')`, [id('inst'), lid]);
    const r = await db.query<{ rating_count: number; rating_avg: string; favorite_count: number; install_count: number }>(
      `SELECT * FROM marketplace_listing_stats WHERE listing_id = $1`, [lid]);
    assert.equal(Number(r.rows[0].rating_count), 3);
    assert.equal(Number(r.rows[0].rating_avg), 4);
    assert.equal(Number(r.rows[0].favorite_count), 1);
    assert.equal(Number(r.rows[0].install_count), 1);
    const cols = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'marketplace_listings'`);
    assert.ok(!cols.rows.some((c) => /rating|install_count|favorite_count/.test(c.column_name)), 'listings must not store derived counters');
  });

  test('full_text_search_covers_title_summary_tags', async () => {
    const lid = `acme/fts-${++n}`;
    await db.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary, tags)
                    VALUES ($1,'skill','acme','usr_a','public','community','Quarterly Budget','Spreadsheet helper',ARRAY['finance','excel'])`, [lid]);
    for (const q of ['budget', 'spreadsheet', 'finance']) {
      const r = await db.query(`SELECT 1 FROM marketplace_listings WHERE id = $1 AND search @@ plainto_tsquery('simple', $2)`, [lid, q]);
      assert.equal(r.rows.length, 1, q);
    }
    await db.query(`UPDATE marketplace_listings SET title = 'Payroll' WHERE id = $1`, [lid]);
    const r = await db.query(`SELECT 1 FROM marketplace_listings WHERE id = $1 AND search @@ plainto_tsquery('simple','payroll')`, [lid]);
    assert.equal(r.rows.length, 1);
  });
});

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';

describe('marketplace schema (full migration chain, real Postgres)', { skip }, () => {
  test('0013 applies on top of the whole chain and ao_app is row-scoped', async () => {
    execFileSync('node', [join(here, '..', 'db', 'migrate.ts')], { env: { ...process.env, DATABASE_URL: ownerUrl }, stdio: 'pipe' });
    const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
    const tag = Date.now().toString(36);
    const A = `usr_mkt_a_${tag}`, B = `usr_mkt_b_${tag}`;
    const owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
    const app = new pg.Client({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD) }); await app.connect();
    try {
      await owner.query(`INSERT INTO users(id) VALUES ($1),($2)`, [A, B]);
      await owner.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ($1,'T',$2)`, [`pub${tag}`, A]);
      await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary) VALUES ($1,'skill',$2,$3,'public','community','t','s')`, [`pub${tag}/x`, `pub${tag}`, A]);
      await owner.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ($1,$2),($1,$3)`, [`pub${tag}/x`, A, B]);
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.user_id', $1, true)`, [A]);
      const favs = await app.query('SELECT user_id FROM marketplace_favorites');
      assert.deepEqual(favs.rows.map((r: { user_id: string }) => r.user_id), [A]);
      await app.query('ROLLBACK');
    } finally {
      await owner.query('DELETE FROM marketplace_listings WHERE id = $1', [`pub${tag}/x`]);
      await owner.query('DELETE FROM marketplace_publishers WHERE id = $1', [`pub${tag}`]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [[A, B]]);
      await app.end(); await owner.end();
    }
  });
});
