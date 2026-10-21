// Pure helpers for the agent and bundle review pages, the org policy form and the team assignments table (Plan 2 Task 14).
// No Next, no fetch: unit-tested in test/marketplace-plan2.test.ts. Everything here is derived from what the admin API returned;
// when the API did not say, the answer is "unknown" or "not run", never a guess and never a pass.
import type { Check } from './marketplace';

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a package for each type must contain (shown on the publish page). The server validators are the authority. */
export const PACKAGE_HELP: Record<string, string> = {
  template: 'agentic.marketplace.json, the template file (.pptx, .docx or .xlsx) and previews/*.png.',
  skill: 'agentic.marketplace.json and a skill folder: SKILL.md plus optional references/ files.',
  agent: 'agentic.marketplace.json, blueprint.json (the agent blueprint, data only), SOUL.md (the persona, at most 32 KiB) and an optional README.md. No other files; no credentials, documents or memories.',
  bundle: 'agentic.marketplace.json, bundle.json (exact pinned members with their sha256 and an install order; a bundle cannot contain a bundle) and an optional README.md. A bundle carries references only, no member content.',
};

export const checkByName = (checks: readonly Check[] | undefined | null, name: string): Check | undefined => (checks ?? []).find((c) => c.name === name);

/** Components the compiler or the local scan said do not run yet. The validator writes "not available yet: a, b" or "none". */
export function unsupportedFromChecks(checks: readonly Check[] | undefined | null): string[] {
  const d = checkByName(checks, 'unsupported-reported')?.detail;
  const m = typeof d === 'string' ? /^not available yet:\s*(.*)$/.exec(d) : null;
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export interface ComponentRow { component: string; state: 'supported' | 'not_available' | 'unknown' }
/** One row per blueprint component the manifest declares. `unknown` when the server recorded no compiler verdict (so nothing is promised). */
export function agentComponentRows(manifest: unknown, checks: readonly Check[] | undefined | null): ComponentRow[] {
  const comps = isObj(manifest) && isObj(manifest.payload) && Array.isArray(manifest.payload.components) ? (manifest.payload.components as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  const reported = checkByName(checks, 'unsupported-reported');
  const un = new Set(unsupportedFromChecks(checks));
  return comps.map((component) => ({ component, state: !reported ? 'unknown' : un.has(component) || [...un].some((u) => u.startsWith(`${component}.`)) ? 'not_available' : 'supported' }));
}

export interface PermissionComparison { derived: string[]; declared: string[]; undeclared: string[]; known: boolean }
const list = (s: string) => (s.trim() === 'none' ? [] : s.split(',').map((x) => x.trim()).filter(Boolean));
/** "derived: a, b; declared: c" (written by the agent validator when permissions-subset passes). Anything else: unknown. */
export function permissionComparison(checks: readonly Check[] | undefined | null): PermissionComparison {
  const c = checkByName(checks, 'permissions-subset');
  const m = c && c.ok && !c.skipped && typeof c.detail === 'string' ? /^derived: (.*); declared: (.*)$/.exec(c.detail) : null;
  if (!m) return { derived: [], declared: [], undeclared: [], known: false };
  const derived = list(m[1]), declared = list(m[2]);
  return { derived, declared, undeclared: derived.filter((d) => !declared.includes(d)), known: true };
}

export interface DryRunLine { status: 'passed' | 'failed' | 'skipped' | 'not_run'; text: string }
/** A skipped dry run is never "passed". The server stores a step count, not the step list, and this says so rather than inventing steps. */
export function dryRunLine(checks: readonly Check[] | undefined | null): DryRunLine {
  const c = checkByName(checks, 'dry-run');
  if (!c) return { status: 'not_run', text: 'No dry run is on record for this version.' };
  if (c.skipped) return { status: 'skipped', text: c.detail ?? 'skipped' };
  return c.ok ? { status: 'passed', text: c.detail ?? 'passed' } : { status: 'failed', text: c.detail ?? 'failed' };
}

export interface MemberRow { id: string; range: string; pinned: boolean; version: string | null }
/** A bundle's members are its manifest dependencies (the validator requires them to equal the items at "=version"). */
export function bundleMembers(manifest: unknown): MemberRow[] {
  const deps = isObj(manifest) && Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  return deps.filter((d: unknown): d is Obj => isObj(d) && typeof d.id === 'string' && typeof d.range === 'string')
    .map((d) => ({ id: d.id, range: d.range, pinned: /^=\d/.test(d.range), version: /^=\d/.test(d.range) ? d.range.slice(1) : null }));
}

export const ASSIGNMENT_MODES = ['required', 'recommended', 'optional'] as const;
export interface AssignmentRow { id: string; teamId: string; listingId: string; title: string; type: string; version: string; sha: string; mode: string; status: 'ok' | 'blocked'; statusText: string }
export function assignmentRows(data: { items?: any[] } | null | undefined): AssignmentRow[] {
  return (Array.isArray(data?.items) ? data!.items! : []).filter(isObj).map((a) => {
    const blocked = a.blocked === true;
    return { id: String(a.id), teamId: String(a.teamId), listingId: String(a.listingId), title: String(a.title ?? a.listingId), type: String(a.type ?? ''), version: String(a.pinnedVersion ?? ''),
      sha: String(a.pinSha256 ?? '').slice(0, 12), mode: String(a.mode ?? ''), status: blocked ? 'blocked' : 'ok',
      statusText: blocked ? `Blocked: this version was ${a.versionState}` : String(a.versionState ?? 'unknown') };
  });
}

export interface PolicyDocInput { mode: 'open' | 'allowlist'; minTrust: string | null; requireCleanScan: boolean; rules: Array<{ effect: 'allow' | 'deny'; matchKind: 'listing' | 'publisher' | 'type'; matchValue: string }> }
const TRUSTS = ['official', 'verified', 'community', 'private'];
const KINDS = ['listing', 'publisher', 'type'];
const MAX_RULES = 500;
/** Form to the document PUT /admin/marketplace/policies/org takes. Format only: the API validates every value again and is the authority. */
export function parsePolicyForm(f: { mode?: string; minTrust?: string; requireCleanScan?: string; rules?: string }): { ok: true; doc: PolicyDocInput } | { ok: false; error: string } {
  if (f.mode !== 'open' && f.mode !== 'allowlist') return { ok: false, error: 'Mode must be open or allowlist.' };
  const minTrust = (f.minTrust ?? '').trim();
  if (minTrust && !TRUSTS.includes(minTrust)) return { ok: false, error: `Minimum trust must be one of ${TRUSTS.join(', ')}.` };
  const rules: PolicyDocInput['rules'] = [];
  for (const [i, raw] of (f.rules ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [effect, kind, value, ...extra] = line.split(/\s+/);
    if ((effect !== 'allow' && effect !== 'deny') || !KINDS.includes(kind) || !value || extra.length) return { ok: false, error: `Rule on line ${i + 1} must read "allow|deny listing|publisher|type value".` };
    rules.push({ effect, matchKind: kind as 'listing' | 'publisher' | 'type', matchValue: value });
  }
  if (rules.length > MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} rules.` };
  return { ok: true, doc: { mode: f.mode, minTrust: minTrust || null, requireCleanScan: f.requireCleanScan === 'on', rules } };
}

export function policyToForm(p: Obj | null | undefined): { mode: string; minTrust: string; requireCleanScan: boolean; rules: string } {
  if (!p) return { mode: 'open', minTrust: '', requireCleanScan: true, rules: '' };
  return { mode: p.mode === 'allowlist' ? 'allowlist' : 'open', minTrust: typeof p.minTrust === 'string' ? p.minTrust : '', requireCleanScan: p.requireCleanScan === true,
    rules: (Array.isArray(p.rules) ? p.rules : []).map((r: Obj) => `${r.effect} ${r.matchKind} ${r.matchValue}`).join('\n') };
}
