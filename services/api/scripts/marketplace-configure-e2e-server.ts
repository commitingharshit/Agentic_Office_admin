// DEV/E2E ONLY (Marketplace ship B). The REAL marketplace handlers on embedded Postgres, with one published item per type the
// configure window flow drives (connector, routine, hook), published through the real admin handlers by two different admins.
//
//   AGENTICOFFICE_DEV_MODE=1 node scripts/marketplace-configure-e2e-server.ts --port 8796 --state <file> --fake-port <https port of the fake API>
//
// Honest stand-in, only here: GET /v1/marketplace/capabilities reports connector, routine and hook as supported (in the product that is
// the OPERATIONAL table). AGENTICOFFICE_DEV_MODE=1 lets the connector validator accept the loopback https fake API. Refuses NODE_ENV=production.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { HttpError } from '../src/api/sync.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import { typeSupport } from '../src/marketplace/support.ts';
import type { ManifestV1 } from '../src/marketplace/types.ts';
import { registerValidator } from '../src/marketplace/validate/index.ts';
import { createRoutineValidator } from '../src/marketplace/validate/routine.ts';
import { createSkillsGuardScanner } from '../src/marketplace/validate/skillsGuard.ts';
import { baseRoutine } from '../evals/corpora/routine.ts';
import { startMarketplacePg } from '../test/helpers/marketplace-pg.ts';

