// Marketplace admin permissions. This branch has no rbac.ts (it lives in the control-plane checkout), so this
// module declares the SAME SHAPE the rest of the admin code uses: ADMIN_ROLES, can(role, permission) and
// permissionsOf(role). When rbac.ts lands, replace the body of this file with a re-export of the marketplace
// entries from it (or fold MARKETPLACE_PERMISSIONS into its permission table); nothing else needs to change,
// because src/api/marketplace-admin.ts only calls can() and permissionsOf().
export const ADMIN_ROLES = ['superadmin', 'engineer', 'support', 'finance', 'analyst'] as const;
export type AdminRole = typeof ADMIN_ROLES[number];

export const MARKETPLACE_PERMISSIONS = ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate', 'marketplace.policy'] as const;
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

/** `adminName:role,adminName:role` (AO_MARKETPLACE_ROLES). Throws on a malformed entry or an unknown role; empty/undefined is an empty map. */
export function parseRoleMap(spec: string | undefined): Map<string, AdminRole> {
  const m = new Map<string, AdminRole>();
  for (const part of (spec ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.lastIndexOf(':');
    const name = i > 0 ? part.slice(0, i).trim() : '', role = i > 0 ? part.slice(i + 1).trim() : '';
    if (!name) throw new Error(`AO_MARKETPLACE_ROLES entry ${JSON.stringify(part)} must be adminName:role`);
    if (!isAdminRole(role)) throw new Error(`AO_MARKETPLACE_ROLES: unknown role ${JSON.stringify(role)} for ${name} (one of ${ADMIN_ROLES.join(', ')})`);
    m.set(name, role);
  }
  return m;
}
