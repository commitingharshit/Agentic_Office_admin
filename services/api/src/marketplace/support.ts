// The ONLY list of what is operational, and the per-type publishing policy. Everything that decides "can this type be
// shown / installed / published" reads this file (directly, or through GET /v1/marketplace/capabilities). Defaults are
// fail-closed: a type that is not listed as supported is unsupported, and says why.
import { LISTING_TYPES, type ListingType, type RiskTier, type Trust } from './types.ts';

export type { RiskTier };
export interface TypeSupport { type: ListingType; supported: boolean; modes?: Record<string, boolean>; modeReasons?: Record<string, string>; reason?: string; path?: string }
/**
 * `evidence`: repo-relative path of the passing end-to-end evidence record that justifies `supported: true` (enforced by
 * test/marketplace-enablement.test.ts). `unitOnlyModes`: modes marked true whose end-to-end flow was NOT run (covered by unit tests only);
 * listed so the table never claims more than the evidence says. `modeReasons`: why a mode that stays false is false.
 * `heldBack`: why a type stays unsupported although a valid evidence record exists.
 */
type Entry = { supported: boolean; modes?: Record<string, boolean>; modeReasons?: Record<string, string>; reason?: string; path?: string; evidence?: string; unitOnlyModes?: readonly string[]; heldBack?: string };

/** The ONLY list of what is operational. Flipped from evidence in the ship step; every other task treats it as read-only. */
export const OPERATIONAL: Readonly<Record<ListingType, Entry>> = Object.freeze({
  template: { supported: true },
  skill: { supported: true },
  routine: { supported: true, evidence: 'docs/audits/marketplace-type-evidence/routine.json' },
  memory: { supported: true, evidence: 'docs/audits/marketplace-evidence/memory.json' },
  hook: { supported: true, modes: { declarative: true, script: false }, modeReasons: { script: 'Script hooks stay unavailable until an OS sandbox passes its hostile corpus.' }, evidence: 'docs/audits/marketplace-type-evidence.hook.json' },
  bridge: { supported: true, evidence: 'docs/audits/marketplace-type-evidence.bridge.json' },
  connector: { supported: true, modes: { none: true, api_key: true, bearer: true, oauth2: false }, unitOnlyModes: ['none', 'bearer'],
    modeReasons: { oauth2: 'OAuth connectors need a token broker that does not exist.' }, evidence: 'docs/audits/marketplace-type-evidence.connector.json' },
  workflow: { supported: true, evidence: 'docs/audits/marketplace-type-evidence/workflow.json' },
  surface: { supported: false, reason: 'Surfaces are not supported: a surface is arbitrary in-gateway code holding account credentials, with no sandbox.', path: 'A declarative webhook-style surface behind the grants model, after a sandbox and a token broker exist.' },
  // Install and use from the marketplace only: the Agent Builder form, the Team Library UI and the admin pages for agents are not part of this.
  agent: { supported: true, evidence: 'docs/audits/marketplace-type-evidence/agent.json' },
  bundle: { supported: true, evidence: 'docs/audits/marketplace-type-evidence/bundle.json' },
});

/** Types whose support depends on a startup self-check rather than on the static table: agent and bundle need the Python compiler bridge. */
export const BRIDGE_TYPES: readonly ListingType[] = ['agent', 'bundle'];
export interface RuntimeSupport { bridge?: boolean }
export const BRIDGE_UNAVAILABLE_REASON = 'Agents and bundles are unavailable on this server right now: the blueprint compiler did not pass its startup self-check.';

/**
 * Agent and bundle are reported supported only when the compiler bridge passed its startup self-check (`runtime.bridge === true`):
 * the static row says the install path has end-to-end evidence, the self-check says this server can compile blueprints right now.
 * Unknown (`undefined`) is treated as not passed. Every other type is exactly what OPERATIONAL says.
 */
export function typeSupport(runtime: RuntimeSupport = {}): TypeSupport[] {
  return LISTING_TYPES.map((type): TypeSupport => {
    const base = OPERATIONAL[type] ?? { supported: false, reason: 'Unknown type.' };   // a missing row is unsupported, never supported
    const viaBridge = BRIDGE_TYPES.includes(type);
    const e: Entry = viaBridge && (runtime.bridge !== true || base.supported !== true)
      ? { ...base, supported: false, reason: base.supported === true ? BRIDGE_UNAVAILABLE_REASON : base.reason, path: base.path ?? 'Retry when the server reports the blueprint compiler as available.' }
      : base;
    return {
      type, supported: e.supported === true,
      ...(e.modes ? { modes: { ...e.modes } } : {}),
      ...(e.modeReasons ? { modeReasons: { ...e.modeReasons } } : {}),
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
