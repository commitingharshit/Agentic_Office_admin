// Pure helpers for the Marketplace admin pages: no Next, no fetch, so they are unit-tested directly (test/marketplace.test.ts).
// The API (accounts-sync /admin/marketplace/*) is the authority on every rule below; these mirror it only to decide what to SHOW.

export const LISTING_TYPES = ['template', 'skill', 'agent', 'bundle', 'workflow', 'memory', 'connector', 'bridge', 'surface', 'hook', 'routine'] as const;
/** Types the publish wizard accepts here: the ones this console has a package layout and review page for. The API enforces its own per-type support again. */
export const PUBLISHABLE_TYPES: readonly string[] = ['template', 'skill', 'agent', 'bundle'];
export const VISIBILITIES = ['public', 'org', 'team', 'private'] as const;
export const VERSION_STATES = ['draft', 'validating', 'testing', 'submitted', 'in_review', 'approved', 'published', 'rejected', 'deprecated', 'quarantined', 'revoked'] as const;
export const ACTIONS = ['claim', 'approve', 'reject', 'publish', 'deprecate', 'quarantine', 'revoke'] as const;
export type MarketAction = typeof ACTIONS[number];

/** Same table as the API's ACTION_PERMISSION. */
export const ACTION_PERMISSION: Record<MarketAction, string> = {
  claim: 'marketplace.review', approve: 'marketplace.review', reject: 'marketplace.review', publish: 'marketplace.review',
  deprecate: 'marketplace.write', quarantine: 'marketplace.moderate', revoke: 'marketplace.moderate',
};
export const NEEDS_REASON: readonly MarketAction[] = ['reject', 'quarantine', 'revoke'];

/** Same table as the API's transition(): which states each action may start from. */
const FROM: Record<MarketAction, (s: string) => boolean> = {
  claim: (s) => s === 'submitted',
  approve: (s) => s === 'submitted' || s === 'in_review',
  reject: (s) => s === 'submitted' || s === 'in_review' || s === 'approved',
  publish: (s) => s === 'approved',
  deprecate: (s) => s === 'published',
  quarantine: (s) => s === 'published' || s === 'approved' || s === 'deprecated',
  revoke: (s) => !['draft', 'validating', 'testing', 'revoked'].includes(s),
};

/** The lifecycle buttons to offer for a version: allowed by the state machine AND by the viewer's permissions. */
export function allowedActions(state: string, permissions: readonly string[]): MarketAction[] {
  return ACTIONS.filter((a) => FROM[a](state) && permissions.includes(ACTION_PERMISSION[a]));
}
/** Rescan is offered for the states the API accepts it in, to anyone with marketplace.write. */
export const canRescan = (state: string, permissions: readonly string[]) => ['submitted', 'in_review', 'approved'].includes(state) && permissions.includes('marketplace.write');

export interface Check { name: string; ok: boolean; skipped?: boolean; required?: boolean; detail?: string }
export interface ValidationSummary {
  total: number; passed: number; skipped: number; failed: number;
  /** What the report as a whole honestly says. 'verified' only when the server said verified:true and nothing failed. */
  outcome: 'verified' | 'unverified' | 'failed';
  headline: string;
  checks: Array<Check & { status: 'ok' | 'skipped' | 'failed' }>;
}
/** Never claims success unless the server did: ok:true without verified:true is 'unverified' (some required check did not run). */
export function summarizeValidation(v: { ok?: boolean; verified?: boolean; checks?: Check[] } | null | undefined): ValidationSummary {
  const checks = (v?.checks ?? []).map((c) => ({ ...c, status: (c.skipped ? 'skipped' : c.ok ? 'ok' : 'failed') as 'ok' | 'skipped' | 'failed' }));
  const failed = checks.filter((c) => c.status === 'failed').length, skipped = checks.filter((c) => c.status === 'skipped').length;
  const passed = checks.length - failed - skipped;
  const outcome = !v || v.ok !== true || failed > 0 ? 'failed' : v.verified === true ? 'verified' : 'unverified';
  const headline = outcome === 'verified' ? 'Every required check ran and passed.'
    : outcome === 'unverified' ? `Not verified: ${skipped ? `${skipped} check${skipped === 1 ? ' was' : 's were'} skipped` : 'the server did not mark this verified'}. The version cannot be approved until a rescan verifies it.`
    : `Failed: ${failed || 'a'} required check${failed === 1 ? '' : 's'} did not pass.`;
  return { total: checks.length, passed, skipped, failed, outcome, headline, checks };
}

