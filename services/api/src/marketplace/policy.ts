// Install policy evaluation, pure and shared by the API, the tests and (as JSON) the desktop.
// Input is the document marketplace_effective_policy(uid) returns: the org layer (if any) first, then one
// layer per team of the caller that has a policy. Effective = every layer must allow:
//   - any matching deny rule in any layer denies (deny wins);
//   - a layer in 'allowlist' mode needs a matching allow rule IN THAT LAYER (no rules = nothing allowed);
//   - a layer's min_trust floor and require_clean_scan apply on top.
// Anything malformed is an error (callers treat a thrown error as "install refused": fail closed).
import type { Trust } from './types.ts';
export type { Trust };
export type RuleEffect = 'allow' | 'deny';
export type RuleMatchKind = 'listing' | 'publisher' | 'type';
export interface PolicyRule { effect: RuleEffect; matchKind: RuleMatchKind; matchValue: string }
export interface PolicyLayer {
  scopeKind: 'org' | 'team'; scopeId: string; mode: 'open' | 'allowlist';
  minTrust: Trust | null; requireCleanScan: boolean; rules: PolicyRule[];
}
export interface EffectivePolicy { layers: PolicyLayer[] }
export interface PolicySubject {
  listingId: string; publisherId: string; type: string; trust: Trust; scanVerdict: 'pending' | 'clean' | 'warnings' | 'blocked';
}
export interface PolicyDecision { allowed: boolean; reason?: string }

const TRUST_RANK: Record<Trust, number> = { private: 0, community: 1, verified: 2, official: 3 };
const MAX_LAYERS = 64;
const MAX_RULES = 500;

const matches = (r: PolicyRule, s: PolicySubject): boolean =>
  r.matchKind === 'listing' ? r.matchValue === s.listingId
  : r.matchKind === 'publisher' ? r.matchValue === s.publisherId
  : r.matchValue === s.type;

const label = (l: PolicyLayer) => (l.scopeKind === 'org' ? 'the organization policy' : `the team policy (${l.scopeId})`);

export function evaluate(policy: EffectivePolicy, s: PolicySubject): PolicyDecision {
  for (const l of policy.layers) {
    const hit = l.rules.find((r) => r.effect === 'deny' && matches(r, s));
    if (hit) return { allowed: false, reason: `denied by ${label(l)}: ${hit.matchKind} ${hit.matchValue}` };
  }
  for (const l of policy.layers) {
    if (l.mode === 'allowlist' && !l.rules.some((r) => r.effect === 'allow' && matches(r, s))) {
      return { allowed: false, reason: `not on the allowlist of ${label(l)}` };
    }
    if (l.minTrust !== null && TRUST_RANK[s.trust] < TRUST_RANK[l.minTrust]) {
      return { allowed: false, reason: `trust ${s.trust} is below ${l.minTrust} required by ${label(l)}` };
    }
    if (l.requireCleanScan && s.scanVerdict !== 'clean') {
      return { allowed: false, reason: `${label(l)} requires a clean security scan (verdict: ${s.scanVerdict})` };
    }
  }
  return { allowed: true };
}

/** Validate the JSON from marketplace_effective_policy(); throws on anything unexpected. */
export function parseEffectivePolicy(raw: unknown): EffectivePolicy {
  const bad = (m: string): never => { throw new Error(`invalid effective policy: ${m}`); };
  const o = raw as { layers?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.layers)) return bad('layers');
  if (o.layers.length > MAX_LAYERS) return bad('too many layers');
  const layers = o.layers.map((l: any): PolicyLayer => {
    if (!l || typeof l !== 'object') return bad('layer');
    if (l.scopeKind !== 'org' && l.scopeKind !== 'team') return bad('scopeKind');
    if (typeof l.scopeId !== 'string' || !l.scopeId) return bad('scopeId');
    if (l.mode !== 'open' && l.mode !== 'allowlist') return bad('mode');
    if (l.minTrust !== null && !(typeof l.minTrust === 'string' && l.minTrust in TRUST_RANK)) return bad('minTrust');
    if (typeof l.requireCleanScan !== 'boolean') return bad('requireCleanScan');
    if (!Array.isArray(l.rules) || l.rules.length > MAX_RULES) return bad('rules');
    const rules = l.rules.map((r: any): PolicyRule => {
      if (!r || (r.effect !== 'allow' && r.effect !== 'deny')) return bad('rule.effect');
      if (r.matchKind !== 'listing' && r.matchKind !== 'publisher' && r.matchKind !== 'type') return bad('rule.matchKind');
      if (typeof r.matchValue !== 'string' || !r.matchValue) return bad('rule.matchValue');
      return { effect: r.effect, matchKind: r.matchKind, matchValue: r.matchValue };
    });
    return { scopeKind: l.scopeKind, scopeId: l.scopeId, mode: l.mode, minTrust: l.minTrust, requireCleanScan: l.requireCleanScan, rules };
  });
  return { layers };
}

/** Load the policy that applies to `uid` (a caller-scoped connection may only ask about itself). */
export async function loadEffectivePolicy(q: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, uid: string): Promise<EffectivePolicy> {
  const r = await q.query('SELECT marketplace_effective_policy($1) AS p', [uid]);
  return parseEffectivePolicy(r.rows[0]?.p);
}
