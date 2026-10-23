// What an audit row or a palette entry points at: the kinds services/api/src/api/audit-entity.ts writes, and the page that shows each.

export const ENTITY_LABEL: Record<string, string> = {
  user: 'User', payment: 'Payment', ticket: 'Ticket', announcement: 'Announcement', plan: 'Plan', flag: 'Flag', coupon: 'Coupon',
  access_request: 'Access request', admin_invite: 'Admin invite', campaign: 'Campaign', release: 'Release', creative: 'Creative',
  email_template: 'Email template', marketplace_version: 'Version', marketplace_listing: 'Listing', marketplace_report: 'Report',
  marketplace_review: 'Review', marketplace_publisher: 'Publisher', marketplace_job: 'Verify job',
};

const enc = encodeURIComponent;

/** The page that shows this thing: its own page when it has one, else the list it lives in (never a dead link). */
export function entityHref(type: string | null | undefined, id: string | null | undefined): string | null {
  if (!type) return null;
  const i = id ? enc(id) : '';
  switch (type) {
    case 'user': return i ? `/admin/users/${i}` : null;
    case 'payment': return i ? `/admin/payments/${i}` : null;
    case 'ticket': return i ? `/admin/support/${i}` : null;
    case 'campaign': return i ? `/admin/growth/campaigns/${i}` : '/admin/growth/campaigns';
    case 'creative': return '/admin/growth/campaigns';
    case 'release': return '/admin/growth/releases';
    case 'email_template': return '/admin/growth/email';
    case 'marketplace_version': return i ? `/admin/marketplace/versions/${i}` : null;
    case 'marketplace_listing': return i ? `/admin/marketplace/catalog?q=${i}` : '/admin/marketplace/catalog';
    case 'marketplace_report': return '/admin/marketplace/security';
    case 'marketplace_review': return '/admin/marketplace/reviews';
    case 'marketplace_publisher': return '/admin/marketplace/publishers';
    case 'marketplace_job': return '/admin/marketplace/review';
    case 'coupon': return '/admin/coupons';
    case 'flag': return '/admin/flags';
    case 'plan': return '/admin/billing';
    case 'announcement': return '/admin/communications';
    case 'access_request': case 'admin_invite': return '/admin/access';
    default: return null;
  }
}

/** The audit trail of one thing. */
export const trailHref = (type: string, id: string) => `/admin/audit?targetType=${enc(type)}&targetId=${enc(id)}`;

/** Breadcrumb text for an id segment: the kind of page it is under, then a short id, so "/users/usr_8f3…" reads "User usr_8f3…". */
const SECTION_NOUN: Record<string, string> = {
  users: 'User', payments: 'Payment', runs: 'Run', sessions: 'Session', support: 'Ticket', campaigns: 'Campaign', versions: 'Version', review: 'Review', evidence: 'Evidence',
};
export function crumbLabel(parent: string | undefined, seg: string): string {
  const short = seg.length > 14 ? `${seg.slice(0, 14)}…` : seg;
  const noun = parent ? SECTION_NOUN[parent] : undefined;
  return noun ? `${noun} ${short}` : short;
}
