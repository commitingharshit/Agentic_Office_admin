// Pure helpers for the Marketplace admin pages: no Next, no fetch, so they are unit-tested directly (test/marketplace.test.ts).
// The API (accounts-sync /admin/marketplace/*) is the authority on every rule below; these mirror it only to decide what to SHOW.

export const LISTING_TYPES = ['template', 'skill', 'agent', 'bundle', 'workflow', 'memory', 'connector', 'bridge', 'surface', 'hook', 'routine'] as const;
export const RISK_TIERS = ['data', 'declarative', 'executable'] as const;
export const TRUST_LEVELS = ['private', 'community', 'verified', 'official'] as const;
/** Types whose installs run something or reach outside the app: they get the advanced review, security and analytics views. */
export const ADVANCED_TYPES = LISTING_TYPES.filter((t) => t !== 'template' && t !== 'skill');
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
export const CATALOG_FILTERS = { q: true, type: LISTING_TYPES, publisher: true, visibility: VISIBILITIES, state: VERSION_STATES, riskTier: RISK_TIERS, manualReview: ['true', 'false'], page: true } as const;

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

// ── verification views (Plan 4 Task 14). Words, never a score; every string from a package stays a string (React escapes it).

/** The Catalog column and the review heading: Pass / Partly / None / Failed. An unknown value is never shown as a pass. */
export function verificationWord(v: string | null | undefined): 'Pass' | 'Partly' | 'None' | 'Failed' {
  return v === 'pass' ? 'Pass' : v === 'incomplete' ? 'Partly' : v === 'fail' ? 'Failed' : 'None';
}
export const verificationTone = (v: string | null | undefined) => (v === 'pass' ? 'active' : v === 'incomplete' ? 'pending' : v === 'fail' ? 'failed' : '');

/** The sentence an admin types to approve a version whose verification is incomplete; the API stores it in admin_audit. */
export function incompleteAck(raw: string | null | undefined): { ok: true; text: string } | { ok: false; error: string } {
  const t = (raw ?? '').trim();
  if (t.length < 20) return { ok: false, error: 'Type a sentence saying why you accept the skipped checks (at least 20 characters).' };
  if (t.length > 500) return { ok: false, error: 'The acknowledgement is too long (500 characters at most).' };
  return { ok: true, text: t };
}

/** Evidence images go through the console's own route (which forwards the service token); never a direct blob URL. */
export function evidencePath(versionId: string, sha: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(versionId) || !/^[0-9a-f]{64}$/.test(sha)) return null;
  return `/admin/marketplace/evidence/${versionId}?sha=${sha}`;
}

export interface VerificationRow {
  id: string; title: string; word: 'Pass' | 'Fail' | 'Skipped'; required: boolean; reason?: string;
  /** a failed stage, or a skipped REQUIRED stage: what keeps a version from `pass` */
  blocking: boolean;
  evidence: Array<{ kind: string; label: string; detail?: string; imagePath?: string }>;
}
export function verificationRows(v: { stages?: unknown } | null | undefined, versionId = ''): VerificationRow[] {
  if (!v || !Array.isArray(v.stages)) return [];
  return (v.stages as any[]).filter((s) => s && typeof s.id === 'string' && ['pass', 'fail', 'skipped'].includes(s.status)).map((s) => ({
    id: s.id, title: String(s.title ?? ''), word: s.status === 'pass' ? 'Pass' : s.status === 'fail' ? 'Fail' : 'Skipped', required: s.required === true,
    ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
    blocking: s.status === 'fail' || (s.required === true && s.status === 'skipped'),
    evidence: (Array.isArray(s.evidence) ? s.evidence : []).slice(0, 50).map((e: any) => {
      const m = typeof e?.blobUrl === 'string' && e.blobMime === 'image/png' ? /\/evidence\/([0-9a-f]{64})$/.exec(e.blobUrl) : null;
      const imagePath = m && versionId ? evidencePath(versionId, m[1]) : null;
      return { kind: String(e?.kind ?? 'text'), label: String(e?.label ?? ''), ...(typeof e?.detail === 'string' ? { detail: e.detail } : {}), ...(imagePath ? { imagePath } : {}) };
    }),
  }));
}

