// Shared fixtures for the bundle tests: a fake CatalogView over an in-memory table and a package builder.
import { sha256Hex } from '../../src/marketplace/artifacts.ts';
import type { CatalogView } from '../../src/marketplace/blueprint/catalogView.ts';
import type { MemberInfo } from '../../src/marketplace/bundle/plan.ts';
import type { BundleV1 } from '../../src/marketplace/bundle/schema.ts';
import type { ManifestV1, PermissionRequest, UnpackedPackage } from '../../src/marketplace/types.ts';

export const H = (s: string) => sha256Hex(new TextEncoder().encode(s));
export function member(id: string, o: Partial<MemberInfo> = {}): MemberInfo {
  const version = o.version ?? '1.0.0';
  return { id, range: `=${version}`, version, versionId: `v-${id}-${version}`, sha256: H(`${id}@${version}`), type: 'skill', visibility: 'public', teamId: null,
    state: 'published', scanVerdict: 'clean', permissions: [], dependencies: [], compatApp: '^1.0.0', ...o };
}
export function catalogOf(members: MemberInfo[], hidden: string[] = []): CatalogView {
  return { async resolve(ref) {
    const m = members.find((x) => x.id === ref.id && ref.range === `=${x.version}`);
    if (hidden.includes(ref.id)) return { error: 'not_visible' };
    return m ? { ...m } : { error: 'not_found' };
  } };
}
export const itemOf = (m: MemberInfo) => ({ id: m.id, type: m.type as 'skill', version: m.version, sha256: m.sha256 });
export function bundleOf(ms: MemberInfo[], o: Partial<BundleV1> = {}): BundleV1 {
  return { schema: 'agentic.bundle/1', items: ms.map(itemOf), installOrder: ms.map((m) => m.id), teamScope: { kind: 'none' }, ...o };
}
export function pkgOf(b: unknown, o: { id?: string; permissions?: PermissionRequest[]; deps?: Array<{ id: string; range: string }>; extra?: Record<string, Uint8Array>; compat?: string; payload?: Record<string, unknown> } = {}): UnpackedPackage {
  const files = new Map<string, Uint8Array>([['bundle.json', new TextEncoder().encode(typeof b === 'string' ? b : JSON.stringify(b))], ...Object.entries(o.extra ?? {})]);
  const items = (b as BundleV1)?.items ?? [];
  const manifest: ManifestV1 = { schema: 'agentic.marketplace/1', id: o.id ?? 'acme/starter-pack', type: 'bundle', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
    compat: { app: o.compat ?? '^1.0.0' }, dependencies: o.deps ?? items.map((i) => ({ id: i.id, range: `=${i.version}` })), permissions: o.permissions ?? [],
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), size: bytes.length })), payload: o.payload ?? {} };
  return { files, manifest };
}
