// The ONLY list of what is operational, and the per-type publishing policy. Everything that decides "can this type be
// shown / installed / published" reads this file (directly, or through GET /v1/marketplace/capabilities). Defaults are
// fail-closed: a type that is not listed as supported is unsupported, and says why.
import { LISTING_TYPES, type ListingType, type RiskTier, type Trust } from './types.ts';

export type { RiskTier };
export interface TypeSupport { type: ListingType; supported: boolean; modes?: Record<string, boolean>; reason?: string; path?: string }
type Entry = { supported: boolean; modes?: Record<string, boolean>; reason?: string; path?: string };

/** The ONLY list of what is operational. Plan 3 Task 15 edits it; every other task treats it as read-only. */
export const OPERATIONAL: Readonly<Record<ListingType, Entry>> = Object.freeze({
  template: { supported: true },
  skill: { supported: true },
  routine: { supported: false, reason: 'Routines are not available yet: the end-to-end flow has not passed.', path: 'Agent-prompt routines run on the existing cron scheduler once their flow passes.' },
  memory: { supported: false, reason: 'Memory backends are not available yet: the end-to-end flow has not passed.', path: 'Memory backends bind to a bundled Hermes memory provider; no code ships.' },
  hook: { supported: false, modes: { declarative: false, script: false }, reason: 'Lifecycle hooks are not available yet. Script hooks stay unavailable until an OS sandbox passes its hostile corpus.', path: 'Declarative hooks first; script hooks only on hosts with a verified sandbox.' },
  bridge: { supported: false, reason: 'MCP bridges are not available yet: the end-to-end flow has not passed.', path: 'Remote https MCP servers only, exposed only to agents that are granted them. Local (stdio) bridges need a sandbox first.' },
  connector: { supported: false, modes: { none: false, api_key: false, bearer: false, oauth2: false }, reason: 'Connectors are not available yet. OAuth connectors need a token broker that does not exist.', path: 'none, api_key and bearer connectors first; oauth2 needs a separate token-broker plan.' },
  workflow: { supported: false, reason: 'Workflows are not available yet: they need the DAG runtime and its end-to-end flow has not passed.', path: 'Workflows run when the DAG runtime is reachable; otherwise the item says it is not running.' },
  surface: { supported: false, reason: 'Surfaces are not supported: a surface is arbitrary in-gateway code holding account credentials, with no sandbox.', path: 'A declarative webhook-style surface behind the grants model, after a sandbox and a token broker exist.' },
  agent: { supported: false, reason: 'Agents are not available yet.', path: 'Agents and bundles arrive with the agents-and-bundles release.' },
  bundle: { supported: false, reason: 'Bundles are not available yet.', path: 'Agents and bundles arrive with the agents-and-bundles release.' },
});

/** Types whose support depends on a startup self-check rather than on the static table: agent and bundle need the Python compiler bridge. */
export const BRIDGE_TYPES: readonly ListingType[] = ['agent', 'bundle'];
export interface RuntimeSupport { bridge?: boolean }
export const BRIDGE_UNAVAILABLE_REASON = 'Agents and bundles are unavailable on this server right now: the blueprint compiler did not pass its startup self-check.';

/**
 * `runtime.bridge === true` (the compiler bridge passed its startup self-check) makes agent and bundle supported; anything else
 * leaves them as OPERATIONAL says. A static `supported:true` row is never downgraded here.
 */
export function typeSupport(runtime: RuntimeSupport = {}): TypeSupport[] {
  return LISTING_TYPES.map((type): TypeSupport => {
    const base = OPERATIONAL[type] ?? { supported: false, reason: 'Unknown type.' };   // a missing row is unsupported, never supported
    const viaBridge = BRIDGE_TYPES.includes(type);
    const e: Entry = viaBridge && runtime.bridge === true ? { supported: true }
      : viaBridge && runtime.bridge === false && base.supported !== true ? { ...base, supported: false, reason: BRIDGE_UNAVAILABLE_REASON } : base;
    return {
      type, supported: e.supported === true,
      ...(e.modes ? { modes: { ...e.modes } } : {}),
      ...(e.supported === true ? {} : { reason: e.reason ?? 'Not available yet.', ...(e.path ? { path: e.path } : {}) }),
    };
  });
}

/** True only when the type is supported and (when a mode is named) that mode is explicitly supported. Unknown type or mode: false. */
export function isPublishable(type: ListingType, mode?: string): boolean {
  const e = (OPERATIONAL as Record<string, Entry | undefined>)[type];
  if (!e || e.supported !== true) return false;
  if (mode === undefined) return true;
  return e.modes !== undefined && Object.prototype.hasOwnProperty.call(e.modes, mode) && e.modes[mode] === true;
}

export interface TypePolicy { riskTier: RiskTier; manualReview: boolean; minPublisherTrust: Trust }
/** `riskTier` is the FLOOR: a validator may report a higher tier from the payload, never a lower one. Mirrors marketplace_type_policy (migration 0018). */
/** agent and bundle keep their pre-Plan-3 behaviour (Plan 2 owns them); surface is executable and never publishable, so it is manual review. */
export const TYPE_POLICY: Readonly<Record<ListingType, TypePolicy>> = Object.freeze({
  template: { riskTier: 'data', manualReview: false, minPublisherTrust: 'community' },
  skill: { riskTier: 'declarative', manualReview: false, minPublisherTrust: 'community' },
  hook: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' },
  bridge: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' },
  connector: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' },
  routine: { riskTier: 'declarative', manualReview: true, minPublisherTrust: 'community' },
  memory: { riskTier: 'declarative', manualReview: true, minPublisherTrust: 'community' },
  workflow: { riskTier: 'declarative', manualReview: true, minPublisherTrust: 'community' },
  surface: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified' },
  agent: { riskTier: 'declarative', manualReview: false, minPublisherTrust: 'community' },
  bundle: { riskTier: 'declarative', manualReview: false, minPublisherTrust: 'community' },
});

/**
 * Manual review (a reviewer other than the submitter, acknowledging the permission summary) applies to every type whose policy
 * says so, and to an agent or bundle whose risk tier is `executable` (it declares or contains exec.script / network / secrets use,
 * or an elevated member). `checks` may carry the bundle validator's `manual-review-required` note. Unknown type: manual.
 */
export function needsManualReview(type: string, riskTier: string | null | undefined, checks?: ReadonlyArray<{ name: string }>): boolean {
  const p = (TYPE_POLICY as Record<string, TypePolicy | undefined>)[type];
  if (!p || p.manualReview) return true;
  if (type === 'agent' || type === 'bundle') return riskTier === 'executable' || (checks?.some(c => c.name === 'manual-review-required') ?? false);
  return false;
}

const TIER_RANK: Record<RiskTier, number> = { data: 0, declarative: 1, executable: 2 };
export const maxTier = (a: RiskTier, b: RiskTier): RiskTier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
const TRUST_RANK: Record<Trust, number> = { private: 0, community: 1, verified: 2, official: 3 };
/** Publisher trust gate: fails closed on an unknown trust value. */
export function trustAtLeast(have: Trust, need: Trust): boolean {
  const h = TRUST_RANK[have], n = TRUST_RANK[need];
  return h !== undefined && n !== undefined && h >= n;
}
