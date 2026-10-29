// What an admin_audit row is about. The table has always carried target_user_id; target_type / target_id (migration 0034) name any other
// thing an administrator touched (a payment, a ticket, a campaign, a marketplace version, ...), so an entity's history can be listed
// from one index. One place decides it, from the action and the detail the caller already writes, so no call site changes.

export interface AuditEntity { type: string; id: string }

type Detail = Record<string, unknown>;
const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

// Actions whose subject is named by a generic key (`id`, `code`, ...). The first match wins.
const BY_ACTION: Array<[RegExp, string, string]> = [
  [/_ticket$/, 'ticket', 'id'],
  [/announcement$/, 'announcement', 'id'],
  [/^(create|update)_plan$/, 'plan', 'id'],
  [/^(invite_admin|revoke_admin_invite)$/, 'admin_invite', 'email'],
  [/_flag$/, 'flag', 'key'],
  [/_coupon$/, 'coupon', 'code'],
  [/^(approve|decline)_access$/, 'access_request', 'request'],
];

// Keys that name their own kind of thing, most specific first: a marketplace version beats the listing it belongs to.
const BY_KEY: Array<[string, string]> = [
  ['versionId', 'marketplace_version'],
  ['jobId', 'marketplace_job'],
  ['reportId', 'marketplace_report'],
  ['reviewId', 'marketplace_review'],
  ['publisherId', 'marketplace_publisher'],
  ['listingId', 'marketplace_listing'],
  ['campaign', 'campaign'],
  ['release', 'release'],
  ['creative', 'creative'],
  ['template', 'email_template'],
  ['order', 'payment'],
];

/** The subject of an audit row, or null for an action that has none (a list, an overview, a denied request). */
export function deriveEntity(action: string, targetUserId: string | null, detail: Detail = {}): AuditEntity | null {
  if (targetUserId) return { type: 'user', id: targetUserId };
  const a = action.replace(/^marketplace\./, '');
  for (const [re, type, key] of BY_ACTION) {
    if (re.test(a)) { const id = str(detail[key]); if (id) return { type, id }; }
  }
  for (const [key, type] of BY_KEY) {
    const id = str(detail[key]);
    if (id) return { type, id };
  }
  return null;
}
