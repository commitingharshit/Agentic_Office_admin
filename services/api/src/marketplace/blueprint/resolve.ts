// Reference resolution for an agent blueprint. The CatalogView passed in MUST have been built from a caller-scoped
// (RLS) connection (never the admin pool); this module re-checks everything the view returns (id, type, version,
// state, scan verdict) instead of trusting it. Child agents are followed transitively with hard bounds.
import { satisfies } from '../manifest.ts';
import type { Visibility } from '../types.ts';
import type { AgentBlueprint, BlueprintDiagnostic, Ref } from './schema.ts';
import type { CatalogView, ResolvedRef } from './catalogView.ts';

export const RESOLVE_LIMITS = { maxNodes: 64, maxDepth: 6 } as const;

export interface ResolvedRefs {
  skills: ResolvedRef[];
  /** direct children of the root agent */
  children: ResolvedRef[];
  /** every agent reachable through delegation, root excluded, keyed by listing id */
  agents: Map<string, ResolvedRef>;
  /** delegation edges: agent id -> child ids (the root is keyed by `rootId`) */
  graph: Map<string, string[]>;
  truncated: boolean;
}
export interface ResolveCtx { visibility: Visibility; teamId: string | null; rootId?: string }

const MESSAGES: Record<string, string> = {
  not_found: 'no such listing', not_visible: 'the listing is not visible to the publisher',
  unsatisfiable: 'no published version satisfies the range', not_installable: 'the listing is revoked, quarantined or not published',
  type_mismatch: 'the listing is not of the expected type',
};
const INSTALLABLE = new Set(['published']);

function verify(ref: Ref, expected: ResolvedRef['type'], r: ResolvedRef, path: string): BlueprintDiagnostic | null {
  const d = (code: string, message: string): BlueprintDiagnostic => ({ path, code, message: `${ref.id}: ${message}` });
  if (!r || typeof r !== 'object') return d('bad_view', 'the catalog returned a malformed row');
  if (r.id !== ref.id) return d('id_mismatch', `the catalog answered with a different listing (${JSON.stringify(String(r.id).slice(0, 80))})`);
  if (r.type !== expected) return d('type_mismatch', `expected a ${expected}, found a ${String(r.type)}`);
  if (!satisfies(r.version, ref.range)) return d('unsatisfiable', `version ${String(r.version)} does not satisfy ${ref.range}`);
  if (!INSTALLABLE.has(r.state)) return d('not_installable', `version state is ${String(r.state)}`);
  if (r.scanVerdict !== 'clean' && r.scanVerdict !== 'warnings') return d('not_installable', 'the version has no clean scan verdict');
  return null;
}

export async function resolveRefs(view: CatalogView, bp: AgentBlueprint, ctx: ResolveCtx): Promise<{ resolved: ResolvedRefs; findings: BlueprintDiagnostic[] }> {
  const findings: BlueprintDiagnostic[] = [];
  const opts = { forVisibility: ctx.visibility, forTeamId: ctx.teamId };
  const out: ResolvedRefs = { skills: [], children: [], agents: new Map(), graph: new Map(), truncated: false };
  const rootId = ctx.rootId ?? '';
  const call = async (ref: Ref, type: ResolvedRef['type'], path: string): Promise<ResolvedRef | null> => {
    let r: ResolvedRef | { error: string };
    try { r = await view.resolve(ref, opts); }
    catch (e) { findings.push({ path, code: 'resolve_failed', message: `${ref.id}: catalog lookup failed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` }); return null; }
    if (r && typeof r === 'object' && 'error' in r) { findings.push({ path, code: String(r.error), message: `${ref.id}: ${MESSAGES[String(r.error)] ?? 'cannot be resolved'}` }); return null; }
    const bad = verify(ref, type, r as ResolvedRef, path);
    if (bad) { findings.push(bad); return null; }
    return r as ResolvedRef;
  };

  for (const [i, s] of (bp.skillReferences ?? []).entries()) {
    const r = await call({ id: s.id, range: s.range }, 'skill', `skillReferences[${i}]`);
    if (r) out.skills.push(r);
  }
  // breadth-first over delegation, with a visited set (cycle-safe) and hard node/depth caps
  type Item = { parent: string; ref: Ref; path: string; depth: number };
  const queue: Item[] = (bp.delegationPolicy?.children ?? []).map((c, i) => ({ parent: rootId, ref: { id: c.id, range: c.range }, path: `delegationPolicy.children[${i}]`, depth: 1 }));
  out.graph.set(rootId, queue.map(q => q.ref.id));
  while (queue.length) {
    const it = queue.shift()!;
    const known = out.agents.get(it.ref.id);
    if (known) continue;
    if (it.ref.id === rootId) continue;           // self-reference: an edge exists in the graph; do not resolve the root again
    if (it.depth > RESOLVE_LIMITS.maxDepth || out.agents.size >= RESOLVE_LIMITS.maxNodes) {
      out.truncated = true;
      findings.push({ path: it.path, code: 'graph_too_large', message: `delegation graph exceeds ${RESOLVE_LIMITS.maxNodes} agents or ${RESOLVE_LIMITS.maxDepth} levels` });
      break;
    }
    const r = await call(it.ref, 'agent', it.path);
    if (!r) continue;
    out.agents.set(r.id, r);
    const kids = r.blueprint?.delegationPolicy?.children ?? [];
    out.graph.set(r.id, kids.map(k => k.id));
    for (const [i, k] of kids.entries()) queue.push({ parent: r.id, ref: { id: k.id, range: k.range }, path: `${it.path}.children[${i}]`, depth: it.depth + 1 });
  }
  for (const c of bp.delegationPolicy?.children ?? []) { const a = out.agents.get(c.id); if (a) out.children.push(a); }
  return { resolved: out, findings };
}
