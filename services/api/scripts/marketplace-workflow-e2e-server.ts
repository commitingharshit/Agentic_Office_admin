// E2E HARNESS ONLY (Plan 3 Task 9). A marketplace API on loopback with embedded Postgres, on which ONE workflow is published
// through the REAL admin handlers (submit -> approve with the permission-summary ack, by a second admin -> publish), so the
// desktop install service can then install it with the real Hermes CLI. Never deploy this: it accepts fixed tokens.
//
//   node scripts/marketplace-workflow-e2e-server.ts --port 8795 --state <file>
//
// The one deliberate stand-in: GET /v1/marketplace/capabilities answers with `workflow` supported. The real OPERATIONAL table
// still says it is NOT supported (Plan 3 Task 15 flips it, only with this flow's evidence); the harness has to override the
// answer or the installer would (correctly) refuse the type. Every other route is the real handler.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { HttpError } from '../src/api/sync.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import { typeSupport } from '../src/marketplace/support.ts';
import type { ManifestV1 } from '../src/marketplace/types.ts';
import { registerValidator } from '../src/marketplace/validate/index.ts';
import { createDagPlanChecker, createWorkflowValidator } from '../src/marketplace/validate/workflow.ts';
import { createSkillsGuardScanner } from '../src/marketplace/validate/skillsGuard.ts';
import { permsFor, wf } from '../evals/corpora/workflow.ts';
import { startMarketplacePg } from '../test/helpers/marketplace-pg.ts';

if (process.env.NODE_ENV === 'production') { console.error('marketplace-workflow-e2e-server: refusing to start with NODE_ENV=production.'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? 8795);
const STATE = opt('--state');
const LISTING = 'acme/read-verify';
const USER_TOKEN = 'dev-token', USER = 'usr_dev', DEVICE = 'dev-device';
const ADMIN_TOKENS: Record<string, string> = { root: 'r'.repeat(30), pub: 'p'.repeat(30), rev: 'v'.repeat(30) };
const ADMIN_ROLES: Record<string, any> = { root: 'superadmin', pub: 'engineer', rev: 'engineer' };

async function main() {
  // the REAL validator with the REAL dag-runtime plan check and Skills Guard scanner: the report must come out `verified`, or approval is refused
  registerValidator('workflow', createWorkflowValidator({ planChecker: createDagPlanChecker(), scanner: createSkillsGuardScanner() }));

  const h = await startMarketplacePg();
  const store = memoryArtifactStore();
  await h.owner.query(`INSERT INTO users(id, email) VALUES ('${USER}','dev@example.test'),('usr_pub','pub@example.test'); INSERT INTO devices(id, user_id) VALUES ('${DEVICE}','${USER}')`);
  await h.admin.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme','Acme','usr_pub',false)`);

  const tokens = parseTokens(Object.entries(ADMIN_TOKENS).map(([k, t]) => `${k}:${t}`).join(','));
  const adminHandler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, { tokens } as unknown as AdminDeps), roleOf: (id) => ADMIN_ROLES[id], store });
  const pubHandler = marketplaceHandler({ app: h.pool('ao_app'), admin: h.pool('ao_admin'), store,
    authenticate: async (req) => { if (req.headers.authorization !== `Bearer ${USER_TOKEN}`) throw new HttpError(401, 'Sign in again.'); return { uid: USER }; } });
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/v1/marketplace/capabilities' && req.method === 'GET') {
      const types = typeSupport().map((t) => (t.type === 'workflow' ? { type: 'workflow', supported: true } : t));
      res.writeHead(200, { 'content-type': 'application/json', 'x-e2e-harness-override': 'workflow' }).end(JSON.stringify({ schema: 'agentic.marketplace.capabilities/1', types }));
      return;
    }
    if (await adminHandler(req, res)) return;
    if (await pubHandler(req, res)) return;
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}');
  });
  await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${PORT}`;

  const call = async (path: string, as: string, init: { zip?: Uint8Array; body?: unknown } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${ADMIN_TOKENS[as]}` };
    let body: any;
    if (init.zip) { headers['content-type'] = 'application/zip'; body = init.zip; } else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
    const r = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers, body } as RequestInit);
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${text.slice(0, 600)}`);
    return json;
  };

  // ---- publish the workflow through the real admin handlers
  const payload = wf({ type: 'sequential', steps: [
    { type: 'tool', id: 'read', server: 'docx', tool: 'docx_get', arguments: { path: '{{path}}' }, retries: 1, timeout_s: 60 },
    { type: 'tool', id: 'verify', server: 'docx', tool: 'docx_verify', arguments: { path: '{{path}}' }, depends_on: ['read'], retries: 1, timeout_s: 60 }] });
  const spec = { dependencies: [], permissions: permsFor(payload), payload };
  const files: Record<string, Uint8Array> = { 'README.md': strToU8('# Read and verify\n\nReads a document and verifies it.\n') };
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: LISTING, type: 'workflow', version: '1.0.0', title: 'Read and verify', summary: 'Reads a document, then verifies it, on the DAG runtime.',
    license: 'MIT', compat: { app: '*' }, dependencies: spec.dependencies, permissions: spec.permissions,
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: spec.payload,
  };
  const zip = zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
  const sub = await call('/admin/marketplace/submissions?publisher=acme', 'root', { zip });
  if (!sub.validation?.ok || sub.validation.verified !== true) throw new Error(`the workflow did not validate as verified: ${JSON.stringify(sub.validation?.checks?.filter((c: any) => !c.ok || c.skipped))}`);
  if (sub.manualReview !== true || sub.riskTier !== 'declarative') throw new Error(`unexpected policy: ${JSON.stringify({ m: sub.manualReview, r: sub.riskTier })}`);
  await call(`/admin/marketplace/versions/${sub.versionId}/approve`, 'rev', { body: { ack_summary_sha256: sub.summarySha256 } });
  await call(`/admin/marketplace/versions/${sub.versionId}/publish`, 'rev', { body: {} });
  console.log(`published ${LISTING}@1.0.0 as ${sub.versionId} (risk ${sub.riskTier}, manual review)`);

  const state = { url, pid: process.pid, token: USER_TOKEN, user: USER, device: DEVICE, listingId: LISTING, versionId: sub.versionId, adminRootToken: ADMIN_TOKENS.root, adminRevToken: ADMIN_TOKENS.rev, capabilitiesOverride: 'workflow' };
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify(state)); }
  console.log(`marketplace workflow e2e server: ${url}`);

  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections?.(); await h.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
