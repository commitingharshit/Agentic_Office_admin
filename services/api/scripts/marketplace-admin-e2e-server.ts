// DEV/E2E ONLY. The REAL accounts-sync admin API on a REAL Postgres (migrations 0001-latest, real roles, real RLS), for the control-plane
// marketplace console end-to-end run (scripts/e2e/marketplace-admin/run.mjs). It composes the same handlers src/api/main.ts composes
// (adminHandler + marketplaceAdminHandler with the real `authenticate` and the real AO_MARKETPLACE_ROLES role map) and differs from main.ts
// only in two honest ways: the artifact store is in memory (main.ts needs MinIO) and the user-facing marketplace API accepts one fixed bearer
// (`dev-token` = usr_dev) so the run can ask the catalog what a client would be served. Refuses NODE_ENV=production.
//
//   PG_PORT=… AO_ADMIN_PASSWORD=… AO_READONLY_PASSWORD=… AO_APP_PASSWORD=… AO_ADMIN_TOKENS=name:token,… AO_MARKETPLACE_ROLES=name:role,…
//   node scripts/marketplace-admin-e2e-server.ts --port 8795 --state <file>
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { roleOf as consoleRoleOf } from '../src/api/admin-console.ts';
import { adminHandler, authenticate as adminAuthenticate, parseTokens } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { memoryArtifactStore } from '../src/marketplace/artifacts.ts';
import { parseRoleMap } from '../src/marketplace/permissions.ts';
import { registerValidator } from '../src/marketplace/validate/index.ts';
import { createSkillValidator } from '../src/marketplace/validate/skill.ts';
import { createSkillsGuardScanner } from '../src/marketplace/validate/skillsGuard.ts';
import { createRoutineValidator } from '../src/marketplace/validate/routine.ts';
import { registerSkillPipeline } from '../src/marketplace/verify/stages/skill/index.ts';
import '../src/marketplace/verify/stages/template/index.ts';
import type { PipelineTools } from '../src/marketplace/verify/types.ts';

if (process.env.NODE_ENV === 'production') { console.error('marketplace-admin-e2e-server: refusing to start with NODE_ENV=production.'); process.exit(2); }
const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? 8795);
const STATE = opt('--state');
const pool = (user: string, password: string) => new pg.Pool({ host: '127.0.0.1', port: Number(need('PG_PORT')), database: env.PG_DATABASE ?? 'agentic_office', user, password, max: 5, application_name: `ao-e2e:${user}` });

const python = env.AO_E2E_PYTHON || 'python3';
const scanner = createSkillsGuardScanner({ python });
registerValidator('skill', createSkillValidator({ scanner }));
registerValidator('routine', createRoutineValidator({ scanner }));
registerSkillPipeline();
const verifyTools: PipelineTools = { scanner };

const deps = { ro: pool('ao_readonly', need('AO_READONLY_PASSWORD')), admin: pool('ao_admin', need('AO_ADMIN_PASSWORD')), tokens: parseTokens(need('AO_ADMIN_TOKENS')) };
const app = pool('ao_app', need('AO_APP_PASSWORD'));
const roles = parseRoleMap(env.AO_MARKETPLACE_ROLES);
const store = memoryArtifactStore();
const admin = adminHandler(deps);
const marketplaceAdmin = marketplaceAdminHandler({ admin: deps.admin, authenticate: (req) => adminAuthenticate(req, deps), roleOf: (id) => roles.get(id) ?? 'analyst', actingRole: async (id) => ((await consoleRoleOf(deps, id)) ? roles.get(id) ?? 'analyst' : null), store, scannerOk: () => true, verifyTools });
const authenticate = async (req: { headers: { authorization?: string } }) => {
  if (req.headers.authorization !== 'Bearer dev-token') throw new HttpError(401, 'The e2e server accepts only the dev token on the user API.');
  return { uid: 'usr_dev' };
};
const marketplace = marketplaceHandler({ app, admin: deps.admin, authenticate, store, scannerOk: () => true, verifyTools });

const server = createServer(async (req, res) => {
  if (await marketplace(req, res)) return;
  if (await marketplaceAdmin(req, res)) return;
  await admin(req, res);
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`marketplace admin e2e server: ${url}`);
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify({ url, pid: process.pid })); }
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.close(); server.closeAllConnections?.(); void Promise.all([deps.ro.end(), deps.admin.end(), app.end()]).finally(() => process.exit(0)); });
