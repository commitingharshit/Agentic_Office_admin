import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBlueprint } from '../src/marketplace/blueprint/schema.ts';
import { resolveRefs, type ResolvedRefs } from '../src/marketplace/blueprint/resolve.ts';
import { checkDelegationGraph } from '../src/marketplace/blueprint/cycles.ts';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { agentPkg, baseBp, fakeBridge, fakeCatalog, get, row, safeScanner } from './marketplace-agent-helpers.ts';

const R = (graph: Record<string, string[]>): ResolvedRefs => ({ skills: [], children: [], agents: new Map(), graph: new Map(Object.entries(graph)), truncated: false });
const dp = (kids: string[], maxDepth = 5) => ({ delegationPolicy: { maxDepth, maxConcurrent: 1, children: kids.map(id => ({ id, range: '^1.0.0', role: 'r' })) } });
const agentRow = (id: string, kids: string[]) => row(id, { type: 'agent', blueprint: parseBlueprint(baseBp(dp(kids))) });

describe('checkDelegationGraph', () => {
  test('acyclic graph is fine', () => assert.deepEqual(checkDelegationGraph('a', R({ a: ['b', 'c'], b: ['c'], c: [] }), 5), []));
  test('self-reference at the root and below', () => {
    assert.equal(checkDelegationGraph('a', R({ a: ['a'] }), 5)[0].code, 'self_delegation');
    assert.ok(checkDelegationGraph('a', R({ a: ['b'], b: ['b'] }), 5).some(d => d.code === 'self_delegation'));
  });
  test('A -> B -> A and a longer cycle are named', () => {
    const d = checkDelegationGraph('a', R({ a: ['b'], b: ['a'] }), 5);
    assert.equal(d[0].code, 'delegation_cycle');
    assert.match(d[0].message, /a -> b -> a/);
    assert.equal(checkDelegationGraph('a', R({ a: ['b'], b: ['c'], c: ['d'], d: ['b'] }), 9)[0].code, 'delegation_cycle');
  });
  test('depth beyond maxDepth', () => assert.equal(checkDelegationGraph('a', R({ a: ['b'], b: ['c'], c: ['d'], d: [] }), 2)[0].code, 'too_deep'));
  test('a 5000-node chain does not blow the stack', () => {
    const g: Record<string, string[]> = {}; for (let i = 0; i < 5000; i++) g['n' + i] = ['n' + (i + 1)];
    assert.doesNotThrow(() => checkDelegationGraph('n0', R(g), 9));
  });
});

describe('validator: delegation-acyclic', () => {
  const v = (rows: any[]) => createAgentValidator({ catalog: fakeCatalog(rows), bridge: fakeBridge(), scanner: safeScanner });
  test('self-delegation fails deps-match-manifest and delegation-acyclic', async () => {
    const cs = await v([])(agentPkg({ bp: baseBp(dp(['acme/analyst'])) }));
    assert.equal(get(cs, 'delegation-acyclic').ok, false);
    assert.equal(get(cs, 'deps-match-manifest').ok, false);
  });
  test('A -> B -> A through the catalog is a cycle (and terminates)', async () => {
    const cs = await v([agentRow('acme/b', ['acme/analyst'])])(agentPkg({ bp: baseBp(dp(['acme/b'])) }));
    assert.equal(get(cs, 'delegation-acyclic').ok, false);
    assert.match(get(cs, 'delegation-acyclic').detail, /acme\/analyst -> acme\/b -> acme\/analyst/);
  });
  test('B -> C -> B (cycle not including the root) terminates and fails', async () => {
    const cs = await v([agentRow('acme/b', ['acme/c']), agentRow('acme/c', ['acme/b'])])(agentPkg({ bp: baseBp(dp(['acme/b'])) }));
    assert.equal(get(cs, 'delegation-acyclic').ok, false);
  });
  test('oversized delegation graph is refused, not walked forever', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => agentRow(`acme/n${i}`, i < 99 ? [`acme/n${i + 1}`] : []));
    const cs = await v(rows)(agentPkg({ bp: baseBp(dp(['acme/n0'])) }));
    assert.equal(get(cs, 'refs-resolve').ok, false);
    assert.equal(get(cs, 'delegation-acyclic').ok, false);
  });
});
void resolveRefs;
