// The production CatalogView (blueprint/catalogView.ts): resolves a `publisher/slug` + semver range to ONE published version, with
// the facts the agent and bundle validators need (permissions, dependencies, hash, scan verdict, compat, tier, trust, and for an
// agent its parsed blueprint). Two modes, both fail closed:
//   'rls'       the connection is a caller-scoped ao_app client (app.user_id set, inside withUser): row-level security decides
//               what the caller can see, nothing here re-implements visibility. A listing the caller cannot see and one that
//               does not exist are the SAME answer (`not_found`): the resolver is no existence oracle for private listings.
//   'audience'  for the admin submission path, which has no caller: a connection WITHOUT row-level security, so the view
//               applies the audience rule itself (public and org listings, plus the audience team's own). Private listings
//               are never resolved in this mode.
import type pg from 'pg';
import { extractOne, sha256Hex, type ArtifactStore } from './artifacts.ts';
import type { CatalogView, ResolveError, ResolvedRef } from './blueprint/catalogView.ts';
import { BLUEPRINT_LIMITS } from './blueprint/limits.ts';
import { blueprintFileName, parseBlueprintText, type AgentBlueprint, type Ref } from './blueprint/schema.ts';
import { compareSemver, isRange, satisfies } from './manifest.ts';
import { withUser } from './store.ts';
import type { ListingType, PermissionRequest, RiskTier, Trust, Visibility } from './types.ts';

export type CatalogMember = ResolvedRef & { compatApp?: string; riskTier?: RiskTier; trust?: Trust };
export interface CatalogViewOptions {
  mode: 'rls' | 'audience';
  /** Needed to load a child agent's blueprint; without it an agent resolves without `blueprint` (the validator then cannot follow delegation). */
  store?: ArtifactStore;
}
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const CAPS = new Set(['fs.workspace.read', 'fs.workspace.write', 'network', 'exec.script', 'tool.invoke', 'secrets.use']);
const MAX_CANDIDATES = 400;

function permissionsOf(manifest: any): PermissionRequest[] {
  const out: PermissionRequest[] = [];
  const list = Array.isArray(manifest?.permissions) ? manifest.permissions.slice(0, 64) : [];
  for (const p of list) {
    if (p && typeof p === 'object' && typeof p.capability === 'string' && CAPS.has(p.capability)) {
      out.push({ capability: p.capability, scope: typeof p.scope === 'string' ? p.scope.slice(0, 300) : '', reason: typeof p.reason === 'string' ? p.reason.slice(0, 300) : '' });
    }
  }
  return out;
}

async function loadBlueprint(store: ArtifactStore | undefined, sha256: string): Promise<AgentBlueprint | undefined> {
  if (!store) return undefined;
  try {
    const bytes = await store.get(sha256);
    if (!bytes || sha256Hex(bytes) !== sha256) return undefined;
    const raw = extractOne(bytes, blueprintFileName, { maxBytes: BLUEPRINT_LIMITS.maxBytes });
    if (!raw) return undefined;
    return parseBlueprintText(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch { return undefined; }
}

export function createCatalogView(db: Q, opts: CatalogViewOptions): CatalogView {
  return {
    async resolve(ref: Ref, o: { forVisibility: Visibility; forTeamId: string | null }): Promise<CatalogMember | { error: ResolveError }> {
      if (typeof ref?.id !== 'string' || typeof ref?.range !== 'string' || !isRange(ref.range)) return { error: 'unsatisfiable' };
      const l = (await db.query(`SELECT id, type, visibility, team_id, trust FROM marketplace_listings WHERE id = $1`, [ref.id])).rows[0];
      if (!l) return { error: 'not_found' };
      if (opts.mode === 'audience') {
        const teamOk = l.visibility === 'team' && o.forVisibility === 'team' && o.forTeamId !== null && l.team_id === o.forTeamId;
        if (!(l.visibility === 'public' || l.visibility === 'org' || teamOk)) return { error: 'not_found' };
      }
      const vs = (await db.query(
        `SELECT id, version, sha256, state, scan_verdict, manifest, risk_tier FROM marketplace_versions
          WHERE listing_id = $1 AND state = 'published' ORDER BY semver_major DESC, semver_minor DESC, semver_patch DESC, created_at DESC LIMIT ${MAX_CANDIDATES}`, [ref.id])).rows;
      if (!vs.length) return { error: 'not_installable' };
      let best: any;
      for (const v of vs) {
        if (!satisfies(v.version, ref.range)) continue;
        if (!best || compareSemver(v.version, best.version) > 0) best = v;
      }
      if (!best) return { error: 'unsatisfiable' };
      const deps = (await db.query(`SELECT depends_on_listing AS id, range FROM marketplace_dependencies WHERE version_id = $1 ORDER BY 1 LIMIT 200`, [best.id])).rows;
      const m = best.manifest ?? {};
      const type = l.type as ListingType;
      const row: CatalogMember = {
        id: l.id, range: ref.range, version: best.version, versionId: best.id, sha256: best.sha256, type,
        visibility: l.visibility, teamId: l.team_id ?? null, state: best.state, scanVerdict: best.scan_verdict,
        permissions: permissionsOf(m), dependencies: deps.map((d) => ({ id: d.id, range: d.range })),
        ...(type === 'skill' && typeof m?.payload?.name === 'string' ? { skillName: m.payload.name } : {}),
        ...(typeof m?.compat?.app === 'string' ? { compatApp: m.compat.app } : {}),
        ...(best.risk_tier ? { riskTier: best.risk_tier } : {}),
        ...(l.trust ? { trust: l.trust } : {}),
      };
      if (type === 'agent') {
        const bp = await loadBlueprint(opts.store, best.sha256);
        if (!bp) return { error: 'not_installable' };   // an agent whose blueprint cannot be read is not something to build on
        row.blueprint = bp;
      }
      return row;
    },
  };
}

/** A caller-scoped view: runs `fn` as ao_app with app.user_id set, so the view only sees what the caller can. */
export function withCallerCatalog<T>(app: pg.Pool, uid: string, store: ArtifactStore | undefined, fn: (view: CatalogView) => Promise<T>): Promise<T> {
  return withUser(app, uid, (c) => fn(createCatalogView(c, { mode: 'rls', store })));
}

/** The admin submission path's view (no caller): the audience rule is applied in SQL by the view itself. Pass the ao_admin pool. */
export function audienceCatalog(admin: pg.Pool, store: ArtifactStore | undefined): CatalogView {
  return createCatalogView({ query: (sql, params) => admin.query(sql, params as unknown[]) }, { mode: 'audience', store });
}
