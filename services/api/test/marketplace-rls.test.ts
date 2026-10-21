// Roles, grants and row-level security of migration 0015 on a REAL Postgres (embedded-postgres, a
// throwaway cluster in its own temp dir). It bootstraps stub users/devices/admin_audit tables instead
// of the full migration chain, so pgvector is not needed. Skipped if the embedded binary is unusable.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const SHA = (c: string) => c.repeat(64);

describe('marketplace RLS and grants (real Postgres)', { skip }, () => {
  let h: MarketplacePg;
  let owner: pg.Client, app: pg.Client, admin: pg.Client;
  const asUser = <T>(u: string, fn: () => Promise<T>) => h.asUser(u, fn);
  const asUserCommit = (u: string, fn: () => Promise<unknown>) => h.asUserCommit(u, fn);

  before(async () => {
    h = await startMarketplacePg();
    ({ owner, app, admin } = h);
    await owner.query(`
      INSERT INTO users(id) VALUES ('u1'),('u2'),('u3');
      INSERT INTO devices(id, user_id) VALUES ('d2','u2'),('d3','u3');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('pa','A','u1'),('pb','B','u2');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES
        ('pa/open','skill','pa','u1','public','Open'), ('pa/secret','skill','pa','u1','private','Secret');
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('a')}',1,'k');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size) VALUES
        ('v_open','pa/open','1.0.0',1,0,0,'published','{}','${SHA('a')}',1),
        ('v_draft','pa/open','2.0.0',2,0,0,'draft','{}','${SHA('a')}',1),
        ('v_secret','pa/secret','1.0.0',1,0,0,'draft','{}','${SHA('a')}',1);
      INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ('t1','Team','u2');
      INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ('t1','u2','owner');
      INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict) VALUES ('sc1','v_secret','s','clean'),('sc2','v_open','s','clean');
      INSERT INTO marketplace_submissions(id, version_id, submitted_by) VALUES ('sub1','v_open','u1');
      INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, reason) VALUES ('rep1','pa/open','u1','other');`);
  });
  after(async () => { if (h) await h.stop(); });

  test('owner_cannot_set_trust_official', async () => {
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_listings SET trust = 'official' WHERE id = 'pa/open'`)), /permission denied/);
    await assert.rejects(asUser('u1', () => app.query(
      `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title) VALUES ('pa/new','skill','pa','u1','public','official','t')`)), /permission denied/);
    // allowed edits still work
    await asUser('u1', async () => { const r = await app.query(`UPDATE marketplace_listings SET title = 'New' WHERE id = 'pa/open'`); assert.equal(r.rowCount, 1); });
  });

  test('owner_cannot_publish_own_version_or_set_scan_verdict', async () => {
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = 'v_draft'`)), /row-level security/);
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_versions SET scan_verdict = 'clean' WHERE id = 'v_draft'`)), /permission denied/);
    await assert.rejects(asUser('u1', () => app.query(
      `INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, manifest, sha256, size, state)
       VALUES ('v_x','pa/open','3.0.0',3,0,0,'{}','${SHA('a')}',1,'published')`)), /permission denied/);
    await asUser('u1', async () => { const r = await app.query(`UPDATE marketplace_versions SET state = 'submitted' WHERE id = 'v_draft'`); assert.equal(r.rowCount, 1); });
  });

  test('cannot_create_listing_under_another_publisher', async () => {
    await assert.rejects(asUser('u1', () => app.query(
      `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pb/steal','skill','pb','u1','public','t')`)), /row-level security/);
    await assert.rejects(asUser('u1', () => app.query(
      `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pb/steal','skill','pa','u1','public','t')`)), /check/i);
    await asUser('u1', async () => { await app.query(
      `INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pa/ok','skill','pa','u1','public','t')`); });
  });

  test('submissions_and_reports_are_private', async () => {
    assert.equal((await asUser('u2', () => app.query('SELECT 1 FROM marketplace_submissions'))).rowCount, 0);
    assert.equal((await asUser('u1', () => app.query('SELECT 1 FROM marketplace_submissions'))).rowCount, 1);
    assert.equal((await asUser('u2', () => app.query('SELECT 1 FROM marketplace_reports'))).rowCount, 0);
    assert.equal((await asUser('u1', () => app.query('SELECT 1 FROM marketplace_reports'))).rowCount, 1);
    await assert.rejects(asUser('u2', () => app.query(`INSERT INTO marketplace_submissions(id, version_id, submitted_by) VALUES ('s2','v_open','u2')`)), /row-level security/);
    await assert.rejects(asUser('u2', () => app.query(`INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, reason) VALUES ('r2','pa/open','u1','broken')`)), /row-level security/);
    await asUser('u2', async () => { await app.query(`INSERT INTO marketplace_reports(id, listing_id, reporter_user_id, reason) VALUES ('r3','pa/open','u2','other')`); });
  });

  test('security_scans_follow_listing_visibility', async () => {
    const other = await asUser('u2', () => app.query('SELECT id FROM marketplace_security_scans ORDER BY id'));
    assert.deepEqual(other.rows.map((r) => r.id), ['sc2']);
    const mine = await asUser('u1', () => app.query('SELECT id FROM marketplace_security_scans ORDER BY id'));
    assert.deepEqual(mine.rows.map((r) => r.id), ['sc1', 'sc2']);
    await assert.rejects(asUser('u1', () => app.query(`INSERT INTO marketplace_security_scans(id, version_id, scanner, verdict) VALUES ('x','v_open','s','clean')`)), /permission denied/);
  });

  test('counts_are_correct_even_when_others_rows_are_invisible', async () => {
    await asUserCommit('u2', () => app.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ('pa/open','u2')`));
    await asUserCommit('u3', () => app.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ('pa/open','u3')`));
    await asUserCommit('u2', () => app.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('i2','u2','d2','pa/open','v_open','enabled','user')`));
    const r = await asUser('u1', () => app.query(`SELECT * FROM marketplace_listing_stats WHERE listing_id = 'pa/open'`));
    assert.deepEqual([Number(r.rows[0].favorite_count), Number(r.rows[0].install_count), Number(r.rows[0].rating_count), r.rows[0].rating_avg], [2, 1, 0, null]);
    // u1 cannot see the others' favorites or installs
    assert.equal((await asUser('u1', () => app.query('SELECT 1 FROM marketplace_favorites'))).rowCount, 0);
    assert.equal((await asUser('u1', () => app.query('SELECT 1 FROM marketplace_installs'))).rowCount, 0);
    // a private listing does not appear in the stats of another user
    assert.equal((await asUser('u2', () => app.query(`SELECT 1 FROM marketplace_listing_stats WHERE listing_id = 'pa/secret'`))).rowCount, 0);
  });

  test('revoked_installed_version_is_visible_through_installed_status', async () => {
    await admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'v_open'`);
    await admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ('pa/open','v_open','revoked','admin','{"reason":"malware"}')`);
    const direct = await asUser('u2', () => app.query(`SELECT 1 FROM marketplace_versions WHERE id = 'v_open'`));
    assert.equal(direct.rowCount, 0, 'catalog policy hides revoked versions');
    const st = await asUser('u2', () => app.query('SELECT * FROM marketplace_installed_status()'));
    assert.equal(st.rowCount, 1);
    assert.deepEqual([st.rows[0].listing_id, st.rows[0].state, st.rows[0].reason], ['pa/open', 'revoked', 'malware']);
    assert.equal((await asUser('u3', () => app.query('SELECT * FROM marketplace_installed_status()'))).rowCount, 0);
  });

  test('an_owner_can_insert_a_fork_with_its_upstream_columns_but_not_move_them_afterwards', async () => {
    await asUser('u1', async () => {
      await app.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title, forked_from, forked_from_version, forked_base_sha256)
                       VALUES ('pa/fork','skill','pa','u1','private','F','pa/open','v_open','${SHA('a')}')`);
      const r = await app.query(`SELECT forked_from, forked_from_version FROM marketplace_listings WHERE id = 'pa/fork'`);
      assert.deepEqual(r.rows[0], { forked_from: 'pa/open', forked_from_version: 'v_open' });
    });
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_listings SET forked_from_version = NULL WHERE id = 'pa/open'`)), /permission denied/);
  });

  test('ao_admin_can_publish', async () => {
    await admin.query(`UPDATE marketplace_versions SET state = 'published', scan_verdict = 'clean' WHERE id = 'v_secret'`);
    const r = await admin.query(`SELECT state, scan_verdict, published_at FROM marketplace_versions WHERE id = 'v_secret'`);
    assert.equal(r.rows[0].state, 'published'); assert.equal(r.rows[0].scan_verdict, 'clean'); assert.ok(r.rows[0].published_at);
    await admin.query(`UPDATE marketplace_listings SET trust = 'official' WHERE id = 'pa/secret'`);
  });

  test('install_events_are_private_and_append_only_for_the_app', async () => {
    await asUser('u2', async () => { await app.query(`INSERT INTO marketplace_install_events(id, user_id, listing_id, event) VALUES ('e1','u2','pa/open','installed')`); });
    await assert.rejects(asUser('u2', () => app.query(`INSERT INTO marketplace_install_events(id, user_id, listing_id, event) VALUES ('e2','u3','pa/open','installed')`)), /row-level security/);
    await assert.rejects(asUser('u2', () => app.query(`UPDATE marketplace_install_events SET event = 'x'`)), /permission denied/);
  });

  test('counter_functions_are_not_callable_by_the_app', async () => {
    await assert.rejects(asUser('u3', () => app.query(`SELECT marketplace_bump('pa/open', 100, 100)`)), /permission denied/);
    const r = await asUser('u3', () => app.query(`SELECT favorite_count, install_count FROM marketplace_listing_stats WHERE listing_id = 'pa/open'`));
    assert.ok(Number(r.rows[0].favorite_count) < 50 && Number(r.rows[0].install_count) < 50, 'counters unchanged by the forged call');
    await assert.rejects(asUser('u3', () => app.query(`SELECT marketplace_count_favorites()`)), /permission denied|trigger/);
  });

  test('installs_and_favorites_need_own_device_and_visible_listing', async () => {
    await assert.rejects(asUser('u3', () => app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ('ix1','u3','d2','pa/open','installed','user')`)), /row-level security/);   // u2's device
    await assert.rejects(asUser('u3', () => app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ('ix2','u3','d3','pa/secret','installed','user')`)), /row-level security/);   // private listing of u1
    await assert.rejects(asUser('u3', () => app.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ('pa/secret','u3')`)), /row-level security/);
    await assert.rejects(asUser('u3', () => app.query(`UPDATE marketplace_installs SET listing_id = 'pa/secret'`)), /permission denied/);
    await asUser('u3', async () => { await app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, state, scope) VALUES ('ix3','u3','d3','pa/open','installed','user')`); });
  });

  test('artifacts_are_not_writable_by_the_app', async () => {
    await assert.rejects(asUser('u1', () => app.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('9')}',1,'k')`)), /permission denied/);
    await admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('9')}',1,'k9') ON CONFLICT DO NOTHING`);
    assert.equal((await asUser('u2', () => app.query(`SELECT 1 FROM marketplace_artifacts WHERE sha256 = '${SHA('9')}'`))).rowCount, 0);   // unreferenced: hidden
  });

  test('version_lifecycle_for_the_owner_stops_at_submitted', async () => {
    await owner.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size)
                       VALUES ('v_life','pa/secret','9.0.0',9,0,0,'draft','{}','${SHA('a')}',1)`);
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = 'v_life'`)), /row-level security/);
    await asUser('u1', async () => { const r = await app.query(`UPDATE marketplace_versions SET state = 'submitted' WHERE id = 'v_life'`); assert.equal(r.rowCount, 1); });
  });

  test('dependency_policies', async () => {
    await owner.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size)
                       VALUES ('v_dep','pa/open','8.0.0',8,0,0,'draft','{}','${SHA('a')}',1) ON CONFLICT DO NOTHING`);
    await assert.rejects(asUser('u2', () => app.query(`INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) VALUES ('v_dep','pb/x','^1')`)), /row-level security/);
    await asUserCommit('u1', () => app.query(`INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) VALUES ('v_dep','pb/x','^1')`));
    assert.equal((await asUser('u2', () => app.query(`SELECT 1 FROM marketplace_dependencies WHERE version_id = 'v_dep'`))).rowCount, 0);   // draft not visible to others
    assert.equal((await asUser('u1', () => app.query(`SELECT 1 FROM marketplace_dependencies WHERE version_id = 'v_dep'`))).rowCount, 1);
    assert.equal((await asUser('u2', () => app.query(`DELETE FROM marketplace_dependencies WHERE version_id = 'v_dep'`))).rowCount, 0);
    assert.equal((await asUser('u1', () => app.query(`DELETE FROM marketplace_dependencies WHERE version_id = 'v_dep'`))).rowCount, 1);
  });

  test('team_policies', async () => {
    assert.equal((await asUser('u2', () => app.query('SELECT 1 FROM marketplace_teams'))).rowCount, 1);
    assert.equal((await asUser('u3', () => app.query('SELECT 1 FROM marketplace_teams'))).rowCount, 0);
    assert.equal((await asUser('u3', () => app.query('SELECT 1 FROM marketplace_team_members'))).rowCount, 0);
    await assert.rejects(asUser('u2', () => app.query(`INSERT INTO marketplace_team_members(team_id, user_id) VALUES ('t1','u3')`)), /permission denied/);
    // u2 owns publisher pb; a team listing is visible to the member only
    await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, title) VALUES ('pb/teamed','skill','pb','u1','team','t1','t')`);
    assert.equal((await asUser('u2', () => app.query(`SELECT 1 FROM marketplace_listings WHERE id = 'pb/teamed'`))).rowCount, 1);
    assert.equal((await asUser('u3', () => app.query(`SELECT 1 FROM marketplace_listings WHERE id = 'pb/teamed'`))).rowCount, 0);
    // an owner may attach a listing only to a team they belong to
    await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pb/mine','skill','pb','u2','private','t'),('pa/mine3','skill','pa','u3','private','t')`).catch(() => {});
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_listings SET visibility = 'team', team_id = 't1' WHERE id = 'pa/open'`)), /row-level security/);
    await asUser('u2', async () => { const r = await app.query(`UPDATE marketplace_listings SET visibility = 'team', team_id = 't1' WHERE id = 'pb/mine'`); assert.equal(r.rowCount, 1); });
  });

  test('reviews_cannot_be_moved_to_another_listing', async () => {
    await asUserCommit('u3', () => app.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars) VALUES ('rv1','pa/open','u3',4)`));
    await assert.rejects(asUser('u3', () => app.query(`UPDATE marketplace_reviews SET listing_id = 'pa/secret' WHERE id = 'rv1'`)), /permission denied/);
    await asUser('u3', async () => { const r = await app.query(`UPDATE marketplace_reviews SET stars = 5 WHERE id = 'rv1'`); assert.equal(r.rowCount, 1); });
  });

  test('install_version_must_belong_to_the_install_listing_and_be_visible', async () => {
    // v_secret (draft, private listing of u1) and a version of a different public listing
    await assert.rejects(asUser('u3', () => app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('iv1','u3','d3','pa/open','v_secret','installed','user')`)), /row-level security/);
    await owner.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, title) VALUES ('pa/other','skill','pa','u1','public','o') ON CONFLICT DO NOTHING`);
    await owner.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size)
                       VALUES ('v_other','pa/other','1.0.0',1,0,0,'published','{}','${SHA('a')}',1) ON CONFLICT DO NOTHING`);
    await assert.rejects(asUser('u3', () => app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('iv2','u3','d3','pa/open','v_other','installed','user')`)), /row-level security/);
    // legit insert (version of the same listing, visible) and update still work; so does a NULL version
    await asUserCommit('u3', () => app.query(
      `INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('iv3','u3','d3','pa/other','v_other','installed','user')`));
    await asUser('u3', async () => { const r = await app.query(`UPDATE marketplace_installs SET state = 'enabled', enabled = true WHERE id = 'iv3'`); assert.equal(r.rowCount, 1); });
    await assert.rejects(asUser('u3', () => app.query(`UPDATE marketplace_installs SET version_id = 'v_secret' WHERE id = 'iv3'`)), /not an available version/);
    await assert.rejects(asUser('u3', () => app.query(`UPDATE marketplace_installs SET version_id = 'v_open' WHERE id = 'iv3'`)), /not an available version/);   // other listing's version
    // an already-installed row whose version is later revoked can still be updated (state moves)
    await admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'v_other'`);
    await asUser('u3', async () => { const r = await app.query(`UPDATE marketplace_installs SET state = 'disabled' WHERE id = 'iv3'`); assert.equal(r.rowCount, 1); });
  });

  test('installed_status_never_returns_a_version_of_another_listing', async () => {
    // a poisoned row (written by the owner role, bypassing RLS) must not leak v_secret through the definer function
    await owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('ipoison','u3','d3','pa/open','v_secret','installed','device') ON CONFLICT DO NOTHING`).catch(() => {});
    await owner.query(`DELETE FROM marketplace_installs WHERE id = 'ipoison'`).catch(() => {});
    await owner.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, scope) VALUES ('ipoison2','u3','d3','pa/secret','v_other','installed','team')`).catch(() => {});
    const st = await asUser('u3', () => app.query('SELECT * FROM marketplace_installed_status()'));
    assert.ok(st.rows.every((r) => r.version_id !== 'v_secret'));
    assert.ok(!st.rows.some((r) => r.listing_id === 'pa/secret'), 'mismatched listing/version row is not returned');
    assert.ok(st.rows.some((r) => r.version_id === 'v_other' && r.state === 'revoked'), 'legit revoked install still reported');
  });
});
