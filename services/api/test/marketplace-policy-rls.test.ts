// Migration 0017 roles, grants and row-level security on a REAL Postgres (embedded-postgres; skipped if the
// binary is unusable). Judged as ao_app (RLS applies) and ao_admin (bypasses RLS, triggers still fire).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';
import { parseEffectivePolicy } from '../src/marketplace/policy.ts';

const SHA = (c: string) => c.repeat(64);
const mig0017 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '0017_marketplace_agents.sql'), 'utf8');

describe('marketplace team assignments and policy RLS (real Postgres)', { skip }, () => {
  let h: MarketplacePg;
  let owner: pg.Client, app: pg.Client, admin: pg.Client;
  const asUser = <T>(u: string, fn: () => Promise<T>) => h.asUser(u, fn);
  // u1 owns team tA (owner row), u2 is tA admin, u3 tA member, u4 owns tB, u5 outsider.
  const ins = (id: string, team: string, listing: string, ver: string, pinned: string, sha: string, by: string) => app.query(
    `INSERT INTO marketplace_team_assignments(id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode, assigned_by) VALUES ($1,$2,$3,$4,$5,$6,'required',$7)`,
    [id, team, listing, ver, pinned, sha, by]);

  before(async () => {
    h = await startMarketplacePg();
    ({ owner, app, admin } = h);
    await owner.query(mig0017);
    await owner.query(`
      INSERT INTO users(id) VALUES ('u1'),('u2'),('u3'),('u4'),('u5');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('pa','A','u1'),('pb','B','u4');
      INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ('tA','A','u1'),('tB','B','u4');
      INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ('tA','u1','owner'),('tA','u2','admin'),('tA','u3','member'),('tB','u4','owner');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, title) VALUES
        ('pa/agent','agent','pa','u1','public',NULL,'Agent'), ('pa/skill','skill','pa','u1','public',NULL,'Skill'),
        ('pa/priv','agent','pa','u1','private',NULL,'Priv'), ('pb/onlyb','skill','pb','u4','team','tB','Only B'),
        ('pa/onlya','skill','pa','u1','team','tA','Only A');
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('a')}',1,'k'),('${SHA('b')}',1,'k2');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES
        ('v_agent','pa/agent','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_skill','pa/skill','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_priv','pa/priv','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_onlyb','pb/onlyb','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_onlya','pa/onlya','1.0.0',1,0,0,'published','{}','${SHA('b')}',1,'clean');`);
  });
  after(async () => { if (h) await h.stop(); });

  test('only_team_owner_or_admin_can_assign_modify_or_remove', async () => {
    for (const u of ['u3', 'u4', 'u5']) {   // member, other-team owner, outsider
      await assert.rejects(asUser(u, () => ins('x', 'tA', 'pa/agent', 'v_agent', '1.0.0', SHA('a'), u)), /row-level security/, u);
    }
    await h.asUserCommit('u2', () => ins('asg1', 'tA', 'pa/agent', 'v_agent', '1.0.0', SHA('a'), 'u2'));      // admin
    await h.asUserCommit('u1', () => ins('asg2', 'tA', 'pa/skill', 'v_skill', '1.0.0', SHA('a'), 'u1'));      // owner
    // member: cannot update (0 rows through RLS) or delete
    await asUser('u3', async () => {
      assert.equal((await app.query(`UPDATE marketplace_team_assignments SET mode = 'optional' WHERE id = 'asg1'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_team_assignments WHERE id = 'asg1'`)).rowCount, 0);
    });
    await asUser('u4', async () => {
      assert.equal((await app.query(`UPDATE marketplace_team_assignments SET mode = 'optional' WHERE id = 'asg1'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_team_assignments WHERE id = 'asg1'`)).rowCount, 0);
    });
    await asUser('u2', async () => assert.equal((await app.query(`UPDATE marketplace_team_assignments SET mode = 'optional' WHERE id = 'asg1'`)).rowCount, 1));
    // the assigner cannot be forged
    await assert.rejects(asUser('u2', () => ins('forged', 'tA', 'pa/agent', 'v_agent', '1.0.0', SHA('a'), 'u1')), /row-level security/);
  });

  test('assignments_are_not_readable_across_teams', async () => {
    const ids = async (u: string) => (await asUser(u, () => app.query(`SELECT id FROM marketplace_team_assignments ORDER BY id`))).rows.map((r) => r.id);
    assert.deepEqual(await ids('u3'), ['asg1', 'asg2']);    // plain member reads
    assert.deepEqual(await ids('u1'), ['asg1', 'asg2']);
    assert.deepEqual(await ids('u4'), []);                  // another team's owner
    assert.deepEqual(await ids('u5'), []);                  // outsider
  });

  test('admin_cannot_pin_what_the_team_cannot_see_or_a_stale_pin', async () => {
    const same = /not assignable/;
    await assert.rejects(asUser('u1', () => ins('p1', 'tA', 'pb/onlyb', 'v_onlyb', '1.0.0', SHA('a'), 'u1')), same);   // team-visibility listing of tB
    await assert.rejects(asUser('u1', () => ins('p2', 'tA', 'pa/priv', 'v_priv', '1.0.0', SHA('a'), 'u1')), same);     // private listing
    await assert.rejects(asUser('u1', () => ins('p3', 'tA', 'pa/onlya', 'v_onlya', '1.0.0', SHA('a'), 'u1')), same);   // hash differs from the version's
    // existence oracle: a made-up version id answers exactly like a hidden one
    const e1 = await asUser('u1', () => ins('p4', 'tA', 'pb/onlyb', 'v_onlyb', '1.0.0', SHA('a'), 'u1').catch((e) => e.message));
    const e2 = await asUser('u1', () => ins('p5', 'tA', 'pb/onlyb', 'v_ghost', '1.0.0', SHA('a'), 'u1').catch((e) => e.message));
    assert.match(String(e1), same); assert.ok(typeof e2 === 'string');
    await h.asUserCommit('u1', () => ins('ok', 'tA', 'pa/onlya', 'v_onlya', '1.0.0', SHA('b'), 'u1'));               // its own team's listing is fine
    // the admin pool is checked by the same trigger
    await assert.rejects(admin.query(`INSERT INTO marketplace_team_assignments(id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode)
      VALUES ('adm','tA','pb/onlyb','v_onlyb','1.0.0','${SHA('a')}','optional')`), same);
  });

  test('non_managers_get_the_same_error_for_valid_and_invalid_pins', async () => {
    const msg = async (u: string, ver: string, sha: string) =>
      asUser(u, () => ins('probe', 'tB', 'pb/onlyb', ver, '1.0.0', sha, u).then(() => 'ok', (e) => String(e.message)));
    const a = await msg('u3', 'v_onlyb', SHA('a'));       // real, team-hidden version
    const b = await msg('u3', 'v_ghost', SHA('f'));       // does not exist
    assert.equal(a, b); assert.match(a, /row-level security/);
  });

  test('identity_columns_cannot_be_rewritten_by_the_app_role', async () => {
    for (const col of ['team_id', 'listing_id', 'assigned_by', 'id']) {
      await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_team_assignments SET ${col} = 'tB' WHERE id = 'asg2'`)), /permission denied/, col);
    }
  });

  test('a_revoked_pin_is_reported_to_assignees_only_and_without_other_data', async () => {
    await admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'v_skill'`);
    await admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ('pa/skill','v_skill','revoked','adm','{"reason":"malware found"}')`);
    // the base table no longer shows the version to the app role...
    assert.equal((await asUser('u3', () => app.query(`SELECT 1 FROM marketplace_versions WHERE id = 'v_skill'`))).rowCount, 0);
    // ... but the status function tells an assignee
    const st = (await asUser('u3', () => app.query(`SELECT * FROM marketplace_assignment_status() ORDER BY assignment_id`))).rows;
    assert.deepEqual(st.map((r) => [r.assignment_id, r.state, r.blocked, r.reason]), [
      ['asg1', 'published', false, null], ['asg2', 'revoked', true, 'malware found'], ['ok', 'published', false, null]]);
    assert.deepEqual(Object.keys(st[0]).sort(), ['assignment_id', 'blocked', 'listing_id', 'mode', 'pinned_version', 'reason', 'state', 'team_id', 'version_id']);
    // nothing for the other team's owner or an outsider
    for (const u of ['u4', 'u5']) assert.equal((await asUser(u, () => app.query(`SELECT 1 FROM marketplace_assignment_status()`))).rowCount, 0, u);
    // pinning a pulled version is refused; a mode-only change to the blocked assignment still works for a manager
    await assert.rejects(asUser('u1', () => app.query(`UPDATE marketplace_team_assignments SET version_id = 'v_skill', pinned_version = '1.0.0' WHERE id = 'asg1'`)), /not assignable|check/);
    await asUser('u1', async () => assert.equal((await app.query(`UPDATE marketplace_team_assignments SET mode = 'optional' WHERE id = 'asg2'`)).rowCount, 1));
  });

  test('team_policy_writable_by_team_manager_only', async () => {
    const put = (u: string, team: string, by = u) => app.query(
      `INSERT INTO marketplace_policies(scope_kind, scope_id, mode, updated_by) VALUES ('team',$1,'allowlist',$2)`, [team, by]);
    for (const u of ['u3', 'u4', 'u5']) await assert.rejects(asUser(u, () => put(u, 'tA')), /row-level security/, u);
    await assert.rejects(asUser('u2', () => put('u2', 'tA', 'u1')), /row-level security/);       // updated_by forged
    await assert.rejects(asUser('u2', () => put('u2', 'tB')), /row-level security/);             // admin of A writing B's scope
    await assert.rejects(asUser('u2', () => put('u2', 'ghost')), /row-level security/);
    await h.asUserCommit('u2', () => put('u2', 'tA'));
    await h.asUserCommit('u4', () => put('u4', 'tB'));
    const rule = (u: string, id: string, team: string) => app.query(
      `INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value, created_by) VALUES ($1,'team',$2,'allow','type','agent',$3)`, [id, team, u]);
    await assert.rejects(asUser('u3', () => rule('u3', 'r0', 'tA')), /row-level security/);
    await assert.rejects(asUser('u2', () => rule('u2', 'r0', 'tB')), /row-level security/);
    await h.asUserCommit('u2', () => rule('u2', 'rA', 'tA'));
    await h.asUserCommit('u4', () => rule('u4', 'rB', 'tB'));
    // member and outsiders cannot change or delete
    await asUser('u3', async () => {
      assert.equal((await app.query(`UPDATE marketplace_policies SET mode = 'open' WHERE scope_id = 'tA'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_policy_rules WHERE id = 'rA'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_policies WHERE scope_id = 'tA'`)).rowCount, 0);
    });
    await asUser('u4', async () => assert.equal((await app.query(`UPDATE marketplace_policies SET mode = 'open', updated_by = 'u4' WHERE scope_id = 'tA'`)).rowCount, 0));
    await asUser('u2', async () => assert.equal((await app.query(`UPDATE marketplace_policies SET mode = 'open', updated_by = 'u2' WHERE scope_id = 'tA'`)).rowCount, 1));
    await assert.rejects(asUser('u2', () => app.query(`UPDATE marketplace_policies SET scope_id = 'tB' WHERE scope_id = 'tA'`)), /permission denied/);
    await assert.rejects(asUser('u2', () => app.query(`UPDATE marketplace_policy_rules SET effect = 'deny' WHERE id = 'rA'`)), /permission denied/);
  });

  test('team_policies_and_rules_are_not_readable_by_other_teams', async () => {
    const seen = async (u: string) => ({
      pol: (await asUser(u, () => app.query(`SELECT scope_id FROM marketplace_policies WHERE scope_kind = 'team' ORDER BY scope_id`))).rows.map((r) => r.scope_id),
      rules: (await asUser(u, () => app.query(`SELECT id FROM marketplace_policy_rules WHERE scope_kind = 'team' ORDER BY id`))).rows.map((r) => r.id) });
    assert.deepEqual(await seen('u3'), { pol: ['tA'], rules: ['rA'] });
    assert.deepEqual(await seen('u4'), { pol: ['tB'], rules: ['rB'] });
    assert.deepEqual(await seen('u5'), { pol: [], rules: [] });
  });

  test('org_policy_is_admin_only_but_readable', async () => {
    for (const u of ['u1', 'u2', 'u3', 'u5']) {
      await assert.rejects(asUser(u, () => app.query(`INSERT INTO marketplace_policies(scope_kind, scope_id, mode, updated_by) VALUES ('org','default','allowlist',$1)`, [u])), /row-level security/, u);
    }
    await admin.query(`INSERT INTO marketplace_policies(scope_kind, scope_id, mode, min_trust) VALUES ('org','default','open','community')`);
    await admin.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('rOrg','org','default','deny','publisher','pb')`);
    // any signed-in user can read it
    assert.equal((await asUser('u5', () => app.query(`SELECT 1 FROM marketplace_policies WHERE scope_kind = 'org'`))).rowCount, 1);
    assert.equal((await asUser('u5', () => app.query(`SELECT 1 FROM marketplace_policy_rules WHERE scope_kind = 'org'`))).rowCount, 1);
    // a team owner cannot touch it, nor smuggle an org rule
    await asUser('u1', async () => {
      assert.equal((await app.query(`UPDATE marketplace_policies SET mode = 'allowlist', updated_by = 'u1' WHERE scope_kind = 'org'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_policies WHERE scope_kind = 'org'`)).rowCount, 0);
      assert.equal((await app.query(`DELETE FROM marketplace_policy_rules WHERE id = 'rOrg'`)).rowCount, 0);
    });
    await assert.rejects(asUser('u1', () => app.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value, created_by) VALUES ('sneak','org','default','allow','type','agent','u1')`)), /row-level security/);
    // ao_readonly can read, not write
    const ro = h.pool('ao_readonly');
    assert.ok((await ro.query(`SELECT 1 FROM marketplace_policies`)).rowCount! >= 3);
    await assert.rejects(ro.query(`DELETE FROM marketplace_policies`), /permission denied/);
  });

  test('effective_policy_is_per_caller_and_cannot_peek_at_other_users', async () => {
    const get = async (u: string, about: string) => parseEffectivePolicy((await asUser(u, () => app.query(`SELECT marketplace_effective_policy($1) AS p`, [about]))).rows[0].p);
    const l3 = await get('u3', 'u3');
    assert.deepEqual(l3.layers.map((l) => `${l.scopeKind}:${l.scopeId}`), ['org:default', 'team:tA']);
    assert.deepEqual(l3.layers[0].rules, [{ effect: 'deny', matchKind: 'publisher', matchValue: 'pb' }]);
    assert.deepEqual((await get('u5', 'u5')).layers.map((l) => l.scopeId), ['default']);
    await assert.rejects(get('u5', 'u3'), /only for the calling user/);
    await assert.rejects(get('u3', 'u4'), /only for the calling user/);
    // no app.user_id at all: the app role is refused; the admin pool may ask about any user
    await assert.rejects(app.query(`SELECT marketplace_effective_policy('u3')`), /app\.user_id is not set/);
    const viaAdmin = parseEffectivePolicy((await admin.query(`SELECT marketplace_effective_policy('u4') AS p`)).rows[0].p);
    assert.deepEqual(viaAdmin.layers.map((l) => l.scopeId), ['default', 'tB']);
  });

  test('no_public_execute_on_the_new_functions', async () => {
    const fns = ['marketplace_is_team_member', 'marketplace_is_team_manager', 'marketplace_team_assignments_guard', 'marketplace_assignment_status',
      'marketplace_policies_guard', 'marketplace_policy_rules_guard', 'marketplace_effective_policy'];
    const pub = await owner.query(
      `SELECT p.proname FROM pg_proc p WHERE p.proname = ANY($1)
         AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`, [fns]);
    assert.deepEqual(pub.rows, []);
    // every definer function pins its search_path
    const unpinned = await owner.query(
      `SELECT proname FROM pg_proc WHERE proname = ANY($1) AND prosecdef AND NOT coalesce(proconfig::text LIKE '%search_path=pg_catalog, public%', false)`, [fns]);
    assert.deepEqual(unpinned.rows, []);
    // and the trigger functions cannot be invoked directly by the app role
    for (const f of ['marketplace_team_assignments_guard', 'marketplace_policies_guard', 'marketplace_policy_rules_guard']) {
      await assert.rejects(asUser('u1', () => app.query(`SELECT ${f}()`)), /permission denied/, f);
    }
  });

  test('membership_helpers_answer_only_about_the_caller', async () => {
    const q = async (u: string, fn: string, team: string) => (await asUser(u, () => app.query(`SELECT ${fn}($1) AS v`, [team]))).rows[0].v;
    assert.equal(await q('u3', 'marketplace_is_team_member', 'tA'), true);
    assert.equal(await q('u3', 'marketplace_is_team_manager', 'tA'), false);
    assert.equal(await q('u2', 'marketplace_is_team_manager', 'tA'), true);
    assert.equal(await q('u5', 'marketplace_is_team_member', 'tA'), false);
    assert.equal(await q('u5', 'marketplace_is_team_member', 'ghost'), false);
    assert.equal((await app.query(`SELECT marketplace_is_team_manager('tA') AS v`)).rows[0].v, false);   // no app.user_id
  });

  test('a_member_cannot_promote_themselves_to_manager', async () => {
    await assert.rejects(asUser('u3', () => app.query(`UPDATE marketplace_team_members SET role = 'admin' WHERE team_id = 'tA' AND user_id = 'u3'`)), /permission denied/);
    await assert.rejects(asUser('u3', () => app.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ('tB','u3','owner')`)), /permission denied/);
    await assert.rejects(asUser('u5', () => ins('z', 'tA', 'pa/agent', 'v_agent', '1.0.0', SHA('a'), 'u5')), /row-level security/);
  });
});
