// Server-side install planning for a bundle. Pure over a CatalogView (always a caller-scoped connection), deterministic:
// the same inputs give the same bytes (steps in topological order with ties broken by id, permissions sorted).
import { compareSemver, isRange, satisfies } from '../manifest.ts';
import { evaluate, type EffectivePolicy, type PolicyDecision, type Trust } from '../policy.ts';
import { TYPE_POLICY, maxTier } from '../support.ts';
import type { ListingType, PermissionRequest, RiskTier, Visibility } from '../types.ts';
import type { CatalogView, ResolvedRef } from '../blueprint/catalogView.ts';
import { BUNDLE_LIMITS, type BundleV1 } from './schema.ts';

/** What the catalog may add beyond ResolvedRef (all optional: absence is handled fail-closed). */
export type MemberInfo = ResolvedRef & { compatApp?: string; riskTier?: RiskTier; trust?: Trust };
export type StepAction = 'install' | 'already_installed' | 'upgrade' | 'conflict';
export interface PlanStep {
  id: string; type: ListingType; version: string; versionId: string; sha256: string; action: StepAction; dependsOn: string[];
  riskTier: RiskTier; elevated: boolean; scanVerdict: 'clean' | 'warnings'; permissions: PermissionRequest[];
  /** present only when the caller supplied a policy */
  policy?: PolicyDecision;
}
export interface BundlePlan {
  steps: PlanStep[];
  permissions: PermissionRequest[];                 // union, deduped by capability+scope, sorted
  problems: string[];                               // anything here means the bundle cannot be installed as published
  warnings: string[];
  conflicts: string[];                              // subset of problems that are installed-state / pin conflicts
  riskTier: RiskTier;                               // max over members and the bundle floor
  elevated: boolean;                                // any member needs manual review: the bundle does too
  policy?: { allowed: string[]; denied: Array<{ id: string; reason: string }> };
  installable: boolean;                             // no problems and (when a policy was given) every member allowed
}
export interface PlanContext {
  visibility: Visibility; teamId: string | null;
  /** effective policy of the installing user/team (org layer + team layers); omitted = no policy evaluation */
  policy?: EffectivePolicy;
  /** trust of a listing; unknown is treated as the LOWEST trust (fail closed) */
  trustOf?: (id: string) => Trust | undefined;
}

export function topoOrder(graph: Map<string, string[]>): string[] | { cycle: string[] } {
  const ids = [...graph.keys()].sort();
  const state = new Map<string, 0 | 1 | 2>();           // 1 = on the stack, 2 = done
  const out: string[] = [];
  // iterative DFS, dependencies before dependents, neighbours visited in sorted order
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; deps: string[]; i: number }> = [{ id: root, deps: [...(graph.get(root) ?? [])].filter((d) => graph.has(d)).sort(), i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i < top.deps.length) {
        const d = top.deps[top.i++];
        const s = state.get(d);
        if (s === 1) { const path = stack.map((f) => f.id); return { cycle: [...path.slice(path.indexOf(d)), d] }; }
        if (!s) { state.set(d, 1); stack.push({ id: d, deps: [...(graph.get(d) ?? [])].filter((x) => graph.has(x)).sort(), i: 0 }); }
      } else { state.set(top.id, 2); out.push(top.id); stack.pop(); }
    }
  }
  return out;
}

const permKey = (p: PermissionRequest) => `${p.capability}\u0000${p.scope}`;
export function unionPermissions(lists: ReadonlyArray<readonly PermissionRequest[]>): PermissionRequest[] {
  const m = new Map<string, PermissionRequest>();
  for (const l of lists) for (const p of l) { const k = permKey(p); if (!m.has(k)) m.set(k, { capability: p.capability, scope: p.scope, reason: p.reason }); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, p]) => p);
}

/** A member's tier: its type floor, or higher when it declares a script or secret use, or the catalog says so. Unknown type = executable. */
export function memberTier(m: Pick<MemberInfo, 'type' | 'permissions' | 'riskTier'>): RiskTier {
  let t: RiskTier = TYPE_POLICY[m.type]?.riskTier ?? 'executable';
  if (m.riskTier) t = maxTier(t, m.riskTier);
  if (m.permissions.some((p) => p.capability === 'exec.script')) t = 'executable';
  return t;
}
export const memberElevated = (m: Pick<MemberInfo, 'type' | 'permissions' | 'riskTier'>): boolean =>
  memberTier(m) === 'executable' || (TYPE_POLICY[m.type]?.manualReview ?? true);

/** Evaluate every step against a policy. Any thrown error is a denial (fail closed). */
export function bundlePolicyVerdicts(steps: ReadonlyArray<Pick<PlanStep, 'id' | 'type' | 'scanVerdict'>>, policy: EffectivePolicy, trustOf?: PlanContext['trustOf']): Array<{ id: string } & PolicyDecision> {
  return steps.map((s) => {
    try {
      return { id: s.id, ...evaluate(policy, { listingId: s.id, publisherId: s.id.split('/')[0], type: s.type, trust: trustOf?.(s.id) ?? 'private', scanVerdict: s.scanVerdict }) };
    } catch (e) { return { id: s.id, allowed: false, reason: `policy could not be evaluated: ${(e as Error).message}` }; }
  });
}

