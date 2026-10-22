// Migration 0017 (team assignments, policy tables) on PGlite: constraints, triggers and functions. Role
// GRANT/POLICY statements sit in a guarded section that is a no-op here; roles/RLS are in
// marketplace-policy-rls.test.ts on a real Postgres. Also the pure evaluate() matrix.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { evaluate, parseEffectivePolicy, type EffectivePolicy, type PolicyLayer, type PolicySubject } from '../src/marketplace/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const mig = (n: string) => readFileSync(join(here, '..', '..', '..', 'database', 'migrations', n), 'utf8');
const STUB = `
  CREATE TABLE users (id text PRIMARY KEY, email text);
  CREATE TABLE devices (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE);`;
const SHA = (c: string) => c.repeat(64);

describe('marketplace policy schema (pglite)', () => {
  let db: PGlite;
  before(async () => {
    db = new PGlite();
    await db.exec(STUB); await db.exec(mig('0021_marketplace.sql')); await db.exec(mig('0022_marketplace_agents.sql'));
    await db.exec(`
      INSERT INTO users(id) VALUES ('u1'),('u2');
      INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ('pa','A','u1');
      INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ('t1','T1','u1'),('t2','T2','u2');
      INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, title) VALUES
        ('pa/agent','agent','pa','u1','public',NULL,'Agent'), ('pa/priv','agent','pa','u1','private',NULL,'Priv'),
        ('pa/t1only','skill','pa','u1','team','t1','T1 only'), ('pa/conn','connector','pa','u1','public',NULL,'Conn');
      INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ('${SHA('a')}',1,'k'),('${SHA('b')}',1,'k2');
      INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES
        ('v_agent','pa/agent','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_draft','pa/agent','2.0.0',2,0,0,'draft','{}','${SHA('b')}',1,'pending'),
        ('v_priv','pa/priv','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_t1','pa/t1only','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean'),
        ('v_conn','pa/conn','1.0.0',1,0,0,'published','{}','${SHA('a')}',1,'clean');`);
  });
  after(async () => { await db.close(); });

  const assign = (id: string, team: string, listing: string, ver: string, pinned: string, sha: string, mode = 'required') => db.query(
    `INSERT INTO marketplace_team_assignments(id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode, assigned_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'u1')`,
    [id, team, listing, ver, pinned, sha, mode]);

  test('assignment_pins_must_reference_a_real_published_version', async () => {
    await assign('a1', 't1', 'pa/agent', 'v_agent', '1.0.0', SHA('a'));
    await assert.rejects(assign('a2', 't2', 'pa/agent', 'v_agent', '1.0.0', SHA('b')), /not assignable/);         // wrong hash
    await assert.rejects(assign('a3', 't2', 'pa/agent', 'v_agent', '9.9.9', SHA('a')), /not assignable/);         // wrong version string
    await assert.rejects(assign('a4', 't2', 'pa/agent', 'v_draft', '2.0.0', SHA('b')), /not assignable/);         // not published
    await assert.rejects(assign('a5', 't2', 'pa/agent', 'v_nope', '1.0.0', SHA('a')), /not assignable|foreign key/); // no such version
    await assert.rejects(assign('a6', 't2', 'pa/conn', 'v_conn', '1.0.0', SHA('a')), /not assignable/);           // type not assignable
    await assert.rejects(assign('a7', 't2', 'pa/agent', 'v_t1', '1.0.0', SHA('a')), /not assignable/);            // version of another listing
    await assert.rejects(assign('a8', 't1', 'pa/agent', 'v_agent', '1.0.0', SHA('a')), /unique|duplicate/);       // one assignment per team+listing
    await assert.rejects(db.query(`INSERT INTO marketplace_team_assignments(id,team_id,listing_id,version_id,pinned_version,pin_sha256,mode) VALUES ('m','t2','pa/agent','v_agent','1.0.0','${SHA('a')}','forced')`), /check/i);
  });

  test('private_and_other_team_listings_are_not_assignable', async () => {
    await assert.rejects(assign('b1', 't1', 'pa/priv', 'v_priv', '1.0.0', SHA('a')), /not assignable/);
    await assert.rejects(assign('b2', 't2', 'pa/t1only', 'v_t1', '1.0.0', SHA('a')), /not assignable/);
    await assign('b3', 't1', 'pa/t1only', 'v_t1', '1.0.0', SHA('a'), 'optional');
  });

  test('assignment_identity_columns_are_immutable_but_mode_can_change_after_a_pull', async () => {
    await assert.rejects(db.query(`UPDATE marketplace_team_assignments SET team_id = 't2' WHERE id = 'b3'`), /immutable/);
    await db.exec(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = 'v_t1'`);
    await db.exec(`UPDATE marketplace_team_assignments SET mode = 'recommended' WHERE id = 'b3'`);
    await assert.rejects(db.query(`UPDATE marketplace_team_assignments SET pinned_version = '1.0.0', version_id = 'v_priv' WHERE id = 'b3'`), /not assignable/);
  });

  test('policy_scope_rules', async () => {
    await assert.rejects(db.query(`INSERT INTO marketplace_policies(scope_kind, scope_id) VALUES ('org','other')`), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_policies(scope_kind, scope_id) VALUES ('team','no-such-team')`), /unknown team/);
    await db.exec(`INSERT INTO marketplace_policies(scope_kind, scope_id, mode) VALUES ('org','default','open'), ('team','t1','allowlist')`);
    await assert.rejects(db.query(`UPDATE marketplace_policies SET scope_id = 't2' WHERE scope_id = 't1'`), /immutable/);
    await assert.rejects(db.query(`INSERT INTO marketplace_policies(scope_kind, scope_id, min_trust) VALUES ('team','t2','godlike')`), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('r0','team','t2','allow','type','skill')`), /foreign key/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('r1','team','t1','allow','listing','Not A Listing')`), /check/i);
    await assert.rejects(db.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('r2','team','t1','allow','type','bogus')`), /check/i);
    await db.exec(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('r3','team','t1','allow','type','agent')`);
    await assert.rejects(db.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('r4','team','t1','allow','type','agent')`), /unique|duplicate/);
    await assert.rejects(db.query(`UPDATE marketplace_policy_rules SET effect = 'deny' WHERE id = 'r3'`), /replaced/);
  });

  test('rules_per_scope_are_capped', async () => {
    await db.exec(`INSERT INTO marketplace_policies(scope_kind, scope_id) VALUES ('team','t2')`);
    await db.exec(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value)
                   SELECT 'cap'||g, 'team','t2','allow','listing','pa/x'||g FROM generate_series(1,500) g`);
    await assert.rejects(db.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('cap-x','team','t2','allow','type','skill')`), /at most 500/);
  });

  test('effective_policy_returns_org_then_the_users_teams_only', async () => {
    await db.exec(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ('t1','u1','owner'),('t2','u2','owner')`);
    const p = parseEffectivePolicy((await db.query<{ p: unknown }>(`SELECT marketplace_effective_policy('u1') AS p`)).rows[0].p);
    assert.deepEqual(p.layers.map((l) => `${l.scopeKind}:${l.scopeId}`), ['org:default', 'team:t1']);
    assert.deepEqual(p.layers[1].rules, [{ effect: 'allow', matchKind: 'type', matchValue: 'agent' }]);
    const q = parseEffectivePolicy((await db.query<{ p: unknown }>(`SELECT marketplace_effective_policy('u2') AS p`)).rows[0].p);
    assert.deepEqual(q.layers.map((l) => `${l.scopeKind}:${l.scopeId}`), ['org:default', 'team:t2']);
  });
});

