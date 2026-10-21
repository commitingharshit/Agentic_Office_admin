import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBlueprint } from '../src/marketplace/blueprint/schema.ts';
import { checkEscalation, checkNoWildcards, deriveRequired, scopeCovers } from '../src/marketplace/blueprint/escalation.ts';
import type { ResolvedRefs } from '../src/marketplace/blueprint/resolve.ts';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { agentPkg, baseBp, fakeBridge, fakeCatalog, get, okReport, row, safeScanner } from './marketplace-agent-helpers.ts';

const P = (capability: any, scope = 'docs/**'): any => ({ capability, scope, reason: 'r' });
const R = (o: Partial<ResolvedRefs> = {}): ResolvedRefs => ({ skills: [], children: [], agents: new Map(), graph: new Map(), truncated: false, ...o });
const skillBp = baseBp({ skillReferences: [{ id: 'acme/s', range: '^1.0.0', required: true }] });

describe('checkEscalation', () => {
  test('E1: a required capability that the manifest does not declare', () => {
    const d = checkEscalation(parseBlueprint(baseBp()), [P('fs.workspace.read')], ['network'], R());
    assert.equal(d[0].code, 'undeclared_capability');
    assert.deepEqual(checkEscalation(parseBlueprint(baseBp()), [P('network', 'https://a.example')], ['network'], R()), []);
  });
  test('E2: a skill declaring exec.script under an agent declaring only fs.workspace.read names the skill', () => {
    const d = checkEscalation(parseBlueprint(skillBp), [P('fs.workspace.read')], [], R({ skills: [row('acme/s', { permissions: [P('exec.script', 'scripts/run.sh')] })] }));
    assert.equal(d.length, 1);
    assert.equal(d[0].code, 'skill_exceeds_agent');
    assert.match(d[0].message, /acme\/s/);
  });
  test('E2: scopes cannot be broader than the agent declares; prefix globs cover narrower scopes', () => {
    const wide = row('acme/s', { permissions: [P('fs.workspace.read', 'docs/**')] });
    assert.equal(checkEscalation(parseBlueprint(skillBp), [P('fs.workspace.read', 'docs/a.md')], [], R({ skills: [wide] })).length, 1);
    assert.equal(checkEscalation(parseBlueprint(skillBp), [P('fs.workspace.read', 'docs/**')], [], R({ skills: [row('acme/s', { permissions: [P('fs.workspace.read', 'docs/a.md')] })] })).length, 0);
    assert.equal(scopeCovers('docs/*', 'docs/a/b.md'), false);
    assert.equal(scopeCovers('docs/**', 'docs/../etc/passwd'), false);
    assert.equal(scopeCovers('*', 'anything'), false);
  });
  test('E3: a child with network under a parent without it; a child with extra toolsets; a grandchild over its parent', () => {
    const bp = parseBlueprint(baseBp({ toolPermissions: { mode: 'ask', toolsets: ['file'], kits: [], deny: [] }, delegationPolicy: { maxDepth: 3, maxConcurrent: 1, children: [{ id: 'acme/c', range: '^1.0.0', role: 'r' }] } }));
    const childBp = parseBlueprint(baseBp({ toolPermissions: { mode: 'ask', toolsets: ['file', 'web'], kits: [], deny: [] } }));
    const child = row('acme/c', { type: 'agent', permissions: [P('network', 'https://a.example')], blueprint: childBp });
    const d = checkEscalation(bp, [P('tool.invoke', 'x')], [], R({ children: [child], agents: new Map([['acme/c', child]]) }));
    assert.equal(d.filter(x => x.code === 'child_exceeds_parent').length, 2);
    assert.ok(d.some(x => /web/.test(x.message)));
    const gc = row('acme/g', { type: 'agent', permissions: [P('exec.script', 'a.sh')] });
    const mid = row('acme/c', { type: 'agent', permissions: [] });
    const d2 = checkEscalation(bp, [P('tool.invoke', 'x')], [], R({ children: [mid], agents: new Map([['acme/c', mid], ['acme/g', gc]]), graph: new Map([['acme/c', ['acme/g']]]) }));
    assert.ok(d2.some(x => /acme\/g/.test(x.message)));
  });
  test('deriveRequired mirrors the compiler for what is visible without Hermes', () => {
    const bp = parseBlueprint(baseBp({ contextScope: { workspaceAccess: 'write', pathGlobs: [], includeUserProfile: false }, knowledgeSources: [{ name: 'k', kind: 'url', ref: 'https://docs.example.com/' }] }));
    assert.deepEqual(deriveRequired(bp).sort(), ['fs.workspace.read', 'fs.workspace.write', 'network']);
  });
  test('wildcard toolsets/kits/deny and wildcard permission scopes', () => {
    const bp = parseBlueprint(baseBp({ toolPermissions: { mode: 'ask', toolsets: ['all'], kits: ['everything'], deny: [] } }));
    assert.equal(checkNoWildcards(bp, [P('fs.workspace.read', '*')]).length, 3);
    assert.equal(checkNoWildcards(parseBlueprint(baseBp()), [P('fs.workspace.read', '')]).length, 1);
    assert.equal(checkNoWildcards(parseBlueprint(baseBp()), [P('fs.workspace.read', 'docs/**')]).length, 0);
  });
});

