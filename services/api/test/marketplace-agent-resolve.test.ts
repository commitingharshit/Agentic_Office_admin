import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBlueprint } from '../src/marketplace/blueprint/schema.ts';
import { resolveRefs } from '../src/marketplace/blueprint/resolve.ts';
import { agentPkg, baseBp, fakeBridge, fakeCatalog, get, names, row, safeScanner } from './marketplace-agent-helpers.ts';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';

const withSkill = (id = 'acme/pdf-notes', range = '^1.0.0') => baseBp({ skillReferences: [{ id, range, required: true }] });
const ctx = { visibility: 'public' as const, teamId: null };

describe('resolveRefs', () => {
  test('resolves a satisfiable skill', async () => {
    const r = await resolveRefs(fakeCatalog([row('acme/pdf-notes')]), parseBlueprint(withSkill()), ctx);
    assert.deepEqual(r.findings, []);
    assert.equal(r.resolved.skills[0].id, 'acme/pdf-notes');
  });
  test('unsatisfiable range, missing listing and revoked/quarantined dependency are findings naming the ref', async () => {
    const view = fakeCatalog([row('acme/old', { version: '0.9.0' }), row('acme/gone', { state: 'revoked' }), row('acme/q', { state: 'quarantined' })]);
    for (const [id, code] of [['acme/old', 'unsatisfiable'], ['acme/nope', 'not_found'], ['acme/gone', 'not_installable'], ['acme/q', 'not_installable']] as const) {
      const r = await resolveRefs(view, parseBlueprint(withSkill(id)), ctx);
      assert.equal(r.findings[0]?.code, code, id);
      assert.match(r.findings[0].message, new RegExp(id));
    }
  });
  test('a view that answers with a different listing, a wrong type or an unsatisfying version is not trusted', async () => {
    const liar = { async resolve() { return row('acme/other'); } };
    assert.equal((await resolveRefs(liar, parseBlueprint(withSkill()), ctx)).findings[0].code, 'id_mismatch');
    assert.equal((await resolveRefs(fakeCatalog([row('acme/pdf-notes', { type: 'template' })]), parseBlueprint(withSkill()), ctx)).findings[0].code, 'type_mismatch');
    const wrongVersion = { async resolve(ref: any) { return row(ref.id, { version: '9.0.0' }); } };
    assert.equal((await resolveRefs(wrongVersion, parseBlueprint(withSkill()), ctx)).findings[0].code, 'unsatisfiable');
    const dirty = fakeCatalog([row('acme/pdf-notes', { scanVerdict: 'dangerous' as any })]);
    assert.equal((await resolveRefs(dirty, parseBlueprint(withSkill()), ctx)).findings[0].code, 'not_installable');
  });
  test('a view that throws is a finding, not a crash', async () => {
    const r = await resolveRefs({ async resolve() { throw new Error('db down'); } }, parseBlueprint(withSkill()), ctx);
    assert.equal(r.findings[0].code, 'resolve_failed');
  });
  test('RLS: a user who cannot see the dependency gets not_visible, and the view (not a pool) is the only data source', async () => {
    const rows = [row('acme/pdf-notes', { visibility: 'private' })];
    const view = fakeCatalog(rows, { userId: 'bob', hiddenFrom: { 'acme/pdf-notes': ['bob'] } });
    const r = await resolveRefs(view, parseBlueprint(withSkill()), ctx);
    assert.equal(r.findings[0].code, 'not_visible');
    const alice = await resolveRefs(fakeCatalog(rows, { userId: 'alice', hiddenFrom: { 'acme/pdf-notes': ['bob'] } }), parseBlueprint(withSkill()), ctx);
    assert.deepEqual(alice.findings, []);
  });
  test('child agents are followed transitively, once each, with a hard cap on oversized graphs', async () => {
    const child = (id: string, kids: string[]) => row(id, { type: 'agent', blueprint: parseBlueprint(baseBp({ delegationPolicy: { maxDepth: 5, maxConcurrent: 1, children: kids.map(k => ({ id: k, range: '^1.0.0', role: 'r' })) } })) });
    const rows = [child('acme/c1', ['acme/c2']), child('acme/c2', [])];
    const bp = parseBlueprint(baseBp({ delegationPolicy: { maxDepth: 5, maxConcurrent: 1, children: [{ id: 'acme/c1', range: '^1.0.0', role: 'r' }] } }));
    const r = await resolveRefs(fakeCatalog(rows), bp, { ...ctx, rootId: 'acme/analyst' });
    assert.deepEqual(r.findings, []);
    assert.deepEqual([...r.resolved.agents.keys()].sort(), ['acme/c1', 'acme/c2']);
    // a wide-and-deep chain over the cap
    const many = Array.from({ length: 80 }, (_, i) => child(`acme/n${i}`, i < 79 ? [`acme/n${i + 1}`] : []));
    const big = parseBlueprint(baseBp({ delegationPolicy: { maxDepth: 5, maxConcurrent: 1, children: [{ id: 'acme/n0', range: '^1.0.0', role: 'r' }] } }));
    const rr = await resolveRefs(fakeCatalog(many), big, { ...ctx, rootId: 'acme/analyst' });
    assert.ok(rr.findings.some(f => f.code === 'graph_too_large'));
    assert.ok(rr.resolved.agents.size <= 64);
  });
});