export async function planBundle(view: CatalogView, b: BundleV1, installed: Map<string, { version: string; sha256: string }>, ctx: PlanContext): Promise<BundlePlan> {
  const problems: string[] = [], warnings: string[] = [], conflicts: string[] = [];
  const resolved = new Map<string, MemberInfo>();
  const items = [...b.items].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (items.length > BUNDLE_LIMITS.maxItems) problems.push(`more than ${BUNDLE_LIMITS.maxItems} items`);
  for (const it of items.slice(0, BUNDLE_LIMITS.maxItems)) {
    if (it.type === 'bundle') { problems.push(`${it.id}: a bundle cannot contain a bundle`); continue; }
    let r: Awaited<ReturnType<CatalogView['resolve']>>;
    try { r = await view.resolve({ id: it.id, range: `=${it.version}` }, { forVisibility: ctx.visibility, forTeamId: ctx.teamId }); }
    catch (e) { problems.push(`${it.id}: could not be resolved (${(e as Error).message})`); continue; }
    if ('error' in r) { problems.push(`${it.id}: ${r.error}`); continue; }
    const m = r as MemberInfo;
    if (m.version !== it.version) { problems.push(`${it.id}: resolved ${m.version}, not the pinned ${it.version}`); continue; }
    if (m.type !== it.type) { problems.push(`${it.id}: is a ${m.type}, the bundle says ${it.type}`); continue; }
    if (m.state !== 'published') { problems.push(`${it.id}@${it.version}: is ${m.state}, not published`); continue; }
    if (m.sha256 !== it.sha256) { const msg = `${it.id}@${it.version}: pinned sha256 does not match the published artifact`; problems.push(msg); conflicts.push(msg); continue; }
    resolved.set(it.id, m);
  }

  // dependency graph over members; a dependency outside the bundle (or at a version its range rejects) is a problem
  const graph = new Map<string, string[]>();
  let edges = 0;
  for (const [id, m] of resolved) {
    const deps = new Set<string>();
    for (const d of m.dependencies) {
      if (++edges > BUNDLE_LIMITS.maxClosure) { problems.push(`dependency closure larger than ${BUNDLE_LIMITS.maxClosure}`); break; }
      const target = resolved.get(d.id) ?? items.find((x) => x.id === d.id);
      const version = resolved.get(d.id)?.version ?? (target as { version?: string } | undefined)?.version;
      if (!target || version === undefined) { problems.push(`${id}: needs ${d.id} ${d.range}, which is not in the bundle`); continue; }
      if (!isRange(d.range) || !satisfies(version, d.range)) { problems.push(`${id}: needs ${d.id} ${d.range}, the bundle pins ${version}`); continue; }
      deps.add(d.id);
    }
    graph.set(id, [...deps].sort());
  }
  const order = topoOrder(graph);
  let ids: string[];
  if (Array.isArray(order)) ids = order;
  else { problems.push(`dependency cycle: ${order.cycle.join(' -> ')}`); ids = [...graph.keys()].sort(); }

  const steps: PlanStep[] = ids.map((id): PlanStep => {
    const m = resolved.get(id)!, have = installed.get(id);
    let action: StepAction = 'install';
    if (have) {
      if (have.version === m.version) {
        if (have.sha256 === m.sha256) action = 'already_installed';
        else { action = 'conflict'; const msg = `${id}@${m.version}: installed artifact differs from the pinned one (sha256)`; problems.push(msg); conflicts.push(msg); }
      } else {
        action = 'upgrade';
        try { if (compareSemver(have.version, m.version) > 0) warnings.push(`${id}: installed ${have.version} is newer than the pinned ${m.version} (this is a downgrade)`); } catch { /* unparseable installed version: treat as an upgrade */ }
      }
    }
    return { id, type: m.type, version: m.version, versionId: m.versionId, sha256: m.sha256, action, dependsOn: graph.get(id) ?? [],
      riskTier: memberTier(m), elevated: memberElevated(m), scanVerdict: m.scanVerdict, permissions: m.permissions };
  });
  for (const s of steps) if (s.scanVerdict === 'warnings') warnings.push(`${s.id}: security scan reported warnings`);

  const permissions = unionPermissions(steps.map((s) => s.permissions));
  let riskTier: RiskTier = TYPE_POLICY.bundle.riskTier;
  for (const s of steps) riskTier = maxTier(riskTier, s.riskTier);
  const elevated = steps.some((s) => s.elevated);

  let policy: BundlePlan['policy'];
  if (ctx.policy) {
    const verdicts = bundlePolicyVerdicts(steps, ctx.policy, ctx.trustOf);
    verdicts.forEach((v, i) => { steps[i].policy = v.allowed ? { allowed: true } : { allowed: false, reason: v.reason }; });
    policy = { allowed: verdicts.filter((v) => v.allowed).map((v) => v.id), denied: verdicts.filter((v) => !v.allowed).map((v) => ({ id: v.id, reason: v.reason ?? 'denied' })) };
  }
  return { steps, permissions, problems, warnings, conflicts, riskTier, elevated, ...(policy ? { policy } : {}), installable: problems.length === 0 && (policy ? policy.denied.length === 0 : true) };
}
