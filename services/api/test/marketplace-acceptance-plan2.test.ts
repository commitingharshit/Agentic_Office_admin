// Plan 2 acceptance flows A1 to A8 (docs/superpowers/plans/2026-10-21-marketplace-plan2-agents-bundles.md, Task 15), driven at the API
// level on a REAL Postgres (embedded, real ao_app / ao_admin roles, RLS on) with the REAL Python compiler bridge and the REAL persona
// scanner (Hermes Skills Guard). Skipped, with a reason, when there is no vendored Hermes virtualenv: nothing here passes on a fake.
// The desktop halves (bundle atomicity on the lockfile, the policy gate, the real `hermes` install) are the desktop unit and integration
// files named in docs/audits/2026-10-21-marketplace-plan2-acceptance.md; this file is the server side of each flow.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentBridge } from '../src/marketplace/agents.ts';
import { evaluate } from '../src/marketplace/policy.ts';
import { createSkillsGuardScanner, findRepoRoot } from '../src/marketplace/validate/skillsGuard.ts';
import { skip as pgSkip } from './helpers/marketplace-pg.ts';
import { agentPkg, startHarness, zipOf, type Harness } from './helpers/agents-harness.ts';
import { pkgOf } from './helpers/bundle-fixtures.ts';
import { baseBp } from './marketplace-agent-helpers.ts';

const venv = process.env.HERMES_PYTHON ?? '/Users/harshitverma/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python';
const realOk = (() => { try { findRepoRoot(); return existsSync(venv); } catch { return false; } })();
const skip = pgSkip || (realOk ? false : 'no python venv with the vendored Hermes (the flows need the real compiler)');
const here = dirname(fileURLToPath(import.meta.url));
const TEAM = 'team_' + 'a'.repeat(18);
const READ = { capability: 'fs.workspace.read' as const, scope: 'docs/filings.md', reason: 'reads the filings' };
const TOOLS = { capability: 'tool.invoke' as const, scope: 'file_read', reason: 'uses the read-only file toolset' };

