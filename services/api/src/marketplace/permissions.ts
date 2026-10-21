// Marketplace admin permissions. This branch has no rbac.ts (it lives in the control-plane checkout), so this
// module declares the SAME SHAPE the rest of the admin code uses: ADMIN_ROLES, can(role, permission) and
// permissionsOf(role). When rbac.ts lands, replace the body of this file with a re-export of the marketplace
// entries from it (or fold MARKETPLACE_PERMISSIONS into its permission table); nothing else needs to change,
// because src/api/marketplace-admin.ts only calls can() and permissionsOf().
export const ADMIN_ROLES = ['superadmin', 'engineer', 'support', 'finance', 'analyst'] as const;
export type AdminRole = typeof ADMIN_ROLES[number];

export const MARKETPLACE_PERMISSIONS = ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate'] as const;
export type MarketplacePermission = typeof MARKETPLACE_PERMISSIONS[number];

const GRANTS: Record<AdminRole, readonly MarketplacePermission[]> = {
  superadmin: MARKETPLACE_PERMISSIONS,
  engineer: ['marketplace.read', 'marketplace.write', 'marketplace.review'],
  analyst: ['marketplace.read'],
  support: [],
  finance: [],
};

export const isAdminRole = (v: unknown): v is AdminRole => typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
export const permissionsOf = (role: AdminRole): readonly MarketplacePermission[] => GRANTS[role] ?? [];
export const can = (role: AdminRole, permission: MarketplacePermission): boolean => permissionsOf(role).includes(permission);
