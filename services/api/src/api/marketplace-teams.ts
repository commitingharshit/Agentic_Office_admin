// Team assignments, install policy and install-time re-resolution (/v1/marketplace/*), Plan 2 Task 7.
//   GET    policy/effective                         the policy layers that apply to the caller (org + their teams)
//   GET    teams/:id/assignments                    members: what the team pinned, and whether a pin was pulled
//   POST   teams/:id/assignments                    team owner/admin: pin an exact published version (the server reads version and hash)
//   DELETE teams/:id/assignments/:publisher/:slug   team owner/admin
//   GET|PUT teams/:id/policy                        read: members; write: team owner/admin
//   POST   resolve                                  re-resolve references at install time (TOCTOU), as the caller
//   GET    versions/:vid/plan                       server-side plan of a bundle version for the caller (policy applied)
// Every handler runs as ao_app with app.user_id set (row-level security is the authority; the API checks first so a refusal is
// a clean 403/404 and changes nothing). A team the caller is not in answers 404 exactly like a team that does not exist.
// Every mutation writes a marketplace_team_audit row in the SAME transaction.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { extractOne, sha256Hex, type ArtifactStore } from '../marketplace/artifacts.ts';
import { createCatalogView, type CatalogMember } from '../marketplace/catalog.ts';
import type { CatalogView } from '../marketplace/blueprint/catalogView.ts';
import { BLUEPRINT_LIMITS } from '../marketplace/blueprint/limits.ts';
import { resolveRefs } from '../marketplace/blueprint/resolve.ts';
import { blueprintFileName, parseBlueprintText } from '../marketplace/blueprint/schema.ts';
import { BUNDLE_FILE, BUNDLE_LIMITS, parseBundleText } from '../marketplace/bundle/schema.ts';
import { planBundle } from '../marketplace/bundle/plan.ts';
import { isRange } from '../marketplace/manifest.ts';
import { loadEffectivePolicy, type PolicyLayer } from '../marketplace/policy.ts';
import { clientAddress, createLimiter, type Limiter } from '../marketplace/ratelimit.ts';
import { newId, StoreError, withUser } from '../marketplace/store.ts';
import type { Trust } from '../marketplace/types.ts';
import { HttpError, json } from './sync.ts';

export interface TeamsDeps {
  app: pg.Pool;
  authenticate(req: IncomingMessage): Promise<{ uid: string }>;
  /** Needed by `resolve` (a child agent's blueprint) and `versions/:vid/plan` (bundle.json). */
  store?: ArtifactStore;
  /** Mutations: 60 per minute per user by default. */
  limiter?: Limiter;
  /** Reads: 300 per minute per user by default. */
  readLimiter?: Limiter;
  trustedProxyHops?: number;
}

const TEAM_ID = /^team_[a-f0-9]{18}$/;
const LISTING_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_BODY = 128 * 1024;
const MAX_REFS = 64;
const MODES = ['required', 'recommended', 'optional'] as const;
const TRUSTS: readonly Trust[] = ['official', 'verified', 'community', 'private'];
const EFFECTS = ['allow', 'deny'] as const;
const MATCH_KINDS = ['listing', 'publisher', 'type'] as const;
const RULE_VALUE: Record<string, RegExp> = {
  listing: /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
  publisher: /^[a-z0-9][a-z0-9-]*$/,
  type: /^(template|skill|agent|memory|connector|bridge|surface|workflow|hook|routine|bundle)$/,
};
const MAX_RULES = 500;

