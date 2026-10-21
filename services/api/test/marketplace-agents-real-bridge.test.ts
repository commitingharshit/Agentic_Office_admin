// The agent publish flow with the REAL Python compiler bridge and the REAL persona scanner (Hermes Skills Guard), on a real
// Postgres. Skipped when the vendored Hermes virtualenv is not present.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createAgentBridge } from '../src/marketplace/agents.ts';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { fakeCatalog, row } from './marketplace-agent-helpers.ts';
import { createSkillsGuardScanner, findRepoRoot } from '../src/marketplace/validate/skillsGuard.ts';
import { skip as pgSkip } from './helpers/marketplace-pg.ts';
import { agentPkg, startHarness, zipOf, type Harness } from './helpers/agents-harness.ts';
import { bundleOf, pkgOf } from './helpers/bundle-fixtures.ts';
import { baseBp } from './marketplace-agent-helpers.ts';

const venv = process.env.HERMES_PYTHON ?? '/Users/harshitverma/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python';
const realOk = (() => { try { findRepoRoot(); return existsSync(venv); } catch { return false; } })();
const skipReason = pgSkip || (realOk ? false : 'no python venv with the vendored Hermes');

describe('agent publish flow with the real compiler bridge', { skip: skipReason }, () => {
  let t: Harness;
  const bp = () => baseBp({
    skillReferences: [{ id: 'acme/s', range: '^1.0.0', required: true }],
    toolPermissions: { mode: 'ask', toolsets: ['file'], kits: [], deny: [] },
    modelPolicy: { primary: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
  });
  const PERMS = [{ capability: 'fs.workspace.read' as const, scope: 'docs/filings.md', reason: 'reads filings' }, { capability: 'fs.workspace.write' as const, scope: 'notes/summary.md', reason: 'writes notes' }, { capability: 'tool.invoke' as const, scope: 'file', reason: 'uses the file toolset' }];

  before(async () => {
    t = await startHarness({ bridgeFor: (store) => createAgentBridge({ python: venv, store }), scanner: createSkillsGuardScanner({ python: venv }) });
    await t.seedSkill('acme/s', { version: '1.2.0' });
  });
  after(async () => { await t?.stop(); });

  test('the startup self-check passes on the real bridge and scanner, and capabilities say so', async () => {
    assert.equal(t.runtime.ok(), true, t.runtime.detail());
    const caps = (await t.call('/v1/marketplace/capabilities')).json.types as any[];
    assert.equal(caps.find((x) => x.type === 'agent').supported, true);
  });

  test('admin flow: submit -> real compile + dry run -> approve (another admin) -> publish -> public search with permissions', async () => {
    const pkg = agentPkg({ id: 'pubco/legal-research', bp: bp(), permissions: PERMS });
    const r = await t.call('/admin/marketplace/submissions?visibility=public', { as: 'root', zip: zipOf(pkg) });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const failed = r.json.validation.checks.filter((c: any) => !c.ok || (c.skipped && c.required));
    assert.deepEqual(failed, [], JSON.stringify(failed));
    assert.equal(r.json.validation.verified, true);
    for (const n of ['compiles', 'dry-run', 'persona-scan']) assert.equal(r.json.validation.checks.find((c: any) => c.name === n).ok, true, n);
    // the reviewer sees the real compile and dry-run results
    const q = await t.call('/admin/marketplace/submissions', { as: 'eng' });
    const it = q.json.items.find((i: any) => i.versionId === r.json.versionId);
    assert.equal(it.review.compile.ok, true); assert.equal(it.review.dryRun.ok, true); assert.deepEqual(it.review.permissions.map((p: any) => p.capability).sort(), ['fs.workspace.read', 'fs.workspace.write', 'tool.invoke']);
    assert.equal((await t.call(`/admin/marketplace/versions/${r.json.versionId}/approve`, { as: 'eng', method: 'POST', body: {} })).status, 200);
    assert.equal((await t.call(`/admin/marketplace/versions/${r.json.versionId}/publish`, { as: 'eng2', method: 'POST', body: { visibility: 'public' } })).status, 200);
    const hit = (await t.call('/v1/marketplace/listings?type=agent')).json.items.find((i: any) => i.id === 'pubco/legal-research');
    assert.ok(hit); assert.ok(hit.capabilities.includes('fs.workspace.read'), JSON.stringify(hit.capabilities));
  });

  test('creator flow: a private agent with an invalid toolset is rejected by the real compiler; a valid one is published and can be bundled', async () => {
    const bad = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(agentPkg({ id: 'u-u1/bad-toolset', bp: baseBp({ toolPermissions: { mode: 'ask', toolsets: ['no_such_toolset'], kits: [], deny: [] } }) })) });
    assert.equal(bad.status, 201); assert.equal(bad.json.state, 'rejected');
    assert.equal(bad.json.validation.checks.find((c: any) => c.name === 'compiles').ok, false);
    const good = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(agentPkg({ id: 'u-u1/ok-agent', bp: bp(), permissions: PERMS })) });
    assert.equal(good.json.state, 'published', JSON.stringify(good.json.validation.checks.filter((c: any) => !c.ok || c.skipped)));
    const skill = (await t.admin.query(`SELECT version, sha256 FROM marketplace_versions WHERE listing_id = 'acme/s'`)).rows[0];
    const agent = (await t.admin.query(`SELECT version, sha256 FROM marketplace_versions WHERE listing_id = 'u-u1/ok-agent'`)).rows[0];
    const b = bundleOf([]); b.items = [{ id: 'acme/s', type: 'skill', version: skill.version, sha256: skill.sha256 }, { id: 'u-u1/ok-agent', type: 'agent', version: agent.version, sha256: agent.sha256 }];
    b.installOrder = ['acme/s', 'u-u1/ok-agent'];
    const bundle = await t.call('/v1/marketplace/listings?visibility=private', { user: 'u1', zip: zipOf(pkgOf(b, { id: 'u-u1/legal-pack', permissions: PERMS })) });
    assert.equal(bundle.json.state, 'published', JSON.stringify(bundle.json.validation.checks.filter((c: any) => !c.ok || c.skipped)));
  });

  test('fail closed: without the pinned skill trees the real dry run does not pass (it never passes without loading the skill)', async () => {
    const v = createAgentValidator({ catalog: fakeCatalog([row('acme/s', { skillName: 's' })]), bridge: createAgentBridge({ python: venv }), scanner: createSkillsGuardScanner({ python: venv }) });
    const cs = await v(agentPkg({ id: 'pubco/no-trees', bp: bp(), permissions: PERMS }));
    const dry = cs.find((c) => c.name === 'dry-run')!;
    assert.equal(dry.ok, false);
  });
});
