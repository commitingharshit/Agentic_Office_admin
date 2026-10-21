// Shared harness for the Plan 2 Task 7 API tests: a real embedded Postgres (real ao_app / ao_admin roles), the creator/public API,
// the team/policy API and the admin API on the same database and one in-memory artifact store, with the agent runtime (bridge +
// scanner) injected. Not a test file: the runner globs *.test.ts.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { strToU8, zipSync } from 'fflate';
import type pg from 'pg';
import { authenticate as adminAuthenticate, parseTokens, type AdminDeps } from '../../src/api/admin.ts';
import { marketplaceAdminHandler } from '../../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../../src/api/marketplace.ts';
import { marketplaceTeamsHandler } from '../../src/api/marketplace-teams.ts';
import { HttpError } from '../../src/api/sync.ts';
import { MANIFEST_NAME, memoryArtifactStore, putArtifact, sha256Hex } from '../../src/marketplace/artifacts.ts';
import { createAgentRuntime, type AgentRuntime } from '../../src/marketplace/agents.ts';
import type { Bridge } from '../../src/marketplace/blueprint/pyBridge.ts';
import type { AdminRole } from '../../src/marketplace/permissions.ts';
import { createLimiter } from '../../src/marketplace/ratelimit.ts';
import type { ManifestV1, PermissionRequest, UnpackedPackage } from '../../src/marketplace/types.ts';
import type { SkillScanner } from '../../src/marketplace/validate/skill.ts';
import { startMarketplacePg, type MarketplacePg } from './marketplace-pg.ts';
import { agentPkg } from '../marketplace-agent-helpers.ts';

export { agentPkg };
export const zipOf = (pkg: UnpackedPackage): Uint8Array => {
  const z: Record<string, Uint8Array> = { [MANIFEST_NAME]: strToU8(JSON.stringify(pkg.manifest)) };
  for (const [k, v] of pkg.files) z[k] = v;
  return zipSync(z);
};
export const TOKENS: Record<string, [string, AdminRole]> = {
  root: ['r'.repeat(30), 'superadmin'], eng: ['e'.repeat(30), 'engineer'], eng2: ['g'.repeat(30), 'engineer'], ana: ['a'.repeat(30), 'analyst'],
};
const ROLE_OF = Object.fromEntries(Object.entries(TOKENS).map(([k, [, r]]) => [k, r]));

export interface Harness {
  h: MarketplacePg; admin: pg.Client; store: ReturnType<typeof memoryArtifactStore>; runtime: AgentRuntime; adminPool: pg.Pool; appPool: pg.Pool;
  api: string; teams: string; adminApi: string; servers: Server[];
  /** Another public + admin API pair on the same database whose compiler self-check state is `agentsOk` (e.g. false: a server whose compiler never passed). */
  extraApis(agentsOk: () => boolean): Promise<{ api: string; adminApi: string }>;
  call(path: string, o?: { user?: string; as?: string; method?: string; body?: unknown; zip?: Uint8Array; origin?: string; raw?: string }): Promise<{ status: number; json: any; headers: Headers }>;
  seedSkill(id: string, o?: { version?: string; visibility?: 'public' | 'org' | 'team' | 'private'; team?: string | null; owner?: string; permissions?: PermissionRequest[]; state?: string }): Promise<{ versionId: string; sha256: string }>;
  stop(): Promise<void>;
}

