// The production CatalogView on REAL row-level security (embedded Postgres, ao_app with app.user_id set) and, for the admin
// submission path, in audience mode on the ao_admin pool.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { MANIFEST_NAME, putArtifact, sha256Hex } from '../src/marketplace/artifacts.ts';
import { audienceCatalog, withCallerCatalog } from '../src/marketplace/catalog.ts';
import { skip } from './helpers/marketplace-pg.ts';
import { agentPkg, startHarness, zipOf, type Harness } from './helpers/agents-harness.ts';
import { fakeBridge, baseBp } from './marketplace-agent-helpers.ts';

describe('catalog view (real RLS)', { skip }, () => {
  let t: Harness;
  const team = 'team_' + 'a'.repeat(18), otherTeam = 'team_' + 'b'.repeat(18);
  const as = (uid: string, fn: Parameters<typeof withCallerCatalog>[3]) => withCallerCatalog(t.appPool, uid, t.store, fn);
  const ref = (id: string, range = '^1.0.0') => ({ id, range });
  const aud = { forVisibility: 'private' as const, forTeamId: null };

  before(async () => {
    t = await startHarness({ bridge: fakeBridge() });
    await t.admin.query(`INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ($1,'A','u1'),($2,'B','u3')`, [team, otherTeam]);
    await t.admin.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,'u1','owner'),($1,'u2','member'),($2,'u3','owner')`, [team, otherTeam]);
    await t.seedSkill('acme/pub', { version: '1.0.0' });
    await t.seedSkill('acme/pub', { version: '1.4.0' });
    await t.seedSkill('acme/pub', { version: '2.0.0' });
    await t.seedSkill('acme/revoked', { version: '1.0.0', state: 'revoked' });
    await t.seedSkill('acme/teamonly', { visibility: 'team', team, owner: 'u1', permissions: [{ capability: 'network', scope: 'https://a.example', reason: 'r' }] });
    await t.seedSkill('acme/otherteam', { visibility: 'team', team: otherTeam, owner: 'u3' });
    await t.seedSkill('u1pub/mine', { visibility: 'private', owner: 'u1' });
    await t.seedSkill('acme/draft', { state: 'draft', visibility: 'public' });
    await t.admin.query(`INSERT INTO marketplace_dependencies(version_id, depends_on_listing, range) SELECT id, 'acme/pub', '^1.0.0' FROM marketplace_versions WHERE listing_id = 'acme/teamonly'`);
  });
  after(async () => { await t?.stop(); });

  test('picks the highest published version that satisfies the range and reports the facts the validators need', async () => {
    const r: any = await as('u5', (v) => v.resolve(ref('acme/pub'), aud));
    assert.equal(r.version, '1.4.0'); assert.equal(r.type, 'skill'); assert.equal(r.state, 'published'); assert.equal(r.visibility, 'public');
    assert.match(r.sha256, /^[0-9a-f]{64}$/); assert.equal(r.compatApp, '^1.0.0'); assert.equal(r.skillName, 'pub'); assert.equal(r.riskTier, 'declarative'); assert.equal(r.trust, 'community');
    assert.equal(((await as('u5', (v) => v.resolve(ref('acme/pub', '^2.0.0'), aud))) as any).version, '2.0.0');
  });
  test('unsatisfiable range, no published version and malformed ranges', async () => {
    assert.deepEqual(await as('u5', (v) => v.resolve(ref('acme/pub', '^9.0.0'), aud)), { error: 'unsatisfiable' });
    assert.deepEqual(await as('u5', (v) => v.resolve(ref('acme/pub', 'not a range'), aud)), { error: 'unsatisfiable' });
    assert.deepEqual(await as('u5', (v) => v.resolve(ref('acme/draft'), aud)), { error: 'not_installable' });   // a visible listing whose only version is a draft
  });
  test('a revoked version is invisible to ao_app: the listing resolves as not installable, never as the revoked version', async () => {
    assert.deepEqual(await as('u5', (v) => v.resolve(ref('acme/revoked'), aud)), { error: 'not_installable' });
  });
  test('a team listing resolves for its members only; a non-member gets the SAME answer as for a listing that does not exist', async () => {
    const mem: any = await as('u2', (v) => v.resolve(ref('acme/teamonly'), { forVisibility: 'team', forTeamId: team }));
    assert.equal(mem.visibility, 'team'); assert.equal(mem.teamId, team);
    assert.deepEqual(mem.permissions, [{ capability: 'network', scope: 'https://a.example', reason: 'r' }]);
    assert.deepEqual(mem.dependencies, [{ id: 'acme/pub', range: '^1.0.0' }]);
    const outsider = await as('u5', (v) => v.resolve(ref('acme/teamonly'), aud));
    const missing = await as('u5', (v) => v.resolve(ref('acme/does-not-exist'), aud));
    assert.deepEqual(outsider, { error: 'not_found' }); assert.deepEqual(outsider, missing);
    assert.deepEqual(await as('u2', (v) => v.resolve(ref('acme/otherteam'), aud)), { error: 'not_found' });   // another team's listing: also uniform
  });
  test('a private listing resolves for its owner only', async () => {
    assert.equal(((await as('u1', (v) => v.resolve(ref('u1pub/mine'), aud))) as any).visibility, 'private');
    assert.deepEqual(await as('u2', (v) => v.resolve(ref('u1pub/mine'), aud)), { error: 'not_found' });
  });
  test('an agent resolves with its parsed blueprint (children can be followed); an unreadable blueprint is not installable', async () => {
    const pkg = agentPkg({ id: 'acme/child', bp: baseBp({ toolPermissions: { mode: 'ask', toolsets: ['file'], kits: [], deny: [] } }) });
    const { sha256, size } = await putArtifact(t.store, zipOf(pkg));
    await t.admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,'k-agent') ON CONFLICT DO NOTHING`, [sha256, size]);
    await t.admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary) VALUES ('acme/child','agent','acme','u1','public','community','c','s')`);
    await t.admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ('v_child','acme/child','1.0.0',1,0,0,'published',$1,$2,$3,'clean')`, [JSON.stringify(pkg.manifest), sha256, size]);
    const r: any = await as('u5', (v) => v.resolve(ref('acme/child'), aud));
    assert.equal(r.type, 'agent'); assert.equal(r.blueprint.toolPermissions.toolsets[0], 'file');
    // a stored artifact whose bytes are not the pinned hash (or have no blueprint) must not be built on
    const junk = zipSync({ [MANIFEST_NAME]: strToU8('{}'), 'x.txt': strToU8('x') });
    const j = await putArtifact(t.store, junk);
    await t.admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,'k-junk') ON CONFLICT DO NOTHING`, [j.sha256, j.size]);
    await t.admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary) VALUES ('acme/broken','agent','acme','u1','public','community','b','s')`);
    await t.admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict) VALUES ('v_broken','acme/broken','1.0.0',1,0,0,'published','{}',$1,$2,'clean')`, [j.sha256, j.size]);
    assert.deepEqual(await as('u5', (v) => v.resolve(ref('acme/broken'), aud)), { error: 'not_installable' });
    assert.equal(sha256Hex(strToU8('x')).length, 64);
  });
  test('audience mode (admin path, no RLS): public and org listings and the audience team only; never private or another team', async () => {
    const v = audienceCatalog(t.adminPool, t.store);
    assert.equal(((await v.resolve(ref('acme/pub'), { forVisibility: 'public', forTeamId: null })) as any).version, '1.4.0');
    assert.deepEqual(await v.resolve(ref('u1pub/mine'), { forVisibility: 'public', forTeamId: null }), { error: 'not_found' });
    assert.deepEqual(await v.resolve(ref('acme/teamonly'), { forVisibility: 'public', forTeamId: null }), { error: 'not_found' });
    assert.deepEqual(await v.resolve(ref('acme/teamonly'), { forVisibility: 'team', forTeamId: otherTeam }), { error: 'not_found' });
    assert.equal(((await v.resolve(ref('acme/teamonly'), { forVisibility: 'team', forTeamId: team })) as any).teamId, team);
  });
});
