// Delegation graph checks: self-reference, cycles (A -> B -> A) and depth. Iterative (no recursion on hostile graphs).
import type { BlueprintDiagnostic } from './schema.ts';
import type { ResolvedRefs } from './resolve.ts';

export function checkDelegationGraph(rootId: string, resolved: ResolvedRefs, maxDepth: number): BlueprintDiagnostic[] {
  const out: BlueprintDiagnostic[] = [];
  const kids = (id: string) => resolved.graph.get(id) ?? [];
  if (kids(rootId).includes(rootId)) out.push({ path: 'delegationPolicy.children', code: 'self_delegation', message: `${rootId} delegates to itself` });
  // iterative DFS with colouring; reports the first cycle found and the deepest path
  const state = new Map<string, 1 | 2>();       // 1 = on stack, 2 = done
  let deepest = 0, cycle: string[] | null = null;
  const stack: Array<{ id: string; i: number; path: string[] }> = [{ id: rootId, i: 0, path: [rootId] }];
  state.set(rootId, 1);
  while (stack.length && !cycle) {
    const top = stack[stack.length - 1];
    const next = kids(top.id);
    if (top.i >= next.length) { state.set(top.id, 2); stack.pop(); continue; }
    const c = next[top.i++];
    if (c === top.id) continue;                 // self edge: reported above for the root, below for others
    const s = state.get(c);
    if (s === 1) { cycle = [...top.path.slice(top.path.indexOf(c)), c]; break; }
    if (s === 2) continue;
    state.set(c, 1);
    const path = [...top.path, c];
    deepest = Math.max(deepest, path.length - 1);
    stack.push({ id: c, i: 0, path });
  }
  if (cycle) out.push({ path: 'delegationPolicy.children', code: 'delegation_cycle', message: `delegation cycle: ${cycle.join(' -> ')}` });
  for (const [id, ks] of resolved.graph) if (id !== rootId && ks.includes(id)) out.push({ path: 'delegationPolicy.children', code: 'self_delegation', message: `${id} delegates to itself` });
  if (!cycle && deepest > maxDepth) out.push({ path: 'delegationPolicy.maxDepth', code: 'too_deep', message: `delegation reaches ${deepest} level(s), more than maxDepth ${maxDepth}` });
  if (resolved.truncated) out.push({ path: 'delegationPolicy.children', code: 'graph_too_large', message: 'delegation graph was too large to resolve completely' });
  return out;
}
