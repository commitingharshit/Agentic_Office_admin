// What each kind of admin may do. The API checks this before any handler runs; the console only uses it to hide buttons.
// users.role = 'admin' makes someone an admin at all; an admin without an admin_roles row is a superadmin (how it worked before roles).
export const ADMIN_ROLES = ['superadmin', 'engineer', 'support', 'finance', 'analyst'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  'overview.read', 'users.read', 'users.export', 'users.write', 'users.delete', 'roles.read', 'roles.write',
  'credits.read', 'credits.write', 'coupons.read', 'coupons.write', 'plans.read', 'plans.write',
  'sessions.read', 'runs.read', 'usage.read', 'analytics.read', 'audit.read', 'sql.read', 'settings.read',
  'payments.read', 'payments.write', 'infra.read', 'flags.read', 'flags.write', 'comms.read', 'comms.write', 'support.read', 'support.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const set = (...p: Permission[]) => new Set<Permission>(p);
const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  superadmin: new Set(PERMISSIONS),
  // Keeps the product running: sees everything technical, changes flags, reads SQL; touches no money and no accounts.
  engineer: set('overview.read', 'users.read', 'roles.read', 'sessions.read', 'runs.read', 'usage.read', 'analytics.read', 'audit.read', 'sql.read',
    'settings.read', 'infra.read', 'flags.read', 'flags.write', 'support.read', 'payments.read'),
  // Helps customers: account actions and messages, no money changes, no deleting, no roles.
  support: set('overview.read', 'users.read', 'users.export', 'users.write', 'sessions.read', 'runs.read', 'credits.read', 'coupons.read', 'plans.read',
    'comms.read', 'comms.write', 'support.read', 'support.write', 'audit.read', 'flags.read', 'payments.read'),
  // Money: credits, coupons, plans, usage; reads accounts, changes none.
  finance: set('overview.read', 'users.read', 'credits.read', 'credits.write', 'coupons.read', 'coupons.write', 'plans.read', 'plans.write', 'payments.read', 'payments.write',
    'usage.read', 'analytics.read', 'audit.read'),
  // Read-only product intelligence.
  analyst: set('overview.read', 'users.read', 'sessions.read', 'runs.read', 'usage.read', 'analytics.read', 'infra.read', 'flags.read', 'plans.read', 'coupons.read'),
};

export const isAdminRole = (v: unknown): v is AdminRole => typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
export const can = (role: AdminRole, p: Permission): boolean => ROLE_PERMISSIONS[role].has(p);
export const permissionsOf = (role: AdminRole): Permission[] => [...ROLE_PERMISSIONS[role]].sort();
