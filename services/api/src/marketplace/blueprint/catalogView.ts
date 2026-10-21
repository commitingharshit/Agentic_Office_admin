import type { ListingType, PermissionRequest, VersionState, Visibility } from '../types.ts';
import type { AgentBlueprint, Ref } from './schema.ts';

export interface ResolvedRef {
  id: string; range: string; version: string; versionId: string; sha256: string; type: ListingType;
  visibility: Visibility; teamId: string | null; state: VersionState; scanVerdict: 'clean' | 'warnings';
  permissions: PermissionRequest[]; dependencies: Ref[]; skillName?: string; blueprint?: AgentBlueprint;
}
export type ResolveError = 'not_found' | 'not_visible' | 'unsatisfiable' | 'not_installable' | 'type_mismatch';

/** Always constructed from a caller-scoped (RLS) connection: never from the admin pool. */
export interface CatalogView {
  resolve(ref: Ref, opts: { forVisibility: Visibility; forTeamId: string | null }): Promise<ResolvedRef | { error: ResolveError }>;
}