const bad = (m: string) => new HttpError(400, m);
const notFound = () => new HttpError(404, 'Not found.');
const NOT_ASSIGNABLE = () => new StoreError(422, 'That version cannot be assigned to this team.', 'not_assignable');

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const d: unknown = await json(req, MAX_BODY);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('Body must be a JSON object.');
  return d as Record<string, unknown>;
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${what}: unknown field ${JSON.stringify(k.slice(0, 40))}.`);
}

export interface PolicyDoc { mode: 'open' | 'allowlist'; minTrust: Trust | null; requireCleanScan: boolean; rules: Array<{ effect: 'allow' | 'deny'; matchKind: 'listing' | 'publisher' | 'type'; matchValue: string }> }
/** Strict parse of a policy document (team PUT and org PUT). Unknown fields, duplicates and malformed rules are a 400. */
export function parsePolicyDoc(d: Record<string, unknown>): PolicyDoc {
  onlyKeys(d, ['mode', 'minTrust', 'requireCleanScan', 'rules'], 'policy');
  if (d.mode !== 'open' && d.mode !== 'allowlist') throw bad('mode must be open or allowlist.');
  const minTrust = d.minTrust === undefined || d.minTrust === null ? null : d.minTrust;
  if (minTrust !== null && !(typeof minTrust === 'string' && (TRUSTS as readonly string[]).includes(minTrust))) throw bad(`minTrust must be one of: ${TRUSTS.join(', ')} (or null).`);
  const requireCleanScan = d.requireCleanScan === undefined ? true : d.requireCleanScan;
  if (typeof requireCleanScan !== 'boolean') throw bad('requireCleanScan must be a boolean.');
  const rulesIn = d.rules === undefined ? [] : d.rules;
  if (!Array.isArray(rulesIn)) throw bad('rules must be an array.');
  if (rulesIn.length > MAX_RULES) throw bad(`rules has too many entries (${MAX_RULES} at most).`);
  const seen = new Set<string>();
  const rules = rulesIn.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`rules[${i}] must be an object.`);
    const o = r as Record<string, unknown>;
    onlyKeys(o, ['effect', 'matchKind', 'matchValue'], `rules[${i}]`);
    if (!(EFFECTS as readonly unknown[]).includes(o.effect)) throw bad(`rules[${i}].effect must be allow or deny.`);
    if (!(MATCH_KINDS as readonly unknown[]).includes(o.matchKind)) throw bad(`rules[${i}].matchKind must be listing, publisher or type.`);
    if (typeof o.matchValue !== 'string' || o.matchValue.length > 120 || !RULE_VALUE[o.matchKind as string].test(o.matchValue)) throw bad(`rules[${i}].matchValue is not valid for a ${String(o.matchKind)} rule.`);
    const key = `${o.effect}\u0000${o.matchKind}\u0000${o.matchValue}`;
    if (seen.has(key)) throw bad(`rules[${i}] repeats an earlier rule.`);
    seen.add(key);
    return { effect: o.effect as 'allow' | 'deny', matchKind: o.matchKind as 'listing' | 'publisher' | 'type', matchValue: o.matchValue };
  });
  return { mode: d.mode, minTrust: minTrust as Trust | null, requireCleanScan, rules };
}

const layerView = (l: PolicyLayer) => ({ scopeKind: l.scopeKind, scopeId: l.scopeId, mode: l.mode, minTrust: l.minTrust, requireCleanScan: l.requireCleanScan });

/** Replaces a team's policy and rules in the caller's transaction (RLS lets only a team owner/admin do this). */
export async function writeTeamPolicy(c: pg.PoolClient, uid: string, teamId: string, doc: PolicyDoc): Promise<void> {
  const ex = (await c.query(`SELECT 1 FROM marketplace_policies WHERE scope_kind = 'team' AND scope_id = $1`, [teamId])).rowCount;
  if (ex) await c.query(`UPDATE marketplace_policies SET mode = $2, min_trust = $3, require_clean_scan = $4, updated_by = $5 WHERE scope_kind = 'team' AND scope_id = $1`, [teamId, doc.mode, doc.minTrust, doc.requireCleanScan, uid]);
  else await c.query(`INSERT INTO marketplace_policies(scope_kind, scope_id, mode, min_trust, require_clean_scan, updated_by) VALUES ('team',$1,$2,$3,$4,$5)`, [teamId, doc.mode, doc.minTrust, doc.requireCleanScan, uid]);
  await c.query(`DELETE FROM marketplace_policy_rules WHERE scope_kind = 'team' AND scope_id = $1`, [teamId]);
  for (const r of doc.rules) {
    await c.query(`INSERT INTO marketplace_policy_rules(id, scope_kind, scope_id, effect, match_kind, match_value, created_by) VALUES ($1,'team',$2,$3,$4,$5,$6)`, [newId('pr'), teamId, r.effect, r.matchKind, r.matchValue, uid]);
  }
}

export async function readPolicy(c: pg.PoolClient, kind: 'org' | 'team', scopeId: string): Promise<(PolicyDoc & { configured: boolean; updatedAt: string | null; updatedBy: string | null }) | null> {
  const p = (await c.query(`SELECT mode, min_trust, require_clean_scan, updated_at, updated_by FROM marketplace_policies WHERE scope_kind = $1 AND scope_id = $2`, [kind, scopeId])).rows[0];
  const rules = (await c.query(`SELECT effect, match_kind, match_value FROM marketplace_policy_rules WHERE scope_kind = $1 AND scope_id = $2 ORDER BY effect, match_kind, match_value`, [kind, scopeId])).rows;
  if (!p) return { mode: 'open', minTrust: null, requireCleanScan: true, rules: [], configured: false, updatedAt: null, updatedBy: null };
  return { mode: p.mode, minTrust: p.min_trust ?? null, requireCleanScan: p.require_clean_scan, configured: true, updatedAt: new Date(p.updated_at).toISOString(), updatedBy: p.updated_by ?? null,
    rules: rules.map((r) => ({ effect: r.effect, matchKind: r.match_kind, matchValue: r.match_value })) };
}

const ROUTE = /^(?:policy\/effective|resolve|versions\/[^/]+\/plan|teams\/[^/]+\/(?:assignments(?:\/[^/]+\/[^/]+)?|policy))$/;

export function marketplaceTeamsHandler(deps: TeamsDeps) {
  const limiter = deps.limiter ?? createLimiter();
  const readLimiter = deps.readLimiter ?? createLimiter({ limit: 300 });
  const hops = Math.max(0, Math.floor(deps.trustedProxyHops ?? (Number(process.env.TRUSTED_PROXY_HOPS) || 0)));

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/v1/marketplace/')) return false;
    let rest: string;
    try { rest = decodeURIComponent(url.pathname.slice('/v1/marketplace'.length)).replace(/^\/+/, ''); } catch { return false; }
    if (!ROUTE.test(rest)) return false;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-expose-headers', 'retry-after');
    const m = req.method ?? 'GET';
    if (m === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      res.end();
      return true;
    }
    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!req.headers.authorization) throw new HttpError(401, 'Sign in first.');
      const mutating = m !== 'GET' && m !== 'HEAD' && rest !== 'resolve';
      const lim = mutating ? limiter : readLimiter;
      const limit = (key: string) => { if (!lim.allow(key)) throw new HttpError(429, 'Too many requests. Try again in a minute.', { retryAfter: lim.retryAfter(key) }); };
      const ipKey = `ip:${clientAddress(req, hops)}`;
      let uid = '';
      try { uid = (await deps.authenticate(req)).uid; } catch (e) { limit(ipKey); throw e; }
      limit(uid);
      const q = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withUser(deps.app, uid, fn);

      if (rest === 'policy/effective' && m === 'GET') {
        return send(200, await q(async (c) => {
          const policy = await loadEffectivePolicy(c, uid);
          return {
            layers: policy.layers,
            org: policy.layers.find((l) => l.scopeKind === 'org') ?? null,
            teams: policy.layers.filter((l) => l.scopeKind === 'team').map(layerView),
            rules: policy.layers.flatMap((l) => l.rules.map((r) => ({ scopeKind: l.scopeKind, scopeId: l.scopeId, ...r }))),
          };
        })), true;
      }

      if (rest === 'resolve' && m === 'POST') return send(200, await resolveForInstall(deps, uid, await body(req))), true;

      const vp = /^versions\/([^/]+)\/plan$/.exec(rest);
      if (vp && m === 'GET') {
        if (!OPAQUE_ID.test(vp[1])) throw notFound();
        return send(200, await bundlePlanFor(deps, uid, vp[1], url.searchParams.get('device'))), true;
      }

      const tm = /^teams\/([^/]+)\/(assignments|policy)(?:\/([^/]+\/[^/]+))?$/.exec(rest);
      if (!tm) throw notFound();
      const [, teamId, what, listingId] = tm;
      if (!TEAM_ID.test(teamId)) throw notFound();

      // A non-member and a missing team are the same 404; a member who is not an owner/admin gets 403 on every write.
      const role = await q(async (c) => ({
        member: (await c.query(`SELECT marketplace_is_team_member($1) AS ok`, [teamId])).rows[0].ok === true,
        manager: (await c.query(`SELECT marketplace_is_team_manager($1) AS ok`, [teamId])).rows[0].ok === true,
      }));
      if (!role.member) throw notFound();
      const needManager = () => { if (!role.manager) throw new HttpError(403, 'Only the team owner or an admin can do that.'); };

      if (what === 'assignments' && !listingId && m === 'GET') {
        return send(200, { items: await q((c) => listAssignments(c, teamId, role.manager)) }), true;
      }
      if (what === 'assignments' && !listingId && m === 'POST') {
        needManager();
        const d = await body(req);
        onlyKeys(d, ['listingId', 'versionId', 'mode'], 'assignment');   // pinned_version / pin_sha256 in a body are refused, not ignored
        if (typeof d.listingId !== 'string' || !LISTING_ID.test(d.listingId)) throw bad('listingId is not a valid listing id.');
        if (typeof d.versionId !== 'string' || !OPAQUE_ID.test(d.versionId)) throw bad('versionId is not valid.');
        const mode = d.mode === undefined ? 'recommended' : d.mode;
        if (!(MODES as readonly unknown[]).includes(mode)) throw bad(`mode must be one of: ${MODES.join(', ')}.`);
        const r = await q((c) => assign(c, uid, teamId, d.listingId as string, d.versionId as string, mode as string));
        return send(r.created ? 201 : 200, r.item), true;
      }
      if (what === 'assignments' && listingId && m === 'DELETE') {
        needManager();
        if (!LISTING_ID.test(listingId)) throw notFound();
        return send(200, await q(async (c) => {
          const del = await c.query(`DELETE FROM marketplace_team_assignments WHERE team_id = $1 AND listing_id = $2 RETURNING id, version_id, pinned_version`, [teamId, listingId]);
          if (!del.rowCount) throw notFound();
          await auditTeam(c, teamId, uid, 'unassign', { listingId, versionId: del.rows[0].version_id, pinnedVersion: del.rows[0].pinned_version });
          return { removed: listingId };
        })), true;
      }
      if (what === 'policy' && m === 'GET') return send(200, await q((c) => readPolicy(c, 'team', teamId))), true;
      if (what === 'policy' && m === 'PUT') {
        needManager();
        const doc = parsePolicyDoc(await body(req));
        return send(200, await q(async (c) => {
          await writeTeamPolicy(c, uid, teamId, doc);
          await auditTeam(c, teamId, uid, 'policy_set', { mode: doc.mode, minTrust: doc.minTrust, requireCleanScan: doc.requireCleanScan, rules: doc.rules.length });
          return readPolicy(c, 'team', teamId);
        })), true;
      }
      throw notFound();
    } catch (e: any) {
      let status = 500, message = 'Server error.', extra: Record<string, string> = {}, fields: Record<string, unknown> = {};
      if (e instanceof HttpError) { status = e.status; message = e.message; if (status === 429) extra = { 'retry-after': String(e.extra?.retryAfter ?? 60) }; }
      else if (e instanceof StoreError) { status = e.status; message = e.message; fields = { ...(e.code ? { code: e.code } : {}), ...e.extra }; }
      // The database refused: row-level security (42501) is a 403, anything the guard triggers refuse is the one uniform "cannot be assigned".
      else if (e?.code === '42501') { status = 403; message = 'Not allowed.'; }
      else if (typeof e?.code === 'string' && /^(23|22)/.test(e.code)) { status = 422; message = 'That change was refused.'; fields = { code: 'refused' }; }
      else if (e?.code === 'ECONNRESET' || e?.message === 'aborted') status = 499;
      else console.error(e);
      if (status === 413) extra = { ...extra, connection: 'close' };   // the rest of an oversize body may still be arriving
      if (res.headersSent) { res.end(); return true; }
      send(status, { error: message, ...fields }, extra);
      return true;
    }
  };
}

async function auditTeam(c: pg.PoolClient, teamId: string, actor: string, action: string, detail: Record<string, unknown>) {
  await c.query(`INSERT INTO marketplace_team_audit(team_id, actor, action, detail) VALUES ($1,$2,$3,$4)`, [teamId, actor, action, JSON.stringify(detail)]);
}

async function listAssignments(c: pg.PoolClient, teamId: string, manager: boolean) {
  const rows = (await c.query(`
    SELECT a.id, a.listing_id, a.version_id, a.pinned_version, a.pin_sha256, a.mode, a.assigned_by, a.created_at,
           s.state, s.blocked, s.reason, l.title, l.type
      FROM marketplace_team_assignments a
      LEFT JOIN marketplace_assignment_status() s ON s.assignment_id = a.id
      LEFT JOIN marketplace_listings l ON l.id = a.listing_id
     WHERE a.team_id = $1 ORDER BY a.created_at, a.id LIMIT 500`, [teamId])).rows;
  return rows.map((r) => ({
    id: r.id, teamId, listingId: r.listing_id, title: r.title ?? null, type: r.type ?? null, versionId: r.version_id, pinnedVersion: r.pinned_version,
    pinSha256: r.pin_sha256, mode: r.mode, state: r.state ?? null, blocked: r.blocked === true,
    ...(r.blocked === true ? { reason: 'assignment_blocked', ...(r.reason ? { detail: String(r.reason).slice(0, 300) } : {}) } : {}),
    createdAt: r.created_at, ...(manager ? { assignedBy: r.assigned_by ?? null } : {}),
  }));
}

/** The pin comes from the version row the caller can see, never from the request. Every refusal is the same 422. */
async function assign(c: pg.PoolClient, uid: string, teamId: string, listingId: string, versionId: string, mode: string) {
  const v = (await c.query(`SELECT v.id, v.version, v.sha256 FROM marketplace_versions v WHERE v.id = $1 AND v.listing_id = $2 AND v.state = 'published'`, [versionId, listingId])).rows[0];
  if (!v) throw NOT_ASSIGNABLE();
  const ex = (await c.query(`SELECT id, version_id FROM marketplace_team_assignments WHERE team_id = $1 AND listing_id = $2`, [teamId, listingId])).rows[0];
  let id: string;
  try {
    if (ex) {
      id = ex.id;
      await c.query(`UPDATE marketplace_team_assignments SET version_id = $2, pinned_version = $3, pin_sha256 = $4, mode = $5 WHERE id = $1`, [id, v.id, v.version, v.sha256, mode]);
    } else {
      id = newId('asg');
      await c.query(`INSERT INTO marketplace_team_assignments(id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode, assigned_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, teamId, listingId, v.id, v.version, v.sha256, mode, uid]);
    }
  } catch (e: any) {
    // the guard trigger answers every pin problem with the same integrity error
    if (typeof e?.code === 'string' && e.code.startsWith('23')) throw NOT_ASSIGNABLE();
    throw e;
  }
  await auditTeam(c, teamId, uid, ex ? 'reassign' : 'assign', { listingId, versionId: v.id, pinnedVersion: v.version, pinSha256: v.sha256, mode, ...(ex ? { previousVersionId: ex.version_id } : {}) });
  const item = (await listAssignments(c, teamId, true)).find((a) => a.id === id)!;
  return { created: !ex, item };
}