/** Query-string builder for list pages: keeps only known, non-empty, valid filters (the API rejects bad enum values with 400). */
export function listQuery(raw: Record<string, string | undefined>, allow: Record<string, readonly string[] | true>): string {
  const p = new URLSearchParams();
  for (const [k, rule] of Object.entries(allow)) {
    const v = (raw[k] ?? '').trim();
    if (!v) continue;
    if (rule !== true && !rule.includes(v)) continue;
    p.set(k, v.slice(0, 200));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const CATALOG_FILTERS = { q: true, type: LISTING_TYPES, publisher: true, visibility: VISIBILITIES, state: VERSION_STATES, page: true } as const;

/** Link to the same list with a different cursor, preserving the other filters. */
export function withParams(base: string, q: Record<string, string | undefined>, patch: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...patch })) if (v !== undefined && v !== '' && k !== 'msg' && k !== 'err') p.set(k, v);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

export const ratingText = (avg: number | null | undefined, count: number | null | undefined) => (avg == null || !count ? 'No ratings' : `${avg.toFixed(1)} (${count})`);
export const pct = (r: number | null | undefined) => (r == null ? 'n/a' : `${Math.round(r * 1000) / 10}%`);

export const STATE_LABEL: Record<string, string> = { in_review: 'in review' };
export const label = (s: string | null | undefined) => (s ? (STATE_LABEL[s] ?? s.replace(/_/g, ' ')) : '—');
/** Permission names the manifest asks for, flagged when they reach beyond reading the workspace. */
export const SENSITIVE_CAPS = /^(exec|net|fs\.write|fs\.home|secrets|shell|process)/;
export const isSensitiveCapability = (c: string) => SENSITIVE_CAPS.test(c) || /\.write$/.test(c);

/** Encode/decode a compact validation result across a redirect (the action cannot render, so the page re-reads it from the address). */
export function packValidation(v: { ok?: boolean; verified?: boolean; checks?: Check[] }): string {
  const slim = { ok: v.ok === true, verified: v.verified === true, checks: (v.checks ?? []).slice(0, 40).map((c) => ({ name: String(c.name).slice(0, 80), ok: !!c.ok, skipped: !!c.skipped, required: !!c.required, ...(c.detail ? { detail: String(c.detail).slice(0, 240) } : {}) })) };
  return Buffer.from(JSON.stringify(slim)).toString('base64url');
}
export function unpackValidation(s: string | undefined): { ok: boolean; verified: boolean; checks: Check[] } | null {
  if (!s || s.length > 12_000) return null;
  try {
    const d = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!d || !Array.isArray(d.checks)) return null;
    return { ok: d.ok === true, verified: d.verified === true, checks: d.checks.filter((c: any) => c && typeof c.name === 'string').map((c: any) => ({ name: c.name, ok: !!c.ok, skipped: !!c.skipped, required: !!c.required, detail: typeof c.detail === 'string' ? c.detail : undefined })) };
  } catch { return null; }
}

export const MARKETPLACE_PERMISSIONS = ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate', 'marketplace.policy'] as const;
/**
 * The console's permission list comes from /admin/me (the rbac table, which has no marketplace entries). The marketplace API has its own
 * role map (AO_MARKETPLACE_ROLES) and reports what it will accept at /admin/marketplace/me; this adds exactly those, so a button is shown
 * only when the API would take it. Unknown entries are dropped; when that API did not answer there are no marketplace permissions.
 */
export function withMarketplacePermissions(base: readonly string[], mine: { role?: string; permissions?: unknown } | null | undefined): string[] {
  const extra = Array.isArray(mine?.permissions) ? (mine!.permissions as unknown[]).filter((p): p is string => typeof p === 'string' && (MARKETPLACE_PERMISSIONS as readonly string[]).includes(p)) : [];
  return [...new Set([...base, ...extra])];
}