describe('validator: escalation, wildcards and risk tier', () => {
  const run = (bp: any, rows: any[], permissions: any[], bridge = fakeBridge()) =>
    createAgentValidator({ catalog: fakeCatalog(rows), bridge, scanner: safeScanner })(agentPkg({ bp, permissions }));
  test('skill exec.script under a read-only agent fails permissions-subset', async () => {
    const cs = await run(skillBp, [row('acme/s', { permissions: [P('exec.script', 'scripts/run.sh')] })], [P('fs.workspace.read')]);
    assert.equal(get(cs, 'permissions-subset').ok, false);
    assert.match(get(cs, 'permissions-subset').detail, /acme\/s/);
  });
  test('a passing permissions-subset says what the compiler derived and what the manifest declared, so a reviewer can compare them', async () => {
    const bridge = fakeBridge({ check: { ok: true, findings: [], report: okReport(['network']), skills: [] } });
    const cs = await run(baseBp(), [], [P('network', 'https://a.example'), P('fs.workspace.read')], bridge);
    const c = get(cs, 'permissions-subset');
    assert.equal(c.ok, true);
    assert.equal(c.detail, 'derived: network; declared: fs.workspace.read, network');
    const none = get(await run(baseBp(), [], []), 'permissions-subset');
    assert.equal(none.detail, 'derived: none; declared: none');
  });
  test('the compiler-derived capabilities feed E1', async () => {
    const bridge = fakeBridge({ check: { ok: true, findings: [], report: okReport(['network']), skills: [] } });
    const cs = await run(baseBp(), [], [], bridge);
    assert.equal(get(cs, 'permissions-subset').ok, false);
  });
  test('wildcard toolset "all" fails no-wildcards; "*" fails the parse', async () => {
    const a = await run(baseBp({ toolPermissions: { mode: 'ask', toolsets: ['all'], kits: [], deny: [] } }), [], []);
    assert.equal(get(a, 'no-wildcards').ok, false);
    const b = await run(baseBp({ toolPermissions: { mode: 'ask', toolsets: ['*'], kits: [], deny: [] } }), [], []);
    assert.equal(get(b, 'blueprint-parse').ok, false);
  });
  test('risk tier: declarative by default, executable when any elevated capability is requested or required', async () => {
    const tier = (cs: any[]) => get(cs, 'risk-tier').detail;
    assert.equal(tier(await run(baseBp(), [], [P('fs.workspace.read')])), 'declarative');
    assert.equal(tier(await run(baseBp(), [], [P('network', 'https://a.example')])), 'executable');
    assert.equal(tier(await run(skillBp, [row('acme/s', { permissions: [P('exec.script', 'a.sh')] })], [P('exec.script', 'a.sh')])), 'executable');
    const req = fakeBridge({ check: { ok: true, findings: [], report: okReport(['secrets.use']), skills: [] } });
    assert.equal(tier(await run(baseBp(), [], [], req)), 'executable');
  });
});
