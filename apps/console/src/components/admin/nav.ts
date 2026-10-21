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