const S: PolicySubject = { listingId: 'pa/agent', publisherId: 'pa', type: 'agent', trust: 'community', scanVerdict: 'clean' };
const L = (over: Partial<PolicyLayer> = {}): PolicyLayer => ({ scopeKind: 'org', scopeId: 'default', mode: 'open', minTrust: null, requireCleanScan: true, rules: [], ...over });
const P = (...layers: PolicyLayer[]): EffectivePolicy => ({ layers });

describe('policy evaluate()', () => {
  test('no_layers_and_open_allow', () => {
    assert.equal(evaluate(P(), S).allowed, true);
    assert.equal(evaluate(P(L()), S).allowed, true);
  });
  test('deny_beats_allow_across_layers', () => {
    const org = L({ rules: [{ effect: 'deny', matchKind: 'publisher', matchValue: 'pa' }] });
    const team = L({ scopeKind: 'team', scopeId: 't1', mode: 'allowlist', rules: [{ effect: 'allow', matchKind: 'listing', matchValue: 'pa/agent' }] });
    const d = evaluate(P(org, team), S);
    assert.equal(d.allowed, false); assert.match(d.reason!, /organization policy/);
    assert.equal(evaluate(P(L({ rules: [{ effect: 'deny', matchKind: 'type', matchValue: 'agent' }, { effect: 'allow', matchKind: 'type', matchValue: 'agent' }] })), S).allowed, false);
  });
  test('allowlist_with_no_rules_denies_everything', () => {
    assert.equal(evaluate(P(L({ mode: 'allowlist' })), S).allowed, false);
  });
  test('allowlist_must_match_in_every_allowlist_layer', () => {
    const allowAgent = { effect: 'allow' as const, matchKind: 'type' as const, matchValue: 'agent' };
    const org = L({ mode: 'allowlist', rules: [allowAgent] });
    const team = L({ scopeKind: 'team', scopeId: 't1', mode: 'allowlist', rules: [{ effect: 'allow', matchKind: 'type', matchValue: 'skill' }] });
    assert.equal(evaluate(P(org), S).allowed, true);
    const d = evaluate(P(org, team), S);
    assert.equal(d.allowed, false); assert.match(d.reason!, /team policy \(t1\)/);
    assert.equal(evaluate(P(L(), team), { ...S, type: 'skill' }).allowed, true);   // open org + team allowlist
  });
  test('trust_floor_and_clean_scan', () => {
    assert.equal(evaluate(P(L({ minTrust: 'verified' })), S).allowed, false);
    assert.equal(evaluate(P(L({ minTrust: 'verified' })), { ...S, trust: 'official' }).allowed, true);
    assert.equal(evaluate(P(L({ minTrust: 'community' })), S).allowed, true);
    assert.equal(evaluate(P(L()), { ...S, scanVerdict: 'warnings' }).allowed, false);
    assert.equal(evaluate(P(L({ requireCleanScan: false })), { ...S, scanVerdict: 'warnings' }).allowed, true);
    assert.equal(evaluate(P(L({ requireCleanScan: false })), { ...S, scanVerdict: 'blocked' }).allowed, true);   // blocked never publishes; policy does not decide that
  });
  test('parse_rejects_garbage_fail_closed', () => {
    for (const bad of [null, {}, { layers: 'x' }, { layers: [{}] }, { layers: [{ scopeKind: 'org', scopeId: 'default', mode: 'nope', minTrust: null, requireCleanScan: true, rules: [] }] },
      { layers: [{ ...L(), rules: [{ effect: 'maybe', matchKind: 'type', matchValue: 'x' }] }] }]) {
      assert.throws(() => parseEffectivePolicy(bad), /invalid effective policy/);
    }
    assert.deepEqual(parseEffectivePolicy({ layers: [L()] }), P(L()));
  });
});