describe('Plan 2 acceptance A1-A8 (real Postgres, real compiler bridge, real persona scanner)', { skip }, () => {
  let t: Harness, freshAgents = -1, freshBundles = -1;
  const one = async (sql: string, args: unknown[] = []) => (await t.admin.query(sql, args)).rows[0];
  const check = (r: any, n: string) => r.json.validation.checks.find((c: any) => c.name === n);
  const create = (user: string, pkg: any, q = 'visibility=private') => t.call(`/v1/marketplace/listings?${q}`, { user, zip: zipOf(pkg) });
  const digestBp = () => baseBp({
    skillReferences: [{ id: 'acme/s', range: '^1.0.0', required: true }],
    toolPermissions: { mode: 'ask', toolsets: ['file_read'], kits: [], deny: [] },
    schedulingPolicy: { triggers: [{ kind: 'manual' }, { kind: 'schedule', schedule: '0 9 * * 1', prompt: 'Send the weekly digest' }] },
  });
  let good: any, skillV: { versionId: string; sha256: string };

  before(async () => {
    t = await startHarness({ bridgeFor: (store) => createAgentBridge({ python: venv, store }), scanner: createSkillsGuardScanner({ python: venv }), users: 6 });
    // A8 (first half): before anything is seeded or published, a fresh database has no agent or bundle listing
    freshAgents = Number((await one(`SELECT count(*) n FROM marketplace_listings WHERE type = 'agent'`)).n);
    freshBundles = Number((await one(`SELECT count(*) n FROM marketplace_listings WHERE type = 'bundle'`)).n);
    skillV = await t.seedSkill('acme/s', { version: '1.2.0' });
    await t.h.owner.query(`INSERT INTO devices(id, user_id) VALUES ('d1','u1'),('d2','u2')`);
  });
  after(async () => { await t?.stop(); });

  test('the compiler self-check passed on the real bridge and scanner, so agent and bundle are reported supported', async () => {
    assert.equal(t.runtime.ok(), true, t.runtime.detail());
  });

  test('A1: an agent is published from creator input, verified by the real compiler and dry run, and says what is not available yet', async () => {
    good = await create('u1', agentPkg({ id: 'u-u1/digest', bp: digestBp(), permissions: [READ, TOOLS] }));
    assert.equal(good.status, 201, JSON.stringify(good.json));
    assert.equal(good.json.state, 'published', JSON.stringify(good.json.validation.checks.filter((c: any) => !c.ok || c.skipped))); assert.equal(good.json.installable, true); assert.equal(good.json.validation.verified, true);
    for (const n of ['compiles', 'dry-run', 'persona-scan', 'permissions-subset', 'refs-resolve']) assert.equal(check(good, n).ok && !check(good, n).skipped, true, n);
    assert.match(check(good, 'permissions-subset').detail, /^derived: .*; declared: fs\.workspace\.read, tool\.invoke$/);
    assert.match(check(good, 'unsupported-reported').detail, /schedulingPolicy/, 'the weekly digest schedule is reported, not dropped');
    const row = await one(`SELECT visibility FROM marketplace_listings WHERE id = 'u-u1/digest'`);
    assert.equal(row.visibility, 'private');
    assert.equal((await t.call('/v1/marketplace/listings?type=agent', { user: 'u2' })).json.items.some((i: any) => i.id === 'u-u1/digest'), false, 'private to its owner');
  });

  test('A2: an agent that uses a tool it does not declare is rejected with permissions-subset and is never listed or installable', async () => {
    const r = await create('u1', agentPkg({ id: 'u-u1/sneaky', bp: baseBp({ toolPermissions: { mode: 'ask', toolsets: ['terminal'], kits: [], deny: [] } }), permissions: [] }));
    assert.equal(r.status, 201);
    assert.equal(r.json.state, 'rejected'); assert.equal(r.json.installable, false);
    assert.equal(check(r, 'permissions-subset').ok, false);
    assert.equal((await t.call(`/v1/marketplace/versions/${r.json.versionId}/artifact`, { user: 'u1' })).status, 409, 'not installable');
    assert.equal((await t.call('/v1/marketplace/listings?type=agent', { user: 'u1' })).json.items.filter((i: any) => i.id === 'u-u1/sneaky').every((i: any) => !i.latestVersionId), true);
    const adminView = await t.call('/admin/marketplace/versions/' + r.json.versionId, { as: 'ana' });
    assert.equal(adminView.status, 200);
  });

  test('A3: when the skill an installed agent depends on is revoked, the next sync reports dependency_revoked for the agent (memories are a desktop matter and untouched); revocation is terminal', async () => {
    const doomed = await t.seedSkill('acme/doomed', { version: '1.0.0' });
    const frag = await create('u1', agentPkg({ id: 'u-u1/fragile', bp: baseBp({ skillReferences: [{ id: 'acme/doomed', range: '^1.0.0', required: true }] }), permissions: [] }));
    assert.equal(frag.json.state, 'published', JSON.stringify(frag.json.validation?.checks?.filter((c: any) => !c.ok)));
    await t.admin.query(`INSERT INTO marketplace_installs(id, user_id, device_id, listing_id, version_id, state, enabled) VALUES ('i_a3','u1','d1','u-u1/fragile',$1,'enabled',true)`, [frag.json.versionId]);
    const sync = async () => (await t.call('/v1/marketplace/installs/sync', { user: 'u1', body: { deviceId: 'd1', items: [] } })).json.updates.find((u: any) => u.listingId === 'u-u1/fragile');
    assert.equal(await sync(), undefined);
    await t.admin.query(`UPDATE marketplace_versions SET state = 'revoked' WHERE id = $1`, [doomed.versionId]);
    await t.admin.query(`INSERT INTO marketplace_release_events(listing_id, version_id, event, actor, detail) VALUES ('acme/doomed',$1,'revoked','root','{"reason":"malware"}')`, [doomed.versionId]);
    const up = await sync();
    assert.equal(up.reason, 'dependency_revoked'); assert.equal(up.revoked, true); assert.match(up.detail, /acme\/doomed/);
    await assert.rejects(() => t.admin.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [doomed.versionId]), /terminal/, 'a revoked version can never be published again');
  });

  test('A4 (server half): a bundle whose member failed validation is not published; a bundle of verified members is, and carries every member pin. Atomic install and rollback are proven in bundleInstaller.test.ts and bundleHermes.integration.test.ts', async () => {
    const bad = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(agentPkg({ id: 'u-u1/sneaky2', bp: baseBp({ toolPermissions: { mode: 'ask', toolsets: ['terminal'], kits: [], deny: [] } }), permissions: [] })) });
    assert.equal(bad.json.state, 'rejected');
    const rej = await one(`SELECT sha256, version FROM marketplace_versions WHERE id = $1`, [bad.json.versionId]);
    const doc = (items: any[]) => ({ schema: 'agentic.bundle/1', items, installOrder: items.map((i) => i.id), teamScope: { kind: 'none' } });
    const withBad = await create('u1', pkgOf(doc([{ id: 'acme/s', type: 'skill', version: '1.2.0', sha256: skillV.sha256 }, { id: 'u-u1/sneaky2', type: 'agent', version: rej.version, sha256: rej.sha256 }]), { id: 'u-u1/kit-bad', permissions: [] }));
    assert.notEqual(withBad.json.state, 'published', 'a rejected member must not make a published bundle');
    assert.equal(withBad.json.installable, false);
    const goodRow = await one(`SELECT sha256 FROM marketplace_versions WHERE id = $1`, [good.json.versionId]);
    const fixed = await create('u1', pkgOf(doc([{ id: 'acme/s', type: 'skill', version: '1.2.0', sha256: skillV.sha256 }, { id: 'u-u1/digest', type: 'agent', version: '1.0.0', sha256: goodRow.sha256 }]), { id: 'u-u1/kit', permissions: [READ, TOOLS] }));
    assert.equal(fixed.json.state, 'published', JSON.stringify(fixed.json.validation?.checks?.filter((c: any) => !c.ok)));
    assert.equal(fixed.json.installable, true);
  });

  test('A5: a team admin pins a bundle at v1, the publisher releases v2, a member keeps seeing v1; re-pinning moves it; a member and an outsider cannot manage; RLS hides the rows', async () => {
    await t.admin.query(`INSERT INTO marketplace_teams(id, name, owner_user_id) VALUES ($1,'Deal team','u1')`, [TEAM]);
    await t.admin.query(`INSERT INTO marketplace_team_members(team_id, user_id, role) VALUES ($1,'u1','owner'),($1,'u2','member')`, [TEAM]);
    const items = [{ id: 'acme/s', type: 'skill', version: '1.2.0', sha256: skillV.sha256 }];
    const doc = { schema: 'agentic.bundle/1', items, installOrder: ['acme/s'], teamScope: { kind: 'team', teamId: TEAM } };
    const v1 = await create('u1', pkgOf(doc, { id: 'u-u1/toolkit' }), `visibility=team&team=${TEAM}`);
    assert.equal(v1.json.state, 'published', JSON.stringify(v1.json));
    const pkg2 = pkgOf(doc, { id: 'u-u1/toolkit' }); (pkg2.manifest as any).version = '2.0.0';
    const v2 = await t.call(`/v1/marketplace/listings/u-u1/toolkit/versions`, { user: 'u1', zip: zipOf(pkg2) });
    assert.equal(v2.status, 201, JSON.stringify(v2.json));
    const pin1 = await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u1', body: { listingId: 'u-u1/toolkit', versionId: v1.json.versionId, mode: 'required' } });
    assert.equal(pin1.status, 201, JSON.stringify(pin1.json));
    const asMember = (await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u2' })).json.items;
    assert.deepEqual(asMember.map((a: any) => [a.listingId, a.pinnedVersion, a.mode]), [['u-u1/toolkit', '1.0.0', 'required']], 'the member sees v1 even though v2 exists');
    const sync = (await t.call('/v1/marketplace/installs/sync', { user: 'u2', body: { deviceId: 'd2', items: [] } })).json;
    assert.ok(!(sync.updates ?? []).some((u: any) => u.listingId === 'u-u1/toolkit'), 'no update is offered to a member');
    assert.equal((await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u2', body: { listingId: 'u-u1/toolkit', versionId: v2.json.versionId } })).status, 403);
    assert.equal((await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u5' })).status, 404, 'an outsider learns nothing');
    const repin = await t.call(`/v1/marketplace/teams/${TEAM}/assignments`, { user: 'u1', body: { listingId: 'u-u1/toolkit', versionId: v2.json.versionId, mode: 'required' } });
    assert.equal(repin.json.pinnedVersion, '2.0.0');
    const c = t.h.app; await c.query('BEGIN'); await c.query(`SELECT set_config('app.user_id','u5',true)`);
    assert.equal((await c.query(`SELECT 1 FROM marketplace_team_assignments`)).rowCount, 0, 'RLS: an outsider sees no assignment rows');
    await c.query('ROLLBACK');
  });

  test('A6: an allowlist org policy denies a publisher that is not listed, with the rule\'s reason, and only marketplace.policy can write it', async () => {
    const doc = { mode: 'allowlist', minTrust: null, requireCleanScan: false, rules: [{ effect: 'allow', matchKind: 'publisher', matchValue: 'acme' }] };
    assert.equal((await t.call('/admin/marketplace/policies/org', { as: 'eng', method: 'PUT', body: doc })).status, 403);
    assert.equal((await t.call('/admin/marketplace/policies/org', { as: 'root', method: 'PUT', body: doc })).status, 200);
    const eff = (await t.call('/v1/marketplace/policy/effective', { user: 'u2' })).json;
    const agent = { listingId: 'u-u1/digest', publisherId: 'u-u1', type: 'agent', trust: 'community' as const, scanVerdict: 'clean' as const };
    const denied = evaluate({ layers: eff.layers }, agent);
    assert.equal(denied.allowed, false); assert.ok(denied.reason && denied.reason.length > 5);
    assert.equal(evaluate({ layers: eff.layers }, { ...agent, publisherId: 'acme', listingId: 'acme/s', type: 'skill' }).allowed, true);
    // the desktop enforcement (lockfile edits do not bypass; an unreachable policy pauses installs) is policyGate.test.ts and bundleInstaller.test.ts
    await t.call('/admin/marketplace/policies/org', { as: 'root', method: 'PUT', body: { mode: 'open', minTrust: null, requireCleanScan: false, rules: [] } });
  });

  test('A7: components that cannot run yet publish with a warning-grade report (never dropped); the fixtures that prove a read-only agent refuses a write tool run in marketplace-fixtures.test.ts', async () => {
    const hookBp = baseBp({ hookBindings: [{ event: 'pre_tool_call', hook: { id: 'acme/s', range: '^1.0.0' } }] });
    const r = await create('u1', agentPkg({ id: 'u-u1/hooked', bp: hookBp, permissions: [] }));
    assert.equal(r.status, 201);
    assert.match(check(r, 'unsupported-reported').detail, /hookBindings/, JSON.stringify(r.json.validation?.checks?.filter((c: any) => !c.ok)));
  });

  test('A8: a fresh database has no agent or bundle listing, and no production path references the fixtures', async () => {
    assert.deepEqual([freshAgents, freshBundles], [0, 0]);
    const srcDirs = [join(here, '..', 'src'), join(here, '..', 'scripts'), join(here, '..', '..', '..', 'database')];
    const hits: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js|mjs|sql|sh)$/.test(e) && /fixtures\/agents|fixture-pub|loadFixtureAgent/.test(readFileSync(p, 'utf8'))) hits.push(p); } };
    srcDirs.filter(existsSync).forEach(walk);
    assert.deepEqual(hits, [], 'production seed paths must not name the example agents');
  });
});
