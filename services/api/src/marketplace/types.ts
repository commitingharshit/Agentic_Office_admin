export const LISTING_TYPES = ['template','skill','agent','memory','connector','bridge','surface','workflow','hook','routine','bundle'] as const;
export type ListingType = typeof LISTING_TYPES[number];
export type Visibility = 'public' | 'org' | 'team' | 'private';
export type Trust = 'official' | 'verified' | 'community' | 'private';          // shown on cards
export type VersionState = 'draft'|'validating'|'testing'|'submitted'|'in_review'|'approved'|'published'|'rejected'|'deprecated'|'quarantined'|'revoked';
export type InstallState = 'requested'|'permission_review'|'installed'|'configured'|'enabled'|'disabled'|'update_available'|'failed'|'uninstalled';

export interface ManifestV1 {                // one JSON file, `agentic.marketplace.json`, at package root
  schema: 'agentic.marketplace/1';
  id: string;                                // `publisher/slug`, lowercase [a-z0-9-]
  type: ListingType;
  version: string;                           // semver
  title: string; summary: string; license: string;
  compat: { app: string; hermes?: string };  // semver ranges
  dependencies: { id: string; range: string }[];
  permissions: PermissionRequest[];          // declared capabilities, shown before install
  files: { path: string; sha256: string; size: number }[];
  payload: Record<string, unknown>;          // type-specific, validated by validate/<type>.ts
}
export interface PermissionRequest { capability: 'fs.workspace.read'|'fs.workspace.write'|'network'|'exec.script'|'tool.invoke'|'secrets.use'; scope: string; reason: string }

/** An unpacked package: path -> bytes. Paths are already normalized and safe (Task 3 produces this). */
export interface UnpackedPackage { files: Map<string, Uint8Array>; manifest: ManifestV1 }

export interface ValidationCheck { name: string; ok: boolean; detail?: string }
export interface ValidationReport { ok: boolean; checks: ValidationCheck[] }