// ── advanced types (Plan 3 Task 12)

export interface ReviewDetail { versionId?: string; state?: string; manualReview?: boolean; summarySha256?: string; summary?: { truncated?: boolean } }
const SHA256 = /^[0-9a-f]{64}$/;
export const isSha256 = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v);

/**
 * Whether the acknowledgement step may be offered for this version, and if not why. Mirrors the API (which decides): a version that
 * needs manual review is approved only with the exact summary hash, and a summary too large to read in full cannot be approved at all.
 */
export function ackState(d: ReviewDetail | null | undefined, permissions: readonly string[]): { offer: boolean; required: boolean; reason?: string } {
  if (!d) return { offer: false, required: false, reason: 'No review detail is available.' };
  const required = d.manualReview === true;
  if (!permissions.includes('marketplace.review')) return { offer: false, required, reason: 'Your role cannot decide on submissions (needs marketplace.review).' };
  if (!['submitted', 'in_review'].includes(String(d.state))) return { offer: false, required, reason: `This version is ${String(d.state).replace(/_/g, ' ')}; only submitted or in-review versions can be approved.` };
  if (!required) return { offer: false, required, reason: 'This type does not need an acknowledgement: approve it from the version page.' };
  if (d.summary?.truncated === true) return { offer: false, required, reason: 'The review summary is larger than can be shown. It cannot be approved from here.' };
  if (!isSha256(d.summarySha256)) return { offer: false, required, reason: 'The server did not return a valid summary hash.' };
  return { offer: true, required };
}

/** The body the approve action posts, or why it must not post. The checkbox is not optional and the hash must be the one that was on screen. */
export function approvalRequest(f: { reviewed?: string; ack?: string }): { ok: true; body: { ack_summary_sha256: string } } | { ok: false; error: string } {
  if (f.reviewed !== 'on' && f.reviewed !== 'true') return { ok: false, error: 'Tick "I reviewed this summary" first.' };
  const ack = (f.ack ?? '').trim().toLowerCase();
  if (!isSha256(ack)) return { ok: false, error: 'The summary hash is missing or malformed; reload the page.' };
  return { ok: true, body: { ack_summary_sha256: ack } };
}

/** At most `n` risk labels, then "+k more", so a long list never pushes a table out of shape. */
export function riskPreview(list: readonly string[] | null | undefined, n = 3): { shown: string[]; more: number } {
  const xs = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  return { shown: xs.slice(0, n), more: Math.max(0, xs.length - n) };
}
export const tierTone = (t: string | null | undefined) => (t === 'executable' ? 'failed' : t === 'declarative' ? 'pending' : t === 'data' ? 'active' : '');

/** A halt needs moderate, a typed confirmation of the type name and a reason; the API requires the reason and the permission again. */
export function haltRequest(f: { type?: string; confirm?: string; reason?: string }): { ok: true; type: string; reason: string } | { ok: false; error: string } {
  const type = (f.type ?? '').trim();
  if (!(LISTING_TYPES as readonly string[]).includes(type)) return { ok: false, error: 'Unknown type.' };
  if ((f.confirm ?? '').trim() !== type) return { ok: false, error: `Type "${type}" in the confirmation box to halt it.` };
  const reason = (f.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, error: 'A reason of at least 3 characters is required.' };
  if (reason.length > 1000) return { ok: false, error: 'The reason is too long (1000 characters at most).' };
  return { ok: true, type, reason };
}

