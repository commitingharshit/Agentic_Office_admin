import type { IconName } from './Icon';

export interface NavItem { href: string; label: string; icon: IconName; perm: string; soon?: boolean }
export interface NavGroup { label: string; items: NavItem[] }

/** The console's pages. `perm` is the permission that shows the item; the API enforces it again on every call. `soon` pages say plainly what is missing. */
export const NAV: NavGroup[] = [
  { label: 'Workspace', items: [
    { href: '/admin', label: 'Overview', icon: 'overview', perm: 'overview.read' },
    { href: '/admin/users', label: 'Users', icon: 'users', perm: 'users.read' },
    { href: '/admin/sessions', label: 'Sessions', icon: 'sessions', perm: 'sessions.read' },
    { href: '/admin/runs', label: 'Agent Runs', icon: 'runs', perm: 'runs.read' },
  ] },
  { label: 'Business', items: [
    { href: '/admin/billing', label: 'Billing & Plans', icon: 'billing', perm: 'plans.read' },
    { href: '/admin/payments', label: 'Payments', icon: 'billing', perm: 'payments.read' },
    { href: '/admin/compute', label: 'Compute & Credits', icon: 'compute', perm: 'usage.read' },
    { href: '/admin/coupons', label: 'Coupons', icon: 'coupons', perm: 'coupons.read' },
    { href: '/admin/communications', label: 'Communications', icon: 'comms', perm: 'comms.read' },
  ] },
  { label: 'Marketplace', items: [
    { href: '/admin/marketplace', label: 'Overview', icon: 'overview', perm: 'marketplace.read' },
    { href: '/admin/marketplace/catalog', label: 'Catalog', icon: 'inbox', perm: 'marketplace.read' },
    { href: '/admin/marketplace/publish', label: 'Publish New', icon: 'plus', perm: 'marketplace.write' },
    { href: '/admin/marketplace/submissions', label: 'Submissions', icon: 'inbox', perm: 'marketplace.read' },
    { href: '/admin/marketplace/review', label: 'Review Queue', icon: 'check', perm: 'marketplace.review' },
    { href: '/admin/marketplace/installations', label: 'Installations', icon: 'device', perm: 'marketplace.read' },
    { href: '/admin/marketplace/analytics', label: 'Usage Analytics', icon: 'analytics', perm: 'marketplace.read' },
    { href: '/admin/marketplace/reviews', label: 'Ratings & Reviews', icon: 'support', perm: 'marketplace.read' },
    { href: '/admin/marketplace/publishers', label: 'Publishers', icon: 'users', perm: 'marketplace.read' },
    { href: '/admin/marketplace/collections', label: 'Agents & Bundles', icon: 'gift', perm: 'marketplace.read' },
    { href: '/admin/marketplace/team-assignments', label: 'Team Assignments', icon: 'users', perm: 'marketplace.read' },
    { href: '/admin/marketplace/policies', label: 'Install Policy', icon: 'security', perm: 'marketplace.policy' },
    { href: '/admin/marketplace/releases', label: 'Versions & Releases', icon: 'clock', perm: 'marketplace.read' },
    { href: '/admin/marketplace/security', label: 'Security Reports', icon: 'reliability', perm: 'marketplace.read' },
    { href: '/admin/marketplace/advanced', label: 'Advanced Types', icon: 'alert', perm: 'marketplace.read' },
    { href: '/admin/marketplace/type-policy', label: 'Type Policy', icon: 'settings', perm: 'marketplace.policy' },
    { href: '/admin/marketplace/settings', label: 'Settings', icon: 'settings', perm: 'marketplace.read' },
  ] },
  { label: 'Growth', items: [
    { href: '/admin/growth', label: 'Growth overview', icon: 'analytics', perm: 'growth.read' },
    { href: '/admin/growth/campaigns', label: 'Campaigns', icon: 'comms', perm: 'growth.read' },
    { href: '/admin/growth/email', label: 'Campaign email', icon: 'comms', perm: 'growth.read' },
    { href: '/admin/growth/releases', label: 'Releases', icon: 'flags', perm: 'growth.read' },
  ] },
  { label: 'Intelligence', items: [
    { href: '/admin/analytics', label: 'Product Analytics', icon: 'analytics', perm: 'analytics.read' },
    { href: '/admin/reliability', label: 'Reliability', icon: 'reliability', perm: 'runs.read' },
    { href: '/admin/support', label: 'Support', icon: 'support', perm: 'support.read' },
  ] },
  { label: 'System', items: [
    { href: '/admin/flags', label: 'Feature Flags', icon: 'flags', perm: 'flags.read' },
    { href: '/admin/infrastructure', label: 'Infrastructure', icon: 'infra', perm: 'infra.read' },
    { href: '/admin/notifications', label: 'Notifications', icon: 'alert', perm: 'overview.read' },
    { href: '/admin/audit', label: 'Security & Audit', icon: 'security', perm: 'audit.read' },
    { href: '/admin/access', label: 'Access requests', icon: 'key', perm: 'roles.read' },
    { href: '/admin/settings', label: 'Settings', icon: 'settings', perm: 'roles.read' },
  ] },
];

export const visibleNav = (permissions: string[]): NavGroup[] =>
  NAV.map((g) => ({ ...g, items: g.items.filter((i) => permissions.includes(i.perm)) })).filter((g) => g.items.length);
