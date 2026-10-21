// DEV/E2E ONLY (Plan 3 Task 7). The REAL marketplace handlers (public API + admin API with the real validators, scan rows,
// separation of duties and review acknowledgement) on embedded Postgres, behind fixed dev tokens, so the bridge end-to-end flow
// publishes a package the way a publisher and a reviewer would, with nothing seeded behind the handlers' back.
//
//   AGENTICOFFICE_DEV_MODE=1 node scripts/marketplace-bridge-e2e-server.ts --port 8795 --state <file>
//
// Two honest stand-ins, both only here:
//   1. GET /v1/marketplace/capabilities reports `bridge` as supported. In the product that flag is flipped by Plan 3 Task 15 and only
//      with evidence; this harness is part of that evidence.
//   2. AGENTICOFFICE_DEV_MODE=1 lets the bridge validator accept a loopback https URL (the fake MCP server). Production never sets it.
// It refuses to start with NODE_ENV=production.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { HttpError } from '../src/api/sync.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { memoryArtifactStore } from '../src/marketplace/artifacts.ts';
import { startMarketplacePg } from '../test/helpers/marketplace-pg.ts';

if (process.env.NODE_ENV === 'production') { console.error('marketplace-bridge-e2e-server: refusing to start with NODE_ENV=production.'); process.exit(2); }
if (process.env.AGENTICOFFICE_DEV_MODE !== '1') { console.error('marketplace-bridge-e2e-server: set AGENTICOFFICE_DEV_MODE=1 (the flow publishes a loopback bridge).'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? 8795);
const STATE = opt('--state');
export const USER_TOKEN = 'dev-token';
const ADMINS: Record<string, string> = { 'adm-submitter-token': 'adm_submitter', 'adm-reviewer-token': 'adm_reviewer' };

async function main() {
  const h = await startMarketplacePg();
  const store = memoryArtifactStore();
  await h.owner.query(`INSERT INTO users(id, email) VALUES ('usr_dev','dev@example.test'); INSERT INTO devices(id, user_id) VALUES ('dev-device','usr_dev')`);
  const bearer = (req: { headers: { authorization?: string } }) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const authenticate = async (req: { headers: { authorization?: string } }) => {
    if (bearer(req) !== USER_TOKEN) throw new HttpError(401, 'Sign in again (the e2e server accepts only the dev token).');
    return { uid: 'usr_dev' };
  };
  const pub = marketplaceHandler({ app: h.pool('ao_app'), admin: h.pool('ao_admin'), authenticate, store });
  const adm = marketplaceAdminHandler({
    admin: h.pool('ao_admin'), store, roleOf: () => 'superadmin',
    authenticate: async (req) => { const a = ADMINS[bearer(req) ?? '']; if (!a) throw new HttpError(401, 'unknown admin token'); return a; },
  });
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path.startsWith('/admin/marketplace')) { if (await adm(req, res)) return; }
      else if (await pub(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}');
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((e as Error).message).slice(0, 200) })); }
  });
  await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`marketplace bridge e2e server: ${url}`);
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify({ url, pid: process.pid, userToken: USER_TOKEN, adminTokens: { submitter: 'adm-submitter-token', reviewer: 'adm-reviewer-token' } })); }
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections?.(); await h.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
