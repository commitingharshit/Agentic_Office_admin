// DEV SEED ONLY (ship step A). One example of each operational advanced type, as plain manifest + files. The dev server
// (scripts/marketplace-dev-server.ts --advanced) turns each into a zip and runs it through the REAL validator for its type before
// inserting it; a seed that does not validate is skipped and reported, never inserted. Never imported by src/.
// The payloads are the benign fixtures of evals/corpora/* with ids, titles and (for bridge and connector) endpoints changed.
import { baseRoutine } from '../../evals/corpora/routine.ts';
import { permsFor as hookPerms } from '../../evals/corpora/hook.ts';
import { permsFor as workflowPerms, wf } from '../../evals/corpora/workflow.ts';
import type { ManifestV1, PermissionRequest } from '../../src/marketplace/types.ts';

export interface AdvancedSeed { manifest: Omit<ManifestV1, 'files'>; files: Record<string, Uint8Array>; tags: string[] }
const enc = (s: string) => new TextEncoder().encode(s);
const base = { schema: 'agentic.marketplace/1' as const, license: 'MIT', compat: { app: '*' }, dependencies: [] as { id: string; range: string }[] };

/** `bridgeUrl` / `connectorUrl`: https://127.0.0.1:<port>/mcp of the LOCAL fake servers the demo script starts under AGENTICOFFICE_DEV_MODE=1. */
export function advancedSeeds(o: { bridgeUrl?: string; connectorUrl?: string }): AdvancedSeed[] {
  const out: AdvancedSeed[] = [];

  const r = baseRoutine();
  out.push({ tags: ['routine', 'dev-seed'], files: { 'README.md': enc('# DEV SEED: Weekly summary\n\nA weekday summary of one folder. Example package for local runs.\n') },
    manifest: { ...base, id: 'dev-advanced/weekly-summary', type: 'routine', version: '1.0.0', title: 'Weekly Summary (dev seed)', summary: 'DEV SEED. A weekday summary of one folder, run as an unattended agent routine.',
      dependencies: r.dependencies, permissions: r.permissions, payload: r.payload } });

  out.push({ tags: ['memory', 'dev-seed'], files: {},
    manifest: { ...base, id: 'dev-advanced/local-memory', type: 'memory', version: '1.0.0', title: 'Local Memory (dev seed)', summary: 'DEV SEED. Binds the bundled local holographic memory provider; no code ships.',
      permissions: [], payload: { kind: 'memory', provider: 'holographic', scope: 'user', config: { auto_extract: 'false', default_trust: '0.5' } } } });

  const hook = { kind: 'declarative', rules: [{ id: 'r1', event: 'before_document_edit', when: { tool: 'docx_*', arg_contains: { path: 'confidential' } }, action: { type: 'block', message: 'Confidential documents are not editable by the agent.' } }] };
  out.push({ tags: ['hook', 'dev-seed'], files: {},
    manifest: { ...base, id: 'dev-advanced/doc-guard', type: 'hook', version: '1.0.0', title: 'Doc Guard (dev seed)', summary: 'DEV SEED. Declarative hook: blocks agent edits of documents whose path contains "confidential". No script runs.',
      permissions: hookPerms(hook), payload: hook } });

  if (o.bridgeUrl) {
    const host = new URL(o.bridgeUrl).hostname;
    const perms: PermissionRequest[] = [{ capability: 'network', scope: host, reason: 'Reaches the local fake issue-tracker MCP server (dev seed).' }, { capability: 'secrets.use', scope: 'token', reason: 'Sends the token to the fake server.' }];
    out.push({ tags: ['bridge', 'dev-seed'], files: {},
      manifest: { ...base, id: 'dev-advanced/issue-bridge', type: 'bridge', version: '1.0.0', title: 'Issue Bridge (dev seed)', summary: 'DEV SEED. Remote MCP bridge pointing at a local fake server that the demo script started (loopback is allowed only under AGENTICOFFICE_DEV_MODE=1).',
        permissions: perms, payload: { kind: 'bridge', server: { url: o.bridgeUrl, transport: 'streamable-http' }, tools: [{ name: 'search_issues', capability: 'read', summary: 'Search issues' }],
          auth: { kind: 'header', header: 'Authorization', scheme: 'Bearer', secret: 'token' }, limits: { timeout_s: 30, max_rpm: 30 } } } });
  }

  if (o.connectorUrl) {
    out.push({ tags: ['connector', 'dev-seed'], files: {},
      manifest: { ...base, id: 'dev-advanced/issue-connector', type: 'connector', version: '1.0.0', title: 'Issue Connector (dev seed)', summary: 'DEV SEED. API-key connector for a local fake issue-tracker API that the demo script started (loopback only under AGENTICOFFICE_DEV_MODE=1).',
        permissions: [{ capability: 'network', scope: new URL(o.connectorUrl).hostname, reason: 'Reaches the local fake issue tracker API (dev seed).' }, { capability: 'secrets.use', scope: 'api_key', reason: 'Sends your API key to the fake API.' }],
        payload: { kind: 'connector', service: 'example-issues', auth: { kind: 'api_key', header: 'X-Api-Key' },
          fields: [{ key: 'workspace', label: 'Workspace', secret: false, pattern: '^[a-z0-9-]{1,30}$' }, { key: 'api_key', label: 'API key', secret: true }],
          bridge: { url_template: o.connectorUrl, transport: 'streamable-http', tools: [{ name: 'search_issues', capability: 'read', summary: 'Search issues' }, { name: 'list_labels', capability: 'read', summary: 'List labels' }] },
          health: { path: '/healthz', expect_status: [200] }, limits: { timeout_s: 30, max_rpm: 30, max_response_kb: 256 }, network_allowlist: [new URL(o.connectorUrl).hostname],
          data_locality: { description: 'Queries go only to the fake API on this machine.' } } } });
  }

  const plan = wf({ type: 'sequential', steps: [
    { type: 'tool', id: 'read', server: 'docx', tool: 'docx_get', arguments: { path: '{{path}}' }, retries: 1, timeout_s: 60 },
    { type: 'tool', id: 'verify', server: 'docx', tool: 'docx_verify', arguments: { path: '{{path}}' }, depends_on: ['read'], retries: 1, timeout_s: 60 }] });
  out.push({ tags: ['workflow', 'dev-seed'], files: {},
    manifest: { ...base, id: 'dev-advanced/read-and-verify', type: 'workflow', version: '1.0.0', title: 'Read and Verify (dev seed)', summary: 'DEV SEED. Reads a document and verifies it with the DAG runtime (read-only tools).',
      permissions: workflowPerms(plan), payload: plan } });
  return out;
}
