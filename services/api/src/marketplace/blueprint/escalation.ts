// Permission-escalation checks. The manifest's `permissions` are the ONLY thing the install dialog shows, so
// everything the agent can end up holding must be a subset of them:
//  E1 capabilities the blueprint requires (derived by the compiler and locally) are declared;
//  E2 the union of the skills' declared permissions is declared (scopes not broader than the agent's);
//  E3 a child agent holds no capability, and no toolset, its parent does not.
import type { PermissionRequest } from '../types.ts';
import type { AgentBlueprint, BlueprintDiagnostic } from './schema.ts';
import type { ResolvedRefs } from './resolve.ts';

type Cap = PermissionRequest['capability'];
const WILDCARD_TOOLSETS = new Set(['all', 'any', 'everything', 'full', 'star', 'wildcard']);

/** `declared` covers `needed` when equal, or when declared is a `dir/**` / `dir/*` prefix glob that contains it. */
export function scopeCovers(declared: string, needed: string): boolean {
  if (declared === needed) return true;
  if (declared.includes('*') && !declared.endsWith('/**') && !declared.endsWith('/*')) return false;
  if (declared.endsWith('/**')) return needed.startsWith(declared.slice(0, -2)) && !needed.includes('..');
  if (declared.endsWith('/*')) { const pre = declared.slice(0, -1); return needed.startsWith(pre) && !needed.slice(pre.length).includes('/') && !needed.includes('..'); }
  return false;
}
const holds = (perms: readonly PermissionRequest[], p: PermissionRequest) => perms.some(d => d.capability === p.capability && scopeCovers(d.scope, p.scope));
const fmt = (p: PermissionRequest) => `${p.capability} on ${JSON.stringify(p.scope)}`;

/** Capabilities the blueprint itself implies, derivable without Hermes (the compiler adds toolset-derived ones). */
export function deriveRequired(bp: AgentBlueprint): Cap[] {
  const need = new Set<Cap>();
  const cs = bp.contextScope;
  if (cs?.workspaceAccess === 'read' || cs?.workspaceAccess === 'write') need.add('fs.workspace.read');
  if (cs?.workspaceAccess === 'write') need.add('fs.workspace.write');
  if (bp.toolPermissions?.mode === 'auto-edit') need.add('fs.workspace.write');
  if (bp.delegationPolicy) need.add('tool.invoke');
  if (bp.knowledgeSources?.some(k => k.kind !== 'workspace')) need.add('network');
  return [...need];
}

export function checkEscalation(bp: AgentBlueprint, manifestPermissions: PermissionRequest[], required: PermissionRequest['capability'][], resolved: ResolvedRefs): BlueprintDiagnostic[] {
  const out: BlueprintDiagnostic[] = [];
  const declared = manifestPermissions ?? [];
  // E1
  for (const cap of new Set(required)) if (!declared.some(d => d.capability === cap)) out.push({ path: 'permissions', code: 'undeclared_capability', message: `the blueprint requires ${cap} but the manifest does not declare it` });
  // E2
  for (const s of resolved.skills) for (const p of s.permissions ?? []) if (!holds(declared, p)) out.push({ path: 'permissions', code: 'skill_exceeds_agent', message: `skill ${s.id} declares ${fmt(p)} which the agent does not declare` });
  // E3
  const parentToolsets = new Set(bp.toolPermissions?.toolsets ?? []);
  for (const c of resolved.children) {
    for (const p of c.permissions ?? []) if (!holds(declared, p)) out.push({ path: 'delegationPolicy.children', code: 'child_exceeds_parent', message: `child ${c.id} declares ${fmt(p)} which the parent does not declare` });
    const ct = c.blueprint?.toolPermissions?.toolsets ?? [];
    const extra = ct.filter(t => !parentToolsets.has(t));
    if (extra.length) out.push({ path: 'delegationPolicy.children', code: 'child_exceeds_parent', message: `child ${c.id} enables toolset(s) the parent does not: ${extra.slice(0, 6).join(', ')}` });
  }
  // grandchildren may not exceed their own parent either
  for (const [id, a] of resolved.agents) {
    const kids = resolved.graph.get(id) ?? [];
    for (const k of kids) {
      const child = resolved.agents.get(k);
      if (!child) continue;
      for (const p of child.permissions ?? []) if (!holds(a.permissions ?? [], p)) out.push({ path: 'delegationPolicy.children', code: 'child_exceeds_parent', message: `${k} declares ${fmt(p)} which its parent ${id} does not declare` });
    }
  }
  return out;
}

/** Wildcard-ish toolset/kit/deny names and wildcard permission scopes. */
export function checkNoWildcards(bp: AgentBlueprint, manifestPermissions: PermissionRequest[]): BlueprintDiagnostic[] {
  const out: BlueprintDiagnostic[] = [];
  const tp = bp.toolPermissions;
  for (const [key, list] of [['toolsets', tp?.toolsets], ['kits', tp?.kits], ['deny', tp?.deny]] as const)
    (list ?? []).forEach((t, i) => { if (t.includes('*') || WILDCARD_TOOLSETS.has(t.toLowerCase())) out.push({ path: `toolPermissions.${key}[${i}]`, code: 'wildcard', message: `${JSON.stringify(t)} is a wildcard; name exact toolsets` }); });
  manifestPermissions.forEach((p, i) => { if (typeof p.scope !== 'string' || p.scope.trim() === '' || /^\*+(\.\*)?$/.test(p.scope.trim())) out.push({ path: `permissions[${i}]`, code: 'wildcard', message: `${p.capability}: scope must be specific` }); });
  return out;
}