if (process.env.NODE_ENV === 'production') { console.error('marketplace-configure-e2e-server: refusing to start with NODE_ENV=production.'); process.exit(2); }
if (process.env.AGENTICOFFICE_DEV_MODE !== '1') { console.error('marketplace-configure-e2e-server: set AGENTICOFFICE_DEV_MODE=1 (the connector points at a loopback fake API).'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? 8796);
const FAKE_PORT = Number(opt('--fake-port') ?? 0);
const STATE = opt('--state');
const SUPPORTED = new Set(['connector', 'routine', 'hook']);
export const USER_TOKEN = 'dev-token';
const ADMINS: Record<string, string> = { 'adm-submitter-token': 'adm_submitter', 'adm-reviewer-token': 'adm_reviewer' };

async function main() {
  // the REAL routine validator with the REAL Hermes Skills Guard scanner (the report must come out `verified`, or approval is refused)
  registerValidator('routine', createRoutineValidator({ scanner: createSkillsGuardScanner({ python: process.env.AO_E2E_PYTHON }) }));
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
      if (req.method === 'GET' && path === '/v1/marketplace/capabilities') {
        const types = typeSupport().map((t) => SUPPORTED.has(t.type) ? { type: t.type, supported: true } : t);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ schema: 'agentic.marketplace.capabilities/1', types }));
        return;
      }
      if (path.startsWith('/admin/marketplace')) { if (await adm(req, res)) return; }
      else if (await pub(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}');
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String((e as Error).message).slice(0, 200) })); }
  });
  await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${PORT}`;

  const api = async (path: string, token: string, init: { zip?: Uint8Array; body?: unknown } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: any;
    if (init.zip) { headers['content-type'] = 'application/zip'; body = init.zip; } else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
    const r = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers, body } as RequestInit);
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    if (!r.ok) throw new Error(`${path} -> ${r.status} ${text.slice(0, 500)}`);
    return json;
  };
  const publish = async (m: Omit<ManifestV1, 'schema' | 'files' | 'compat' | 'license'>) => {
    const manifest: ManifestV1 = { schema: 'agentic.marketplace/1', license: 'MIT', compat: { app: '*' }, files: [], ...m } as ManifestV1;
    const zip = zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)) });
    await api('/admin/marketplace/publishers', 'adm-submitter-token', { body: { id: 'acme', trust: 'verified', displayName: 'Acme' } }).catch(() => undefined);
    const sub = await api('/admin/marketplace/submissions?visibility=public', 'adm-submitter-token', { zip });
    if (sub.state !== 'submitted') throw new Error(`${m.id} was not accepted: ${JSON.stringify(sub).slice(0, 600)}`);
    await api(`/admin/marketplace/versions/${sub.versionId}/claim`, 'adm-reviewer-token', { body: {} });
    await api(`/admin/marketplace/versions/${sub.versionId}/approve`, 'adm-reviewer-token', { body: { ack_summary_sha256: sub.summarySha256 } });
    await api(`/admin/marketplace/versions/${sub.versionId}/publish`, 'adm-reviewer-token', { body: {} });
    console.log(`published ${m.id}`);
  };

  await publish({
    id: 'acme/issue-connector', type: 'connector', version: '1.0.0', title: 'Issue Connector', summary: 'Connect the assistant to your issue tracker (end-to-end fixture).', dependencies: [],
    permissions: [{ capability: 'network', scope: '127.0.0.1', reason: 'Reaches the issue tracker API (test fixture on loopback).' }, { capability: 'secrets.use', scope: 'api_key', reason: 'Sends your API key to the issue tracker.' }],
    payload: { kind: 'connector', service: 'example-issues', auth: { kind: 'api_key', header: 'X-Api-Key' },
      fields: [{ key: 'workspace', label: 'Workspace', secret: false, pattern: '^[a-z0-9-]{1,30}$' }, { key: 'api_key', label: 'API key', secret: true }],
      bridge: { url_template: `https://127.0.0.1:${FAKE_PORT}/mcp`, transport: 'streamable-http', tools: [{ name: 'search_issues', capability: 'read', summary: 'Search issues' }, { name: 'list_labels', capability: 'read', summary: 'List labels' }] },
      health: { path: '/healthz', expect_status: [200] }, limits: { timeout_s: 30, max_rpm: 30, max_response_kb: 256 }, network_allowlist: ['127.0.0.1'],
      data_locality: { description: 'Queries go only to the issue tracker you configure.' } },
  } as never);
  const routine = baseRoutine();
  await publish({ id: 'acme/weekly-summary', type: 'routine', version: '1.0.0', title: 'Weekly summary', summary: 'A weekday summary of one folder, run as an unattended agent routine.', dependencies: routine.dependencies, permissions: routine.permissions, payload: routine.payload } as never);
  await publish({
    id: 'acme/confidential-guard', type: 'hook', version: '1.0.0', title: 'Confidential guard', summary: 'Blocks document edits on confidential files and adds a note at session start.', dependencies: [],
    permissions: [{ capability: 'tool.invoke', scope: 'docx_*', reason: 'The rule applies to these tools' }, { capability: 'tool.invoke', scope: 'event:session_started', reason: 'The rule applies to these tools' }],
    payload: { kind: 'declarative', rules: [
      { id: 'r1', event: 'before_document_edit', when: { tool: 'docx_*', arg_contains: { path: 'confidential' } }, action: { type: 'block', message: 'Confidential documents are not editable by the agent.' } },
      { id: 'r2', event: 'session_started', action: { type: 'inject_context', text: 'Treat files with "confidential" in the name as read-only.' } },
    ] },
  } as never);

  await publish({
    id: 'acme/audit-edits', type: 'hook', version: '1.0.0', title: 'Audit edits', summary: 'Adds context at the start of a session and blocks edits to draft files.', dependencies: [],
    permissions: [{ capability: 'tool.invoke', scope: 'xlsx_*', reason: 'The rule applies to these tools' }, { capability: 'tool.invoke', scope: 'event:session_started', reason: 'The rule applies to these tools' }],
    payload: { kind: 'declarative', rules: [
      { id: 'a1', event: 'session_started', action: { type: 'inject_context', text: 'Be careful when editing spreadsheets.' } },
      { id: 'a2', event: 'before_document_edit', when: { tool: 'xlsx_*', arg_contains: { path: 'draft' } }, action: { type: 'block', message: 'Draft spreadsheets are read-only for the agent.' } },
    ] },
  } as never);

  console.log(`marketplace configure e2e server: ${url}`);
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify({ url, pid: process.pid, userToken: USER_TOKEN })); }
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); server.closeAllConnections?.(); await h.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
