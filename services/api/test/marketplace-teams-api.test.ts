// Plan 2 Task 7: team assignments, install policy, install-time re-resolution, bundle plans and the install-sync reasons, over HTTP on a
// REAL Postgres (embedded, real ao_app / ao_admin roles, RLS on). Every refusal is checked for "zero rows changed".
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { evaluate } from '../src/marketplace/policy.ts';
import { skip } from './helpers/marketplace-pg.ts';
import { agentPkg, startHarness, zipOf, type Harness } from './helpers/agents-harness.ts';
import { pkgOf } from './helpers/bundle-fixtures.ts';
import { baseBp, fakeBridge, safeScanner } from './marketplace-agent-helpers.ts';
import { parsePolicyDoc } from '../src/api/marketplace-teams.ts';
import { permissionsOf } from '../src/marketplace/permissions.ts';

const T1 = 'team_' + '1'.repeat(18), T2 = 'team_' + '2'.repeat(18);

describe('team assignments, policy and install-time resolution (real Postgres)', { skip }, () => {
  let t: Harness;
  let pub: { versionId: string; sha256: string }, pub2: { versionId: string; sha256: string }, tskill: { versionId: string; sha256: string }, t2skill: { versionId: string; sha256: string }, priv: { versionId: string };
  const one = async (sql: string, args: unknown[] = []) => (await t.admin.query(sql, args)).rows[0];
  const count = async (sql: string, args: unknown[] = []) => Number((await one(sql, args)).n);
  const rows = async () => ({
    a: await count(`SELECT count(*) n FROM marketplace_team_assignments`), p: await count(`SELECT count(*) n FROM marketplace_policies`),
    r: await count(`SELECT count(*) n FROM marketplace_policy_rules`), au: await count(`SELECT count(*) n FROM marketplace_team_audit`), aa: await count(`SELECT count(*) n FROM admin_audit`),
  });
  const assign = (user: string, team: string, body: unknown) => t.call(`/v1/marketplace/teams/${team}/assignments`, { user, body });
  const sync = (user: string, deviceId: string) => t.call('/v1/marketplace/installs/sync', { user, body: { deviceId, items: [] } });

  before(async () => {
    t = await startHarness({ bridge: fakeBridge(), scanner: safeScanner, users: 8 });
    await t.admin.query(`INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ($1,'One','u1'),($2,'Two','u4')`, [T1, T2]);
    await t.admin.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,'u1','owner'),($1,'u2','admin'),($1,'u3','member'),($2,'u4','owner'),($2,'u5','member'),($2,'u2','member')`, [T1, T2]);
    await t.h.owner.query(`INSERT INTO devices(id, user_id) VALUES ('d3','u3'),('d2','u2'),('d5','u5')`);
    pub = await t.seedSkill('acme/s', { version: '1.0.0' });
    pub2 = await t.seedSkill('acme/s', { version: '1.1.0' });
    tskill = await t.seedSkill('acme/team-skill', { visibility: 'team', team: T1, owner: 'u1' });
    t2skill = await t.seedSkill('acme/t2-skill', { visibility: 'team', team: T2, owner: 'u4' });
    priv = await t.seedSkill('acme/private-skill', { visibility: 'private', owner: 'u1' });
  });
  after(async () => { await t?.stop(); });

  // ── assignments: authz at the API and the database
  test('assignments: unauthenticated 401; an outsider and a missing team are the same 404; a plain member reads but cannot write', async () => {
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments`)).status, 401);
    const out = await t.call(`/v1/marketplace/teams/${T1}/assignments`, { user: 'u5' });
    const missing = await t.call(`/v1/marketplace/teams/team_${'f'.repeat(18)}/assignments`, { user: 'u5' });
    const malformed = await t.call(`/v1/marketplace/teams/not-a-team/assignments`, { user: 'u5' });
    assert.equal(out.status, 404); assert.deepEqual(out.json, missing.json); assert.deepEqual(out.json, malformed.json);
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments`, { user: 'u3' })).status, 200);
    const before = await rows();
    const r = await assign('u3', T1, { listingId: 'acme/s', versionId: pub.versionId });
    assert.equal(r.status, 403);
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/policy`, { user: 'u3', method: 'PUT', body: { mode: 'open' } })).status, 403);
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments/acme/s`, { user: 'u3', method: 'DELETE' })).status, 403);
    assert.deepEqual(await rows(), before, 'zero rows changed on 403');
    // an outsider writing gets the 404, not a 403 that would confirm the team exists
    assert.equal((await assign('u5', T1, { listingId: 'acme/s', versionId: pub.versionId })).status, 404);
    assert.deepEqual(await rows(), before);
  });
  test('a team admin pins a version: the pin comes from the version row, never from the body', async () => {
    const forged = await assign('u2', T1, { listingId: 'acme/s', versionId: pub.versionId, pinned_version: '9.9.9', pin_sha256: 'a'.repeat(64) });
    assert.equal(forged.status, 400, 'a forged pin field is refused, not silently ignored');
    const ok = await assign('u2', T1, { listingId: 'acme/s', versionId: pub.versionId, mode: 'required' });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.pinnedVersion, '1.0.0'); assert.equal(ok.json.pinSha256, pub.sha256); assert.equal(ok.json.mode, 'required'); assert.equal(ok.json.blocked, false);
    const row = await one(`SELECT pinned_version, pin_sha256, assigned_by FROM marketplace_team_assignments WHERE team_id = $1`, [T1]);
    assert.deepEqual({ ...row }, { pinned_version: '1.0.0', pin_sha256: pub.sha256, assigned_by: 'u2' });
    const a = await one(`SELECT actor, action, detail FROM marketplace_team_audit WHERE team_id = $1 ORDER BY id DESC LIMIT 1`, [T1]);
    assert.equal(a.actor, 'u2'); assert.equal(a.action, 'assign'); assert.equal(a.detail.pinSha256, pub.sha256);
  });
  test('re-pinning to another version is an update with its own audit row; the owner (not only an admin) may manage', async () => {
    const r = await assign('u1', T1, { listingId: 'acme/s', versionId: pub2.versionId, mode: 'recommended' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.pinnedVersion, '1.1.0'); assert.equal(r.json.pinSha256, pub2.sha256);
    assert.equal(await count(`SELECT count(*) n FROM marketplace_team_assignments WHERE team_id = $1`, [T1]), 1);
    assert.equal((await one(`SELECT action FROM marketplace_team_audit WHERE team_id = $1 ORDER BY id DESC LIMIT 1`, [T1])).action, 'reassign');
  });
  test('a team admin cannot assign what the team cannot see: every refusal is the same 422 (no existence oracle) and changes nothing', async () => {
    const before = await rows();
    const cases: Array<[string, unknown]> = [
      ['another team\'s listing', { listingId: 'acme/t2-skill', versionId: t2skill.versionId }],
      ['a private listing', { listingId: 'acme/private-skill', versionId: priv.versionId }],
      ['a version that does not exist', { listingId: 'acme/s', versionId: 'v_nope' }],
      ['a version of another listing', { listingId: 'acme/team-skill', versionId: pub.versionId }],
      ['a listing that does not exist', { listingId: 'acme/ghost', versionId: pub.versionId }],
    ];
    const bodies = new Set<string>();
    for (const [name, body] of cases) {
      const r = await assign('u2', T1, body);
      assert.equal(r.status, 422, name); bodies.add(JSON.stringify(r.json));
    }
    assert.equal(bodies.size, 1, 'all refusals are byte-identical');
    assert.deepEqual(await rows(), before);
    // the team's own team-visible listing is assignable
    assert.equal((await assign('u2', T1, { listingId: 'acme/team-skill', versionId: tskill.versionId })).status, 201);
  });
  test('malformed bodies are 4xx, never 500: null, array, invalid JSON, wrong types, oversize', async () => {
    const before = await rows();
    const url = `/v1/marketplace/teams/${T1}/assignments`;
    for (const raw of ['null', '[]', '"x"', '{bad', '12']) assert.equal((await t.call(url, { user: 'u2', raw })).status, 400, raw);
    for (const body of [{ listingId: 5, versionId: 'x' }, { listingId: 'acme/s', versionId: {} }, { listingId: 'acme/s', versionId: pub.versionId, mode: 'always' }, { listingId: '../x', versionId: 'v' }, {}]) {
      assert.equal((await t.call(url, { user: 'u2', body })).status, 400, JSON.stringify(body));
    }
    const big = await t.call(url, { user: 'u2', raw: JSON.stringify({ listingId: 'acme/s', versionId: 'x'.repeat(300_000) }) });
    assert.ok(big.status === 413 || big.status === 400, String(big.status));
    assert.deepEqual(await rows(), before);
  });
  test('unassign: a member cannot, an admin can, a second time is 404; each is audited', async () => {
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments/acme/team-skill`, { user: 'u3', method: 'DELETE' })).status, 403);
    assert.equal(await count(`SELECT count(*) n FROM marketplace_team_assignments WHERE listing_id = 'acme/team-skill'`), 1);
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments/acme/team-skill`, { user: 'u2', method: 'DELETE' })).status, 200);
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments/acme/team-skill`, { user: 'u2', method: 'DELETE' })).status, 404);
    assert.equal((await one(`SELECT action FROM marketplace_team_audit WHERE team_id = $1 ORDER BY id DESC LIMIT 1`, [T1])).action, 'unassign');
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments/not-a-listing`, { user: 'u2', method: 'DELETE' })).status, 404);
  });

  // ── revocation delivery
  test('a revoked pinned version is reported to assignees (assignment_blocked) and to anyone who installed it; outsiders learn nothing', async () => {
    await t.admin.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('i_a','u3','d3','acme/s',$1,'enabled',true)`, [pub2.versionId]);
    assert.deepEqual((await sync('u3', 'd3')).json.assignments, []);
    await t.admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [pub2.versionId]);
    await t.admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ('acme/s',$1,'revoked','root','{"reason":"malware found"}')`, [pub2.versionId]);
    const s = await sync('u3', 'd3');
    assert.equal(s.status, 200);
    assert.equal(s.json.assignments.length, 1);
    assert.deepEqual({ ...s.json.assignments[0], assignmentId: undefined }, { assignmentId: undefined, teamId: T1, listingId: 'acme/s', versionId: pub2.versionId, pinnedVersion: '1.1.0', mode: 'recommended', state: 'revoked', reason: 'assignment_blocked', detail: 'malware found' });
    const up = s.json.updates.find((u: any) => u.listingId === 'acme/s');
    assert.equal(up.revoked, true); assert.equal(up.reason, 'revoked'); assert.equal(up.detail, 'malware found');
    assert.deepEqual((await sync('u5', 'd5')).json.assignments, [], 'a user of another team learns nothing about this team\'s pins');
    const list = (await t.call(`/v1/marketplace/teams/${T1}/assignments`, { user: 'u3' })).json.items.find((i: any) => i.listingId === 'acme/s');
    assert.equal(list.blocked, true); assert.equal(list.reason, 'assignment_blocked'); assert.equal(list.detail, 'malware found'); assert.equal(list.assignedBy, undefined, 'members do not see who assigned');
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments`, { user: 'u2' })).json.items[0].assignedBy !== undefined, true);
    // a pulled version cannot be pinned again
    assert.equal((await assign('u2', T1, { listingId: 'acme/s', versionId: pub2.versionId })).status, 422);
  });
  test('access_revoked: leaving a team is reported for what was installed from it; items still visible are untouched', async () => {
    await t.admin.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('i_t','u3','d3','acme/team-skill',$1,'enabled',true)`, [tskill.versionId]);
    const before = (await sync('u3', 'd3')).json.updates.find((u: any) => u.listingId === 'acme/team-skill');
    assert.equal(before, undefined);
    await t.admin.query(`DELETE FROM marketplace_team_members WHERE team_id = $1 AND user_id = 'u3'`, [T1]);
    const after = (await sync('u3', 'd3')).json.updates;
    const gone = after.find((u: any) => u.listingId === 'acme/team-skill');
    assert.equal(gone.state, 'access_revoked'); assert.equal(gone.reason, 'access_revoked'); assert.equal(gone.revoked, undefined);
    assert.equal(after.find((u: any) => u.listingId === 'acme/s').reason, 'revoked', 'a pulled version is still reported as revoked, not as lost access');
    assert.equal((await t.call(`/v1/marketplace/teams/${T1}/assignments`, { user: 'u3' })).status, 404, 'and the former member no longer sees the team');
  });
  test('dependency_revoked: an installed agent whose only satisfying dependency version was pulled is reported; a still-satisfiable range is not', async () => {
    const dep1 = await t.seedSkill('dep/lib', { version: '1.0.0' });
    await t.admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary) VALUES ('acme/host','agent','acme','u1','public','community','h','s'), ('acme/host2','agent','acme','u1','public','community','h','s')`);
    for (const [vid, lid, rng] of [['v_host', 'acme/host', '^1.0.0'], ['v_host2', 'acme/host2', '^2.0.0']]) {
      await t.admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ($1,$2,'1.0.0',1,0,0,'published','{}',$3,1,'clean')`, [vid, lid, dep1.sha256]);
      await t.admin.query(`INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) VALUES ($1,'dep/lib',$2)`, [vid, rng]);
      await t.admin.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ($1,'u2','d2',$2,$3,'enabled',true)`, [`i_${vid}`, lid, vid]);
    }
    const dep2 = await t.seedSkill('dep/lib', { version: '1.5.0' });
    await t.seedSkill('dep/lib', { version: '2.0.0' });
    assert.equal((await sync('u2', 'd2')).json.updates.find((u: any) => u.listingId === 'acme/host'), undefined);
    await t.admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [dep1.versionId]);
    assert.equal((await sync('u2', 'd2')).json.updates.find((u: any) => u.listingId === 'acme/host'), undefined, '1.5.0 still satisfies ^1.0.0');
    await t.admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [dep2.versionId]);
    await t.admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ('dep/lib',$1,'revoked','root','{"reason":"supply-chain compromise"}')`, [dep2.versionId]);
    const up = (await sync('u2', 'd2')).json.updates;
    const host = up.find((u: any) => u.listingId === 'acme/host');
    assert.equal(host.reason, 'dependency_revoked'); assert.equal(host.revoked, true); assert.match(host.detail, /dep\/lib/);
    assert.equal(up.find((u: any) => u.listingId === 'acme/host2'), undefined, '2.0.0 satisfies ^2.0.0');
    // the function only answers about versions the CALLER installed
    const client = t.h.app;
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','u5',true)`);
    assert.equal((await client.query(`SELECT * FROM marketplace_dependency_status(ARRAY['v_host','v_host2'])`)).rowCount, 0);
    await client.query(`SELECT set_config('app.user_id','u2',true)`);
    assert.ok((await client.query(`SELECT * FROM marketplace_dependency_status(ARRAY['v_host'])`)).rowCount! > 0);
    await assert.rejects(() => client.query(`SELECT * FROM marketplace_dependency_status($1::text[])`, [Array.from({ length: 201 }, (_, i) => `v${i}`)]), /at most 200/);
    await client.query('ROLLBACK');
  });

  // ── policy
  test('team policy: members read, owner/admin write, outsiders get 404; the document is strict', async () => {
    const url = `/v1/marketplace/teams/${T1}/policy`;
    assert.deepEqual((await t.call(url, { user: 'u2' })).json, { mode: 'open', minTrust: null, requireCleanScan: true, rules: [], configured: false, updatedAt: null, updatedBy: null });
    assert.equal((await t.call(url, { user: 'u5' })).status, 404);
    const doc = { mode: 'allowlist', minTrust: 'community', requireCleanScan: true, rules: [{ effect: 'allow', matchKind: 'publisher', matchValue: 'acme' }, { effect: 'deny', matchKind: 'listing', matchValue: 'acme/s' }] };
    const put = await t.call(url, { user: 'u2', method: 'PUT', body: doc });
    assert.equal(put.status, 200, JSON.stringify(put.json)); assert.equal(put.json.rules.length, 2); assert.equal(put.json.configured, true); assert.equal(put.json.updatedBy, 'u2');
    const a = await one(`SELECT action, detail FROM marketplace_team_audit WHERE team_id = $1 ORDER BY id DESC LIMIT 1`, [T1]);
    assert.equal(a.action, 'policy_set'); assert.equal(a.detail.rules, 2);
    // replacing removes the old rules
    const put2 = await t.call(url, { user: 'u1', method: 'PUT', body: { mode: 'open', rules: [{ effect: 'deny', matchKind: 'type', matchValue: 'hook' }] } });
    assert.equal(put2.status, 200); assert.deepEqual(put2.json.rules, [{ effect: 'deny', matchKind: 'type', matchValue: 'hook' }]);
    assert.equal(await count(`SELECT count(*) n FROM marketplace_policy_rules WHERE scope_id = $1`, [T1]), 1);
  });
  test('team policy: the hostile corpus is 400 and changes nothing', async () => {
    const url = `/v1/marketplace/teams/${T1}/policy`;
    const before = await rows();
    const rule = (o: Record<string, unknown> = {}) => ({ effect: 'allow', matchKind: 'publisher', matchValue: 'acme', ...o });
    const bad: unknown[] = [
      { mode: 'maybe' }, {}, { mode: 'open', minTrust: 'godlike' }, { mode: 'open', requireCleanScan: 'yes' }, { mode: 'open', rules: 'x' }, { mode: 'open', extra: 1 },
      { mode: 'open', rules: [rule({ effect: 'permit' })] }, { mode: 'open', rules: [rule({ matchKind: 'regex' })] }, { mode: 'open', rules: [rule({ matchValue: 'Has Spaces' })] },
      { mode: 'open', rules: [rule({ matchKind: 'listing', matchValue: 'noslash' })] }, { mode: 'open', rules: [rule({ matchKind: 'type', matchValue: 'rocket' })] },
      { mode: 'open', rules: [rule(), rule()] }, { mode: 'open', rules: [rule({ junk: 1 })] }, { mode: 'open', rules: [null] },
      { mode: 'open', rules: Array.from({ length: 501 }, (_, i) => rule({ matchValue: `p${i}` })) },
      JSON.parse('{"mode":"open","__proto__":{"x":1}}'),
    ];
    for (const body of bad) { const r = await t.call(url, { user: 'u2', method: 'PUT', raw: JSON.stringify(body) }); assert.ok(r.status === 400 || r.status === 413, `${JSON.stringify(body).slice(0, 80)} -> ${r.status}`); }
    for (const raw of ['null', '[]', '{bad']) assert.equal((await t.call(url, { user: 'u2', method: 'PUT', raw })).status, 400, raw);
    const r = await rows(); assert.equal(r.p, before.p); assert.equal(r.r, before.r); assert.equal(r.au, before.au);
    assert.throws(() => parsePolicyDoc({ mode: 'open', rules: [{ effect: 'allow', matchKind: 'publisher', matchValue: 'x'.repeat(121) }] }), /matchValue/);
  });
  test('GET /admin/marketplace/me tells the console the caller\'s marketplace role and permissions from the same table the API enforces (no token: 401)', async () => {
    assert.equal((await t.call('/admin/marketplace/me', { origin: t.adminApi })).status, 401);
    const root = await t.call('/admin/marketplace/me', { as: 'root' });
    assert.equal(root.status, 200, JSON.stringify(root.json)); assert.equal(root.json.role, 'superadmin');
    assert.deepEqual(root.json.permissions, [...permissionsOf('superadmin')]);
    const ana = await t.call('/admin/marketplace/me', { as: 'ana' });
    assert.deepEqual(ana.json, { role: 'analyst', permissions: ['marketplace.read'] });
    assert.equal((await t.call('/admin/marketplace/me', { as: 'not-an-admin-token-at-all-0123456789' })).status, 403);
    assert.deepEqual([...permissionsOf('support')], [], 'a role with no marketplace grant is told it has none');
    assert.equal((await t.call('/admin/marketplace/me', { as: 'root', method: 'POST', body: {} })).status, 404);
  });
  test('effective policy: org layer plus every team of the caller, merged by the shared evaluator (deny wins); never another user\'s teams', async () => {
    assert.equal((await t.call('/v1/marketplace/policy/effective')).status, 401);
    const noOrg = await t.call('/v1/marketplace/policy/effective', { user: 'u7' });
    assert.deepEqual({ org: noOrg.json.org, teams: noOrg.json.teams, layers: noOrg.json.layers }, { org: null, teams: [], layers: [] });
    // org policy by a superadmin only
    const orgDoc = { mode: 'open', minTrust: 'community', requireCleanScan: true, rules: [{ effect: 'deny', matchKind: 'publisher', matchValue: 'bad-actor' }] };
    const before = await rows();
    for (const as of ['eng', 'ana']) assert.equal((await t.call('/admin/marketplace/policies/org', { as, method: 'PUT', body: orgDoc })).status, 403, as);
    assert.equal((await t.call('/admin/marketplace/policies/org', { as: 'ana' })).status, 403, 'even reading the org policy document needs marketplace.policy');
    assert.deepEqual(await rows(), before, 'zero rows changed on 403');
    const put = await t.call('/admin/marketplace/policies/org', { as: 'root', method: 'PUT', body: orgDoc });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const audit = await one(`SELECT admin_user_id, action, detail FROM admin_audit WHERE action = 'marketplace.org_policy_set' ORDER BY id DESC LIMIT 1`);
    assert.equal(audit.admin_user_id, 'root'); assert.equal(audit.detail.rules, 1); assert.equal(audit.detail.before.rules, 0);
    assert.deepEqual((await t.call('/admin/marketplace/policies/org', { as: 'root' })).json.rules, orgDoc.rules);
    assert.equal((await t.call('/admin/marketplace/policies/org', { as: 'root', method: 'PUT', raw: 'null' })).status, 400);
    assert.equal((await t.call('/admin/marketplace/policies/org', { as: 'root', method: 'PUT', body: { mode: 'open', scopeId: 'x' } })).status, 400);
    const u2 = (await t.call('/v1/marketplace/policy/effective', { user: 'u2' })).json;   // u2: org + team One (admin) + team Two (member)
    assert.deepEqual(u2.layers.map((l: any) => `${l.scopeKind}:${l.scopeId}`), ['org:default', `team:${T1}`]);
    assert.equal(u2.org.mode, 'open'); assert.equal(u2.teams.length, 1);
    assert.ok(u2.rules.some((r: any) => r.scopeKind === 'org' && r.matchValue === 'bad-actor'));
    const subject = { listingId: 'acme/hook-x', publisherId: 'acme', type: 'hook', trust: 'community' as const, scanVerdict: 'clean' as const };
    assert.equal(evaluate({ layers: u2.layers }, subject).allowed, false, 'the team One policy denies hooks');
    assert.equal(evaluate({ layers: u2.layers }, { ...subject, type: 'skill', listingId: 'acme/ok' }).allowed, true);
    assert.equal(evaluate({ layers: u2.layers }, { ...subject, type: 'skill', publisherId: 'bad-actor', listingId: 'bad-actor/x' }).allowed, false);
    const u5 = (await t.call('/v1/marketplace/policy/effective', { user: 'u5' })).json;
    assert.deepEqual(u5.layers.map((l: any) => l.scopeId), ['default'], 'u5 is in team Two only, which has no policy');
  });
  test('an installed item that a policy now forbids is reported with reason policy (the caller can be told, not silently kept)', async () => {
    const s = await sync('u2', 'd2');
    // org policy: min trust community + clean scan; the seeded skills are community/clean so nothing is flagged yet
    assert.equal(s.json.updates.find((u: any) => u.reason === 'policy'), undefined);
    await t.admin.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value) VALUES ('pr_x','org','default','deny','type','agent')`);
    const s2 = await sync('u2', 'd2');
    const flagged = s2.json.updates.filter((u: any) => u.reason === 'policy');
    assert.ok(flagged.length >= 1); assert.match(flagged[0].detail, /denied by the organization policy/);
    await t.admin.query(`DELETE FROM marketplace_policy_rules WHERE id = 'pr_x'`);
  });
  test('database level: ao_app can never write the org policy, whatever the API does; team writes need owner/admin', async () => {
    await assert.rejects(() => t.h.asUser('u1', () => t.h.app.query(`INSERT INTO marketplace_policies(scope_kind, scope_id, mode) VALUES ('org','default','open') ON CONFLICT DO NOTHING`)), /row-level security|permission denied/);
    assert.equal(await t.h.asUser('u2', async () => (await t.h.app.query(`UPDATE marketplace_policies SET mode = 'allowlist' WHERE scope_kind = 'org'`)).rowCount), 0, 'the org row is read-only to ao_app');
    assert.equal(await t.h.asUser('u2', async () => (await t.h.app.query(`DELETE FROM marketplace_policies WHERE scope_kind = 'org'`)).rowCount), 0);
    await assert.rejects(() => t.h.asUser('u2', () => t.h.app.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value, created_by) VALUES ('pr_evil','org','default','allow','type','hook','u2')`)), /row-level security|permission denied/);
    await assert.rejects(() => t.h.asUser('u4', () => t.h.app.query(`INSERT INTO marketplace_team_assignments(id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode, assigned_by) VALUES ('asg_x',$1,'acme/s',$2,'1.0.0',$3,'required','u4')`, [T1, pub.versionId, pub.sha256])), /row-level security/);
  });

  // ── team audit and the new functions
  test('the team audit trail is append-only, readable by owner/admin only, writable only as yourself', async () => {
    const app = t.h.app;
    const as = async (uid: string, fn: () => Promise<unknown>) => { await app.query('BEGIN'); await app.query(`SELECT set_config('app.user_id',$1,true)`, [uid]); try { return await fn(); } finally { await app.query('ROLLBACK'); } };
    assert.ok(((await as('u2', () => app.query(`SELECT 1 FROM marketplace_team_audit WHERE team_id = $1`, [T1]))) as any).rowCount > 0);
    assert.equal(((await as('u5', () => app.query(`SELECT 1 FROM marketplace_team_audit WHERE team_id = $1`, [T1]))) as any).rowCount, 0, 'an outsider reads nothing');
    assert.equal(((await as('u4', () => app.query(`SELECT 1 FROM marketplace_team_audit WHERE team_id = $1`, [T1]))) as any).rowCount, 0, 'another team\'s owner reads nothing');
    await assert.rejects(() => as('u2', () => app.query(`INSERT INTO marketplace_team_audit(team_id, actor, action) VALUES ($1,'u1','assign')`, [T1])), /row-level security/);
    await assert.rejects(() => as('u5', () => app.query(`INSERT INTO marketplace_team_audit(team_id, actor, action) VALUES ($1,'u5','assign')`, [T1])), /row-level security/);
    await assert.rejects(() => as('u2', () => app.query(`UPDATE marketplace_team_audit SET action = 'unassign'`)), /permission denied|append/);
    await assert.rejects(() => as('u2', () => app.query(`DELETE FROM marketplace_team_audit`)), /permission denied|append/);
    await assert.rejects(() => t.h.owner.query(`UPDATE marketplace_team_audit SET actor = 'x'`), /append/);
    await assert.rejects(() => t.h.owner.query(`DELETE FROM marketplace_team_audit`), /append/);
  });
  test('the new SECURITY DEFINER functions pin search_path and are not executable by PUBLIC', async () => {
    const f = (await t.admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('ao_readonly', p.oid, 'EXECUTE') AS ro
        FROM pg_proc p WHERE p.proname IN ('marketplace_dependency_status','marketplace_elevated_review_guard')`)).rows;
    assert.equal(f.length, 2);
    for (const r of f) { assert.equal(r.pub, false, r.proname); assert.equal(r.ro, false, r.proname); }
    const dep = f.find((r) => r.proname === 'marketplace_dependency_status');
    assert.equal(dep.prosecdef, true); assert.ok(dep.proconfig.some((c: string) => c.startsWith('search_path=pg_catalog')));
    assert.equal((await one(`SELECT has_function_privilege('ao_app', 'marketplace_dependency_status(text[])', 'EXECUTE') AS ok`)).ok, true);
  });

  // ── admin API deltas
  test('admin: team assignments are listed for marketplace.read, filtered, with blocked flags; reads are audited', async () => {
    const r = await t.call(`/admin/marketplace/team-assignments?team=${T1}`, { as: 'ana' });
    assert.equal(r.status, 200);
    const s = r.json.items.find((i: any) => i.listingId === 'acme/s');
    assert.equal(s.blocked, true); assert.equal(s.versionState, 'revoked');
    assert.equal((await t.call(`/admin/marketplace/team-assignments?team=${T2}`, { as: 'ana' })).json.items.length, 0);
    assert.equal((await t.call(`/admin/marketplace/team-assignments?listing=bad..id`, { as: 'ana' })).status, 400);
    assert.equal((await t.call(`/admin/marketplace/team-assignments`, { origin: t.adminApi })).status, 401);
    assert.ok(await count(`SELECT count(*) n FROM admin_audit WHERE action = 'marketplace.list_team_assignments' AND admin_user_id = 'ana'`) >= 2);
  });

  // ── install-time re-resolution
  test('resolve: refs are re-resolved as the caller; hidden and missing are the same answer; bad shapes are 400', async () => {
    const r = await t.call('/v1/marketplace/resolve', { user: 'u2', body: { refs: [{ id: 'acme/team-skill', range: '^1.0.0' }, { id: 'acme/private-skill', range: '^1.0.0' }, { id: 'acme/ghost', range: '^1.0.0' }, { id: 'acme/s', range: '^1.0.0' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [a, b, c, d] = r.json.items;
    assert.equal(a.ok, true); assert.equal(a.sha256, tskill.sha256); assert.equal(a.visibility, 'team');
    assert.deepEqual([b.ok, b.error], [false, 'not_found']); assert.deepEqual([c.ok, c.error], [false, 'not_found']);
    assert.equal(d.ok, true); assert.equal(d.version, '1.0.0', '1.1.0 was revoked (invisible to ao_app): the range resolves to the remaining published version');
    const live = await t.call('/v1/marketplace/resolve', { user: 'u1', body: { refs: [{ id: 'acme/private-skill', range: '*' }] } });
    assert.equal(live.json.items[0].ok, true, 'the owner resolves their own private listing');
    for (const body of [{}, { refs: 'x' }, { refs: [{ id: 'x' }] }, { refs: [{ id: 'acme/s', range: 'nope nope' }] }, { refs: [], agentVersionId: 'v' }, { refs: Array.from({ length: 65 }, () => ({ id: 'acme/s', range: '*' })) }, { refs: [], extra: 1 }, { agentVersionId: '../x' }])
      assert.equal((await t.call('/v1/marketplace/resolve', { user: 'u2', body })).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await t.call('/v1/marketplace/resolve', { body: { refs: [] } })).status, 401);
    assert.equal((await t.call('/v1/marketplace/resolve', { user: 'u2', body: { refs: [{ id: 'acme/s', range: '*' }], forTeam: T2.replace('2', '9') } })).status, 404);
    assert.equal((await t.call('/v1/marketplace/resolve', { user: 'u7', body: { refs: [{ id: 'acme/team-skill', range: '*' }], forTeam: T1 } })).status, 404, 'a non-member cannot even name the team as an audience');
  });
  test('resolve by agent version: the whole reference set of a stored blueprint, transitively, as the caller', async () => {
    const skill = await t.seedSkill('acme/ref-skill', { version: '1.0.0' });
    const created = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(agentPkg({ id: 'u-u1/res-agent', bp: baseBp({ skillReferences: [{ id: 'acme/ref-skill', range: '^1.0.0', required: true }] }) })) });
    assert.equal(created.json.state, 'published', JSON.stringify(created.json.validation.checks.filter((c: any) => !c.ok)));
    const r = await t.call('/v1/marketplace/resolve', { user: 'u1', body: { agentVersionId: created.json.versionId } });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.ok, true); assert.equal(r.json.skills[0].sha256, skill.sha256);
    assert.equal(JSON.stringify(r.json).includes('blueprint'), false, 'the stored blueprint is not echoed');
    // someone who cannot see the agent: the same 404 as a version that does not exist
    const hidden = await t.call('/v1/marketplace/resolve', { user: 'u2', body: { agentVersionId: created.json.versionId } });
    const missing = await t.call('/v1/marketplace/resolve', { user: 'u2', body: { agentVersionId: 'v_does_not_exist' } });
    assert.equal(hidden.status, 404); assert.deepEqual(hidden.json, missing.json);
    // the skill is withdrawn after publish: re-resolution reports it
    await t.admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [skill.versionId]);
    const after = await t.call('/v1/marketplace/resolve', { user: 'u1', body: { agentVersionId: created.json.versionId } });
    assert.equal(after.json.ok, false); assert.ok(after.json.findings.length > 0);
  });

  // ── bundle plan
  test('bundle plan: members resolved as the caller, in dependency order, with the caller\'s policy; a stranger gets the uniform 404', async () => {
    const s = (await one(`SELECT version, sha256 FROM marketplace_versions WHERE listing_id = 'acme/team-skill'`));
    const bundle = { schema: 'agentic.bundle/1', items: [{ id: 'acme/team-skill', type: 'skill', version: s.version, sha256: s.sha256 }], installOrder: ['acme/team-skill'], teamScope: { kind: 'team', teamId: T1 } };
    const c = await t.call(`/v1/marketplace/listings?visibility=team&team=${T1}`, { user: 'u1', zip: zipOf(pkgOf(bundle, { id: 'u-u1/team-pack' })) });
    assert.equal(c.json.state, 'published', JSON.stringify(c.json.validation?.checks?.filter((x: any) => !x.ok) ?? c.json));
    const plan = await t.call(`/v1/marketplace/versions/${c.json.versionId}/plan?device=d2`, { user: 'u2' });
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.equal(plan.json.bundleId, 'u-u1/team-pack');
    assert.deepEqual(plan.json.plan.steps.map((x: any) => `${x.id}:${x.action}`), ['acme/team-skill:install']);
    assert.equal(plan.json.plan.installable, true);
    // team One's own policy (installed above) denies hooks only; add a rule that denies this member and the plan reports it per member
    await t.call(`/v1/marketplace/teams/${T1}/policy`, { user: 'u2', method: 'PUT', body: { mode: 'open', rules: [{ effect: 'deny', matchKind: 'listing', matchValue: 'acme/team-skill' }] } });
    const denied = await t.call(`/v1/marketplace/versions/${c.json.versionId}/plan`, { user: 'u2' });
    assert.equal(denied.json.plan.installable, false); assert.match(denied.json.plan.policy.denied[0].reason, /denied by the team policy/);
    for (const bad of ['u5', 'u7']) assert.equal((await t.call(`/v1/marketplace/versions/${c.json.versionId}/plan`, { user: bad })).status, 404, bad);
    assert.equal((await t.call(`/v1/marketplace/versions/v_nope/plan`, { user: 'u7' })).status, 404);
    assert.equal((await t.call(`/v1/marketplace/versions/${c.json.versionId}/plan?device=../x`, { user: 'u2' })).status, 400);
    assert.equal((await t.call(`/v1/marketplace/versions/${c.json.versionId}/plan`)).status, 401);
  });
  test('not a bundle: the plan route answers 404 for a skill version', async () => {
    assert.equal((await t.call(`/v1/marketplace/versions/${pub.versionId}/plan`, { user: 'u2' })).status, 404);
  });

  // ── limits
  test('rate limits: a flood of mutations from one user is answered 429 with Retry-After, and nothing else is changed', async () => {
    const { createLimiter } = await import('../src/marketplace/ratelimit.ts');
    const { marketplaceTeamsHandler } = await import('../src/api/marketplace-teams.ts');
    const { createServer } = await import('node:http');
    const handler = marketplaceTeamsHandler({ app: t.appPool, authenticate: async () => ({ uid: 'u2' }), store: t.store, limiter: createLimiter({ limit: 3 }) });
    const srv = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(srv.address() as any).port}`;
    const before = await rows();
    const codes: number[] = [];
    let retry = '';
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${origin}/v1/marketplace/teams/${T1}/assignments`, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: JSON.stringify({ listingId: 'acme/ghost', versionId: 'v_nope' }) });
      codes.push(r.status); if (r.status === 429) retry = r.headers.get('retry-after') ?? '';
    }
    srv.close();
    assert.deepEqual(codes.slice(0, 3), [422, 422, 422]); assert.deepEqual(codes.slice(3), [429, 429, 429]); assert.ok(Number(retry) >= 1);
    assert.deepEqual(await rows(), before);
  });
});