// ───────────────────────────────────────────────────────── install-time re-resolution

/** Loads a package file of a version the CALLER can see (RLS), checking the bytes against the stored hash. */
async function versionFile(deps: TeamsDeps, c: pg.PoolClient, versionId: string, file: string, max: number): Promise<{ type: string; listingId: string; state: string; bytes: Uint8Array } | undefined> {
  const v = (await c.query(`SELECT v.id, v.sha256, v.state, l.type, l.id AS listing_id FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id WHERE v.id = $1 AND v.state IN ('published','deprecated')`, [versionId])).rows[0];
  if (!v || !deps.store) return undefined;
  const bytes = await deps.store.get(v.sha256);
  if (!bytes || sha256Hex(bytes) !== v.sha256) return undefined;
  let f: Uint8Array | undefined;
  try { f = extractOne(bytes, file, { maxBytes: max }); } catch { return undefined; }
  return f ? { type: v.type, listingId: v.listing_id, state: v.state, bytes: f } : undefined;
}

const memberDto = (r: CatalogMember) => ({
  id: r.id, type: r.type, version: r.version, versionId: r.versionId, sha256: r.sha256, visibility: r.visibility, teamId: r.teamId, state: r.state,
  scanVerdict: r.scanVerdict, permissions: r.permissions, dependencies: r.dependencies, ...(r.skillName ? { skillName: r.skillName } : {}),
  ...(r.compatApp ? { compatApp: r.compatApp } : {}), ...(r.riskTier ? { riskTier: r.riskTier } : {}), ...(r.trust ? { trust: r.trust } : {}),
});