describe('validator: resolution checks', () => {
  const v = (view: any) => createAgentValidator({ catalog: view, bridge: fakeBridge(), scanner: safeScanner });
  test('good: refs-resolve passes and deps match', async () => {
    const cs = await v(fakeCatalog([row('acme/pdf-notes')]))(agentPkg({ bp: withSkill() }));
    assert.deepEqual(names(cs), [], JSON.stringify(cs.filter(c => !c.ok)));
  });
  test('deps-match-manifest: a blueprint skill missing from manifest.dependencies, and the reverse', async () => {
    const view = fakeCatalog([row('acme/pdf-notes'), row('acme/extra')]);
    const a = await v(view)(agentPkg({ bp: withSkill(), deps: [] }));
    assert.equal(get(a, 'deps-match-manifest').ok, false);
    assert.match(get(a, 'deps-match-manifest').detail, /acme\/pdf-notes/);
    const b = await v(view)(agentPkg({ bp: withSkill(), deps: [{ id: 'acme/pdf-notes', range: '^1.0.0' }, { id: 'acme/extra', range: '^1.0.0' }] }));
    assert.equal(get(b, 'deps-match-manifest').ok, false);
    assert.match(get(b, 'deps-match-manifest').detail, /acme\/extra/);
    const c = await v(view)(agentPkg({ bp: withSkill(), deps: [{ id: 'acme/pdf-notes', range: '^2.0.0' }] }));
    assert.equal(get(c, 'deps-match-manifest').ok, false);   // same id, different range
  });
  test('a public agent cannot depend on a private or team skill; another team is refused; own team is fine', async () => {
    const priv = await v(fakeCatalog([row('acme/pdf-notes', { visibility: 'private' })]))(agentPkg({ bp: withSkill() }));
    assert.equal(get(priv, 'visibility-no-escalation').ok, false);
    const team = await v(fakeCatalog([row('acme/pdf-notes', { visibility: 'team', teamId: 't1' })]))(agentPkg({ bp: withSkill() }));
    assert.equal(get(team, 'visibility-no-escalation').ok, false);
    const mk = (teamId: string, depTeam: string) => createAgentValidator({ catalog: fakeCatalog([row('acme/pdf-notes', { visibility: 'team', teamId: depTeam })]), bridge: fakeBridge(), scanner: safeScanner, context: { visibility: 'team', teamId } });
    assert.equal(get(await mk('t1', 't2')(agentPkg({ bp: withSkill() })), 'visibility-no-escalation').ok, false);
    assert.equal(get(await mk('t1', 't1')(agentPkg({ bp: withSkill() })), 'visibility-no-escalation').ok, true);
    const pub = createAgentValidator({ catalog: fakeCatalog([row('acme/pdf-notes', { visibility: 'private' })]), bridge: fakeBridge(), scanner: safeScanner, context: { visibility: 'private', teamId: null } });
    assert.equal(get(await pub(agentPkg({ bp: withSkill() })), 'visibility-no-escalation').ok, true);
  });
  test('confusable skill ids (cyrillic, fullwidth, case, trailing dot) never reach the catalog', async () => {
    for (const id of ['acme/pdf-nоtes', 'acme/pdf－notes', 'ACME/pdf-notes', 'acme/pdf-notes.', 'acme/pdf-notes​']) {
      const view = fakeCatalog([row('acme/pdf-notes')]);
      const cs = await v(view)(agentPkg({ bp: withSkill(id) }));
      assert.equal(get(cs, 'blueprint-parse').ok, false, id);
      assert.deepEqual(view.calls, [], id);
    }
  });
  test('no catalog with references: refs-resolve is skipped+required, never verified', async () => {
    const cs = await createAgentValidator({ bridge: fakeBridge(), scanner: safeScanner })(agentPkg({ bp: withSkill() }));
    assert.equal(get(cs, 'refs-resolve').skipped, true);
    assert.equal(get(cs, 'refs-resolve').required, true);
  });
});
