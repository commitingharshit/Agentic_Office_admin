// Composition check for the marketplace migrations. CREATE OR REPLACE FUNCTION replaces a whole body, so when two
// branches each extend the same trigger function the later one silently drops the earlier one's rules (this happened
// to marketplace_versions_guard: 0019 dropped 0018's risk_tier freeze). This file (1) applies every migration in order
// on a real Postgres and asserts EACH rule from EACH migration still holds at the end, and (2) fails when a function
// or trigger is defined more than once without being on the allow-list below.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const migDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const migrations = readdirSync(migDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

// Names defined by more than one migration, with the exact migrations that define them. Adding a new redefinition (or a
// new migration that redefines one of these) fails the meta-test until a human has merged the rule sets and updated
// this list AND the per-rule assertions below.
const ALLOWED_REDEFINITIONS: Record<string, string[]> = {
  // 0016 original; 0018 added the risk_tier freeze; 0019 is the UNION of all of them (see its comment block).
  // 0018's manual-review rule is a separate function and is not part of this redefinition chain.
  marketplace_versions_guard: ['0021_marketplace.sql', '0023_marketplace_advanced.sql', '0024_marketplace_hardening.sql'],
};

describe('migration redefinition meta-test', () => {
  const defs = new Map<string, string[]>();
  for (const f of migrations) {
    const sql = readFileSync(join(migDir, f), 'utf8').replace(/--.*$/gm, '');
    const seen = new Set<string>();
    for (const m of sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)\s+([a-z_][a-z0-9_]*)/gi)) seen.add(`${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
    for (const k of seen) defs.set(k, [...(defs.get(k) ?? []), f]);
  }
  test('every function/trigger defined by more than one migration is on the allow-list', () => {
    const dup = [...defs].filter(([, fs]) => fs.length > 1).map(([k, fs]) => [k.split(' ')[1], fs] as const);
    const unexpected = dup.filter(([name, fs]) => JSON.stringify(ALLOWED_REDEFINITIONS[name]) !== JSON.stringify(fs));
    assert.deepEqual(unexpected, [], 'a migration redefines a function/trigger an earlier one defined; merge the rule sets into the last definition, add a per-rule assertion below, then list it in ALLOWED_REDEFINITIONS');
    for (const name of Object.keys(ALLOWED_REDEFINITIONS)) assert.ok(dup.some(([n]) => n === name), `${name} is allow-listed but no longer redefined; remove it`);
  });
  test('the last definition of the versions guard is in the last migration that defines it', () => {
    const last = ALLOWED_REDEFINITIONS.marketplace_versions_guard.at(-1)!;
    const later = migrations.filter((f) => f > last && /marketplace_versions_guard/i.test(readFileSync(join(migDir, f), 'utf8')));
    assert.deepEqual(later, [], 'a later migration mentions marketplace_versions_guard');
  });
});

describe('every rule of every marketplace migration holds after all are applied', { skip }, () => {
  let h: MarketplacePg, o: pg.Client;
  const H = (c: string) => c.repeat(64);
  let n = 0;
  // Insert a version directly (owner bypasses RLS, triggers still fire). Types: 'template' = no manual review, 'hook' = manual review.
  const mk = async (opts: { type?: string; state?: string; verdict?: string; tier?: string | null; sha?: string } = {}) => {
    const i = ++n, type = opts.type ?? 'template', sha = opts.sha ?? H('a'), lid = `acme/l${i}`, vid = `v${i}`;
    await o.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1, 1, $2) ON CONFLICT DO NOTHING`, [sha, `k-${sha.slice(0, 4)}`]);
    await o.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ($1,$2,'acme','u1','private','T')`, [lid, type]);
    await o.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier)
      VALUES ($1,$2,'1.0.0',1,0,0,$3,'{"a":1}',$4,1,$5,$6)`, [vid, lid, opts.state ?? 'draft', sha, opts.verdict ?? 'clean', opts.tier === undefined ? 'data' : opts.tier]);
    return { vid, lid };
  };
  const upd = (vid: string, set: string) => o.query(`UPDATE marketplace_versions SET ${set} WHERE id = $1`, [vid]);

  before(async () => {
    h = await startMarketplacePg(); o = h.owner;
    await o.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test'); INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme','Acme','u1',true)`);
  });
  after(async () => { if (h) await h.stop(); });

  test('0016: published content (manifest, sha256) is immutable', async () => {
    await o.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,1,'k-other') ON CONFLICT DO NOTHING`, [H('e')]);
    const { vid } = await mk({ state: 'published' });
    await assert.rejects(() => upd(vid, `manifest = '{"a":2}'`), /immutable/);
    await assert.rejects(() => upd(vid, `sha256 = '${H('e')}'`), /immutable/);
  });
  test('0016: a published version cannot return to a pre-publication state, published_at is fixed', async () => {
    const { vid } = await mk({ state: 'published' });
    await assert.rejects(() => upd(vid, `state = 'draft'`), /immutable/);
    await assert.rejects(() => upd(vid, `published_at = now() + interval '1 day'`), /published_at/);
  });
  test('0016: approved/published need a passing scan verdict', async () => {
    const { vid } = await mk({ state: 'submitted', verdict: 'blocked' });
    await assert.rejects(() => upd(vid, `state = 'approved'`), /scan verdict/);
    await assert.rejects(() => upd(vid, `state = 'published'`), /scan verdict/);
  });
  test('0016: published_at is stamped on first publish', async () => {
    const { vid } = await mk({ state: 'approved' });
    await upd(vid, `state = 'published'`);
    assert.ok((await o.query(`SELECT published_at FROM marketplace_versions WHERE id = $1`, [vid])).rows[0].published_at);
  });
  test('0018: risk_tier is frozen once published', async () => {
    const { vid } = await mk({ state: 'published', tier: 'data' });
    await assert.rejects(() => upd(vid, `risk_tier = 'executable'`), /immutable/);
  });
  test('0018: a manual-review type needs an approval by an independent human', async () => {
    const { vid, lid } = await mk({ type: 'hook', state: 'approved', tier: 'executable' });
    await assert.rejects(() => upd(vid, `state = 'published'`), /manual review/);
    await o.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor) VALUES ($1,$2,'submitted','eng'),($1,$2,'approved','auto'),($1,$2,'approved','eng')`, [lid, vid]);
    await assert.rejects(() => upd(vid, `state = 'published'`), /manual review/);   // 'auto' and the submitter do not count
    await o.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor) VALUES ($1,$2,'approved','rev')`, [lid, vid]);
    await upd(vid, `state = 'published'`);
  });
  test('0018: a manual-review version inserted directly as published is refused', async () => {
    await assert.rejects(() => mk({ type: 'hook', state: 'published', tier: 'executable' }), /manual review/);
  });
  test('0019: revoked is terminal', async () => {
    const { vid } = await mk({ state: 'published' });
    await upd(vid, `state = 'revoked'`);
    await assert.rejects(() => upd(vid, `state = 'published'`), /terminal/);
    await assert.rejects(() => upd(vid, `state = 'quarantined'`), /terminal/);
  });
  test('0019: quarantined can only become revoked', async () => {
    const { vid } = await mk({ state: 'published' });
    await upd(vid, `state = 'quarantined'`);
    for (const s of ['published', 'deprecated', 'draft']) await assert.rejects(() => upd(vid, `state = '${s}'`), /can only be revoked/);
    await upd(vid, `state = 'revoked'`);
  });
  test('0019: no content edit in the same statement as a move into a locked state', async () => {
    const { vid } = await mk({ state: 'draft' });
    await assert.rejects(() => upd(vid, `state = 'deprecated', manifest = '{"a":9}'`), /immutable/);
    // risk_tier is assigned by validation in the same UPDATE that sets the final state (creator.ts), so that stays allowed
    await upd(vid, `state = 'published', risk_tier = 'declarative'`);
    await assert.rejects(() => upd(vid, `risk_tier = 'executable'`), /immutable/);
  });
  test('0019: an artifact row referenced by a published version is immutable', async () => {
    await mk({ state: 'published', sha: H('c') });
    await assert.rejects(() => o.query(`UPDATE marketplace_artifacts SET storage_key = 'moved' WHERE sha256 = $1`, [H('c')]), /referenced by a published version/);
    await assert.rejects(() => o.query(`UPDATE marketplace_artifacts SET size = 99 WHERE sha256 = $1`, [H('c')]), /referenced by a published version/);
  });
  // 0021 adds NEW functions only (its gate is a separate trigger), so every rule above must still hold with it enabled.
  test('0021: the verification gate composes with the 0016/0018/0019 guards (all fire; none replaced)', async () => {
    await o.query(`UPDATE marketplace_settings SET verification_required_types = '{template}'`);
    try {
      // gate: no verification -> refused; a pass for this exact sha -> allowed
      const { vid } = await mk({ state: 'submitted', sha: H('b') });
      await assert.rejects(() => upd(vid, `state = 'approved'`), /no verification/);
      await o.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
        VALUES ('cv1', $1, $2, 'p', 1, 'pass', '[]', $3, now(), now(), 'x')`, [vid, H('b'), H('1')]);
      await upd(vid, `state = 'approved'`);
      // 0016 scan rule still fires on a verified version
      const s = await mk({ state: 'submitted', verdict: 'blocked', sha: H('b') });
      await o.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
        VALUES ('cv2', $1, $2, 'p', 1, 'pass', '[]', $3, now(), now(), 'x')`, [s.vid, H('b'), H('2')]);
      await assert.rejects(() => upd(s.vid, `state = 'approved'`), /scan verdict/);
      // 0018 manual review (hook type is not in the gate list) still fires
      const hk = await mk({ type: 'hook', state: 'approved', tier: 'executable' });
      await assert.rejects(() => upd(hk.vid, `state = 'published'`), /manual review/);
      // 0019 terminal state still fires
      await o.query(`UPDATE marketplace_settings SET verification_required_types = '{}'`);
      const t = await mk({ state: 'published' });
      await upd(t.vid, `state = 'revoked'`);
      await assert.rejects(() => upd(t.vid, `state = 'published'`), /terminal/);
      // 0021 swap guard
      await assert.rejects(() => o.query(`INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, result_sha256, started_at, finished_at, run_by)
        VALUES ('cv3', $1, $2, 'p', 1, 'pass', '[]', $3, now(), now(), 'x')`, [vid, H('9'), H('3')]), /carries/);
    } finally { await o.query(`UPDATE marketplace_settings SET verification_required_types = '{}'`); }
  });
});