/**
 * Two shapes, exclusive:
 *   { refs: [{id, range}] }       resolve each reference now, as the caller;
 *   { agentVersionId }            resolve every reference of that agent version's blueprint (skills, child agents transitively).
 * The desktop compares the answer with the plan it showed the user and aborts on any difference (TOCTOU).
 */
async function resolveForInstall(deps: TeamsDeps, uid: string, d: Record<string, unknown>) {
  onlyKeys(d, ['refs', 'agentVersionId', 'forTeam'], 'resolve');
  let forTeam: string | null = null;
  if (d.forTeam !== undefined && d.forTeam !== null) {
    if (typeof d.forTeam !== 'string' || !TEAM_ID.test(d.forTeam)) throw bad('forTeam is not a valid team id.');
    forTeam = d.forTeam;
  }
  if ((d.refs === undefined) === (d.agentVersionId === undefined)) throw bad('Send either refs or agentVersionId.');
  return withUser(deps.app, uid, async (c) => {
    // an audience team the caller is not in is the same 404 as one that does not exist
    if (forTeam && (await c.query(`SELECT marketplace_is_team_member($1) AS ok`, [forTeam])).rows[0].ok !== true) throw notFound();
    const view = createCatalogView(c, { mode: 'rls', store: deps.store });
    const opts = { forVisibility: forTeam ? 'team' as const : 'private' as const, forTeamId: forTeam };
    if (d.refs !== undefined) {
      if (!Array.isArray(d.refs) || d.refs.length > MAX_REFS) throw bad(`refs must be an array of at most ${MAX_REFS} references.`);
      const items = [];
      for (const [i, raw] of d.refs.entries()) {
        const r = raw as Record<string, unknown> | null;
        if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !LISTING_ID.test(r.id) || typeof r.range !== 'string' || !isRange(r.range)) throw bad(`refs[${i}] must be {id, range}.`);
        const out = await view.resolve({ id: r.id, range: r.range }, opts);
        items.push('error' in out ? { id: r.id, range: r.range, ok: false, error: out.error } : { id: r.id, range: r.range, ok: true, ...memberDto(out as CatalogMember) });
      }
      return { items };
    }
    if (typeof d.agentVersionId !== 'string' || !OPAQUE_ID.test(d.agentVersionId)) throw bad('agentVersionId is not valid.');
    const f = await versionFile(deps, c, d.agentVersionId, blueprintFileName, BLUEPRINT_LIMITS.maxBytes);
    if (!f || f.type !== 'agent') throw notFound();
    let bp;
    try { bp = parseBlueprintText(new TextDecoder('utf-8', { fatal: true }).decode(f.bytes)); } catch { throw new StoreError(422, 'The stored blueprint cannot be read.', 'bad_blueprint'); }
    const r = await resolveRefs(view, bp, { visibility: opts.forVisibility, teamId: forTeam, rootId: f.listingId });
    return {
      ok: r.findings.length === 0, findings: r.findings,
      skills: r.resolved.skills.map((x) => memberDto(x as CatalogMember)), children: r.resolved.children.map((x) => memberDto(x as CatalogMember)),
      agents: [...r.resolved.agents.values()].map((x) => memberDto(x as CatalogMember)), truncated: r.resolved.truncated,
    };
  });
}