export async function startHarness(o: { bridge?: Bridge; bridgeFor?: (store: ReturnType<typeof memoryArtifactStore>) => Bridge; scanner?: SkillScanner; skipSelfCheck?: boolean; users?: number }): Promise<Harness> {
  const h = await startMarketplacePg();
  const store = memoryArtifactStore();
  const runtime = createAgentRuntime({ bridge: o.bridgeFor ? o.bridgeFor(store) : o.bridge!, scanner: o.scanner });
  runtime.register();
  if (!o.skipSelfCheck) await runtime.selfCheck();
  const appPool = h.pool('ao_app', 8), adminPool = h.pool('ao_admin', 8);
  const authenticate = async (req: { headers: { authorization?: string } }) => {
    const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!t || !/^u\d$/.test(t)) throw new HttpError(401, 'Sign in again.');
    return { uid: t };
  };
  const wrap = (fn: (req: any, res: any) => Promise<boolean>) => createServer(async (req, res) => { if (!(await fn(req, res))) res.writeHead(404).end(); });
  const limiter = createLimiter({ limit: 1000 });
  const pub = marketplaceHandler({ app: appPool, admin: adminPool, authenticate, store, agentsOk: () => runtime.ok(), limiter, readLimiter: createLimiter({ limit: 5000 }), memberAddLimiter: createLimiter({ limit: 1000 }) });
  const teams = marketplaceTeamsHandler({ app: appPool, authenticate, store, limiter: createLimiter({ limit: 1000 }), readLimiter: createLimiter({ limit: 5000 }) });
  const tokens = parseTokens(Object.entries(TOKENS).map(([k, [t]]) => `${k}:${t}`).join(','));
  const adm = marketplaceAdminHandler({ admin: adminPool, authenticate: (req) => adminAuthenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE_OF[id], store, agentsOk: () => runtime.ok() });
  const servers = [wrap(async (req, res) => (await teams(req, res)) || (await pub(req, res))), wrap(adm)];
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  const origin = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const n = o.users ?? 6;
  await h.owner.query(`INSERT INTO users(id) VALUES ${Array.from({ length: n }, (_, i) => `('u${i + 1}')`).join(',')}`);
  const api = origin(servers[0]), adminApi = origin(servers[1]);

  const call: Harness['call'] = async (path, c = {}) => {
    const headers: Record<string, string> = {};
    if (c.user) headers.authorization = `Bearer ${c.user}`;
    if (c.as) headers.authorization = `Bearer ${TOKENS[c.as]?.[0] ?? c.as}`;
    let body: any;
    if (c.zip) { headers['content-type'] = 'application/zip'; body = c.zip; }
    else if (c.raw !== undefined) { headers['content-type'] = 'application/json'; body = c.raw; }
    else if (c.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(c.body); }
    const r = await fetch((c.origin ?? (c.as ? adminApi : api)) + path, { method: c.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body });
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, headers: r.headers };
  };

  let seq = 0;
  const seedSkill: Harness['seedSkill'] = async (id, s = {}) => {
    const [pub0, slug] = id.split('/');
    const owner = s.owner ?? 'u1';
    await h.admin.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id) VALUES ($1,$1,$2) ON CONFLICT DO NOTHING`, [pub0, owner]);
    const version = s.version ?? '1.2.0';
    const files = { 'SKILL.md': strToU8(`---\nname: ${slug}\ndescription: A skill.\n---\n\n# ${slug}\n`) };
    const manifest: ManifestV1 = { schema: 'agentic.marketplace/1', id, type: 'skill', version, title: slug, summary: 'S', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: s.permissions ?? [],
      files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { entry: 'SKILL.md', name: slug } };
    const bytes = zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
    const { sha256, size } = await putArtifact(store, bytes);
    await h.admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [sha256, size, `k-${sha256.slice(0, 8)}`]);
    await h.admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, team_id, trust, title, summary) VALUES ($1,'skill',$2,$3,$4,$5,'community',$6,'S') ON CONFLICT DO NOTHING`,
      [id, pub0, owner, s.visibility ?? 'public', s.team ?? null, slug]);
    const [a, b, c] = version.split('-')[0].split('.').map(Number);
    const versionId = `v_${++seq}_${id.replace('/', '_')}`;
    await h.admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, scan_verdict, risk_tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'clean','declarative')`,
      [versionId, id, version, a, b, c, s.state ?? 'published', JSON.stringify(manifest), sha256, size]);
    return { versionId, sha256 };
  };

  const extraApis: Harness['extraApis'] = async (agentsOk) => {
    const p2 = marketplaceHandler({ app: appPool, admin: adminPool, authenticate, store, agentsOk, limiter, readLimiter: createLimiter({ limit: 5000 }) });
    const a2 = marketplaceAdminHandler({ admin: adminPool, authenticate: (req) => adminAuthenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ROLE_OF[id], store, agentsOk });
    const ss = [wrap(p2), wrap(a2)];
    await Promise.all(ss.map((x) => new Promise<void>((r) => x.listen(0, '127.0.0.1', r))));
    servers.push(...ss);
    return { api: origin(ss[0]), adminApi: origin(ss[1]) };
  };

  return {
    h, admin: h.admin, store, runtime, adminPool, appPool, api, teams: api, adminApi, servers, call, seedSkill, extraApis,
    async stop() { for (const s of servers) s.close(); await h.stop(); },
  };
}