const TIER_RANK: Record<string, number> = { data: 0, declarative: 1, executable: 2 };
const TRUST_RANK: Record<string, number> = { private: 0, community: 1, verified: 2, official: 3 };
/** What a policy form may submit: values at or above the floor the server reported. The API enforces the floor; this only avoids offering the impossible. */
export function policyChange(floor: { riskTier: string; manualReview: boolean; minPublisherTrust: string }, f: { riskTier?: string; manualReview?: string; minPublisherTrust?: string; reason?: string }):
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const reason = (f.reason ?? '').trim();
  if (reason.length < 3) return { ok: false, error: 'A reason of at least 3 characters is required.' };
  const riskTier = f.riskTier ?? '', trust = f.minPublisherTrust ?? '';
  if (!(riskTier in TIER_RANK) || !(trust in TRUST_RANK)) return { ok: false, error: 'Choose a risk tier and a minimum publisher trust.' };
  const manualReview = f.manualReview === 'on' || f.manualReview === 'true';
  if (TIER_RANK[riskTier] < TIER_RANK[floor.riskTier]) return { ok: false, error: `The risk tier cannot be below ${floor.riskTier}.` };
  if (floor.manualReview && !manualReview) return { ok: false, error: 'Manual review cannot be switched off for this type.' };
  if (TRUST_RANK[trust] < TRUST_RANK[floor.minPublisherTrust]) return { ok: false, error: `The minimum publisher trust cannot be below ${floor.minPublisherTrust}.` };
  return { ok: true, body: { riskTier, manualReview, minPublisherTrust: trust, reason } };
}

export interface TypeStats { type: string; installs: number; failedInstalls: number; failureRate: number | null; activeInstalls: number; uninstalls: number; revokes: number; quarantines: number; awaitingConfiguration: number; awaitingConfigurationRate: number | null; publishedListings: number; failedReasons: Array<{ reason: string; count: number }> }
/** Rows for the by-type table. Types with no activity are kept (a zero is a fact); the order is the API's. Malformed rows are dropped, never guessed. */
export function typeRows(d: { byType?: unknown } | null | undefined): TypeStats[] {
  if (!d || !Array.isArray(d.byType)) return [];
  return (d.byType as any[]).filter((r) => r && typeof r.type === 'string').map((r) => ({
    type: r.type, installs: Number(r.installs) || 0, failedInstalls: Number(r.failedInstalls) || 0, failureRate: r.failureRate == null ? null : Number(r.failureRate), activeInstalls: Number(r.activeInstalls) || 0,
    uninstalls: Number(r.uninstalls) || 0, revokes: Number(r.revokes) || 0, quarantines: Number(r.quarantines) || 0, awaitingConfiguration: Number(r.awaitingConfiguration) || 0,
    awaitingConfigurationRate: r.awaitingConfigurationRate == null ? null : Number(r.awaitingConfigurationRate), publishedListings: Number(r.publishedListings) || 0,
    failedReasons: Array.isArray(r.failedReasons) ? r.failedReasons.filter((x: any) => x && typeof x.reason === 'string').map((x: any) => ({ reason: x.reason, count: Number(x.count) || 0 })) : [],
  }));
}

/** Whether the viewer holds a permission; used by server actions as a second check before any mutating call (the API checks it a third time). */
export const hasPermission = (permissions: readonly string[] | null | undefined, p: string) => Array.isArray(permissions) && permissions.includes(p);

export interface InstallBurst { listingId: string; installs: number; accounts: number; firstAt: string | null; lastAt: string | null }
/** Rows of the "Suspicious install bursts" report. Malformed rows are dropped, numbers coerced, text left as text (React escapes it). */
export function burstRows(d: { bursts?: unknown } | null | undefined): InstallBurst[] {
  if (!d || !Array.isArray(d.bursts)) return [];
  return (d.bursts as any[]).filter((b) => b && typeof b.listingId === 'string').map((b) => ({
    listingId: b.listingId, installs: Number(b.installs) || 0, accounts: Number(b.accounts) || 0,
    firstAt: typeof b.firstAt === 'string' ? b.firstAt : null, lastAt: typeof b.lastAt === 'string' ? b.lastAt : null }));
}