/** Server-side plan of a bundle version for the caller: members resolved through the caller's own view, the caller's policy applied. */
async function bundlePlanFor(deps: TeamsDeps, uid: string, versionId: string, deviceId: string | null) {
  if (deviceId !== null && !OPAQUE_ID.test(deviceId)) throw bad('device is not valid.');
  return withUser(deps.app, uid, async (c) => {
    const f = await versionFile(deps, c, versionId, BUNDLE_FILE, BUNDLE_LIMITS.maxBytes);
    if (!f || f.type !== 'bundle') throw notFound();
    let b;
    try { b = parseBundleText(new TextDecoder('utf-8', { fatal: true }).decode(f.bytes)); } catch { throw new StoreError(422, 'The stored bundle cannot be read.', 'bad_bundle'); }
    // a team bundle is for that team's members only; anyone else gets the uniform 404
    if (b.teamScope.kind === 'team' && (await c.query(`SELECT marketplace_is_team_member($1) AS ok`, [b.teamScope.teamId]).then((r) => r.rows[0].ok)) !== true) throw notFound();
    const base = createCatalogView(c, { mode: 'rls', store: deps.store });
    const trusts = new Map<string, Trust>();
    const view: CatalogView = { async resolve(ref, o) { const r = await base.resolve(ref, o); if (!('error' in r) && (r as CatalogMember).trust) trusts.set(r.id, (r as CatalogMember).trust!); return r; } };
    const installed = new Map<string, { version: string; sha256: string }>();
    if (deviceId) {
      for (const r of (await c.query(`SELECT i.listing_id, v.version, v.sha256 FROM marketplace_installs i JOIN marketplace_versions v ON v.id = i.version_id
                                        WHERE i.user_id = $1 AND i.device_id = $2 AND i.state IN ('installed','configured','enabled','disabled','update_available') LIMIT 500`, [uid, deviceId])).rows) installed.set(r.listing_id, { version: r.version, sha256: r.sha256 });
    }
    const policy = await loadEffectivePolicy(c, uid);   // a policy that cannot be read is an error, not "no policy"
    const plan = await planBundle(view, b, installed, { visibility: 'private', teamId: null, policy, trustOf: (id) => trusts.get(id) });
    return { bundleId: f.listingId, versionId, bundle: b, plan };
  });
}
