// MCP bridge validator (type 'bridge', Plan 3 Task 7). A bridge is a declarative pointer at a REMOTE https MCP server plus the
// explicit list of tools it may expose. Everything in the payload is attacker-controlled: unknown keys are rejected (not
// ignored), the URL is judged from the raw string, secrets are references only, and the permissions the manifest declares must
// be exactly what the payload implies. What this file cannot know (what a DNS name resolves to) is checked again by the Hermes
// handler at apply time and at call time; see vendor/hermes-agent/hermes_cli/marketplace_ext/handlers/bridge.py.
import {
  checkBounded, checkNoLiteralSecrets, checkOnlyFiles, checkPublicHttpsUrl, impliedPermissions, riskTierCheck,
} from './advanced-common.ts';
import type { Validator } from './index.ts';
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';

export const BRIDGE_LIMITS = Object.freeze({
  maxTools: 50, maxWriteExecTools: 10, maxTimeoutS: 120, maxRpm: 120, maxSummary: 200, maxReason: 300,
  maxPayloadBytes: 64 * 1024, maxDepth: 6, maxKeys: 600,
});

const TOP_KEYS = new Set(['kind', 'server', 'tools', 'auth', 'limits']);
const SERVER_KEYS = new Set(['url', 'transport']);
const TOOL_KEYS = new Set(['name', 'capability', 'summary', 'reason']);
const AUTH_KEYS = new Set(['kind', 'header', 'scheme', 'secret']);
const LIMIT_KEYS = new Set(['timeout_s', 'max_rpm']);
const TRANSPORTS = new Set(['streamable-http', 'sse']);
const CAPABILITIES = new Set(['read', 'write', 'exec']);
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const SECRET_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SCHEMES = new Set(['Bearer', 'Basic', 'Token', 'ApiKey', '']);
/** Headers a package may never set: they steer routing, framing, session state or the transport itself. */
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'accept', 'accept-encoding',
  'cookie', 'set-cookie', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'proxy-authorization',
  'proxy-authenticate', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id', 'user-agent', 'via',
]);
const STDIO_KEYS = new Set(['command', 'args', 'env', 'cwd', 'stdio', 'shell', 'executable']);
const SAMPLING_KEYS = new Set(['sampling', 'roots', 'elicitation', 'oauth']);
const FILES_ALLOWED: readonly RegExp[] = [/^README\.md$/, /^docs\/[A-Za-z0-9._-]+\.md$/];

const ok = (name: string, detail?: string): ValidationCheck => ({ name, ok: true, ...(detail ? { detail } : {}) });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/**
 * True only in a developer build explicitly started in dev mode, and never when NODE_ENV is production. The end-to-end flow
 * (a fake MCP server on loopback) is the only user; production deployments never set AGENTICOFFICE_DEV_MODE.
 */
export function devLoopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTICOFFICE_DEV_MODE === '1' && env.NODE_ENV !== 'production';
}

/** Dev-mode only: `https://localhost[:port]/...` or `https://127.0.0.1[:port]/...`. */
function devLoopbackHost(raw: string): { ok: true; host: string } | null {
  if (raw.length > 2048 || /[\s@\\%#?]/.test(raw)) return null;
  const m = /^https:\/\/(localhost|127\.0\.0\.1)(?::(\d{4,5}))?(?=\/|$)/.exec(raw);
  if (!m) return null;
  if (m[2] !== undefined && (Number(m[2]) < 1024 || Number(m[2]) > 65535)) return null;
  return { ok: true, host: m[1] };
}

/** The part of a URL after the authority (path, query, fragment), cut at the first of / ? # \ . Input already passed checkPublicHttpsUrl. */
function afterAuthority(raw: string): string {
  const rest = raw.slice(8);
  const i = rest.search(/[/?#\\]/);
  return i < 0 ? '' : rest.slice(i);
}

/** The permissions a payload implies (the review summary shows these). */
export function impliedBridgePermissions(payload: Record<string, unknown>, host: string | undefined): PermissionRequest[] {
  const out: PermissionRequest[] = [];
  if (host) out.push({ capability: 'network', scope: host, reason: '' });
  const auth = isObj(payload.auth) ? payload.auth : null;
  if (auth && auth.kind === 'header' && typeof auth.secret === 'string') out.push({ capability: 'secrets.use', scope: auth.secret, reason: '' });
  if (Array.isArray(payload.tools)) {
    for (const t of payload.tools) {
      if (isObj(t) && typeof t.name === 'string' && (t.capability === 'write' || t.capability === 'exec')) out.push({ capability: 'tool.invoke', scope: t.name, reason: '' });
    }
  }
  return out;
}

function checkPayload(pkg: UnpackedPackage): ValidationCheck[] {
  const checks: ValidationCheck[] = [];
  const payload = pkg.manifest.payload as unknown;
  const bounded = checkBounded(payload, { maxBytes: BRIDGE_LIMITS.maxPayloadBytes, maxDepth: BRIDGE_LIMITS.maxDepth, maxKeys: BRIDGE_LIMITS.maxKeys });
  checks.push(bounded);
  if (!bounded.ok) return checks;
  if (!isObj(payload)) { checks.push(fail('payload-shape', 'payload must be an object')); return checks; }

  // ---- shape: unknown keys are errors; stdio, sampling and roots get their own reasons
  const shape: string[] = [];
  const stdio: string[] = [];
  const sampling: string[] = [];
  const scanKeys = (o: Record<string, unknown>, allowed: Set<string>, path: string) => {
    for (const k of Object.keys(o)) {
      const lk = k.toLowerCase();
      if (STDIO_KEYS.has(lk)) stdio.push(`${path}.${k.slice(0, 24)}`);
      else if (SAMPLING_KEYS.has(lk)) sampling.push(`${path}.${k.slice(0, 24)}`);
      else if (!allowed.has(k)) shape.push(`${path}.${k.length > 40 ? '<key>' : k}: unknown key`);
    }
  };
  scanKeys(payload, TOP_KEYS, '$');
  if (payload.kind !== 'bridge') shape.push('$.kind must be "bridge"');
  const server = isObj(payload.server) ? payload.server : null;
  if (!server) shape.push('$.server must be an object'); else scanKeys(server, SERVER_KEYS, '$.server');
  if (payload.auth !== undefined) { if (isObj(payload.auth)) scanKeys(payload.auth, AUTH_KEYS, '$.auth'); else shape.push('$.auth must be an object'); }
  if (payload.limits !== undefined) { if (isObj(payload.limits)) scanKeys(payload.limits, LIMIT_KEYS, '$.limits'); else shape.push('$.limits must be an object'); }
  const tools = Array.isArray(payload.tools) ? payload.tools : null;
  if (!tools) shape.push('$.tools must be an array');
  else tools.forEach((t, i) => { if (isObj(t)) scanKeys(t, TOOL_KEYS, `$.tools[${i}]`); else shape.push(`$.tools[${i}] must be an object`); });
  checks.push(stdio.length ? fail('no-stdio', `stdio/local-process bridges are not supported (only remote https MCP servers): ${stdio.slice(0, 5).join(', ')}`) : ok('no-stdio'));
  checks.push(sampling.length ? fail('no-sampling', `server-initiated sampling, roots, elicitation and OAuth are not allowed in a bridge (the handler always disables them): ${sampling.slice(0, 5).join(', ')}`) : ok('no-sampling'));
  checks.push(shape.length ? fail('payload-shape', shape.slice(0, 8).join('; ')) : ok('payload-shape'));
  if (shape.length || !server || !tools) return checks;

  // ---- transport
  const transport = server.transport === undefined ? 'streamable-http' : server.transport;
  checks.push(typeof transport === 'string' && TRANSPORTS.has(transport) ? ok('transport') : fail('transport', 'transport must be "streamable-http" or "sse"'));

  // ---- url
  let host: string | undefined;
  const rawUrl = server.url;
  if (typeof rawUrl !== 'string') checks.push(fail('url-public-https', 'server.url must be a string'));
  else {
    let r: { ok: boolean; reason?: string; host?: string } = checkPublicHttpsUrl(rawUrl);
    if (!r.ok && devLoopbackAllowed()) { const d = devLoopbackHost(rawUrl); if (d) r = d; }
    if (!r.ok) checks.push(fail('url-public-https', r.reason ?? 'not a public https URL'));
    else {
      // a query or fragment can smuggle a redirect target or a secret; MCP endpoints do not need one
      const tail = afterAuthority(rawUrl);
      if (/[?#]/.test(tail)) checks.push(fail('url-public-https', 'URL must not carry a query string or fragment (redirect and secret smuggling)'));
      else if (/(^|\/)\.\.?(\/|$)/.test(tail)) checks.push(fail('url-public-https', 'URL path must not contain dot segments'));
      else if (/%/.test(tail)) checks.push(fail('url-public-https', 'URL path must not be percent-encoded'));
      else if (!/^[A-Za-z0-9._~/:@!$&'()*+,;=-]*$/.test(tail)) checks.push(fail('url-public-https', 'URL path has characters that are not allowed'));
      else { host = r.host; checks.push(ok('url-public-https', host)); }
    }
  }

  // ---- tools
  const toolProblems: string[] = [];
  const names = new Set<string>();
  const writeExec: string[] = [];
  if (tools.length < 1 || tools.length > BRIDGE_LIMITS.maxTools) toolProblems.push(`a bridge declares 1-${BRIDGE_LIMITS.maxTools} named tools (got ${tools.length})`);
  for (const [i, t] of tools.slice(0, BRIDGE_LIMITS.maxTools + 1).entries()) {
    if (!isObj(t)) continue;
    const name = t.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) { toolProblems.push(`$.tools[${i}].name must match ^[a-z0-9_]{1,64}$ (no wildcards)`); continue; }
    if (names.has(name)) toolProblems.push(`duplicate tool ${name}`);
    names.add(name);
    if (typeof t.capability !== 'string' || !CAPABILITIES.has(t.capability)) toolProblems.push(`tool ${name}: capability must be read, write or exec`);
    if (t.summary !== undefined && (typeof t.summary !== 'string' || t.summary.length > BRIDGE_LIMITS.maxSummary || CONTROL.test(t.summary))) toolProblems.push(`tool ${name}: summary must be plain text up to ${BRIDGE_LIMITS.maxSummary} characters`);
    if (t.reason !== undefined && (typeof t.reason !== 'string' || t.reason.length > BRIDGE_LIMITS.maxReason || CONTROL.test(t.reason))) toolProblems.push(`tool ${name}: reason must be plain text up to ${BRIDGE_LIMITS.maxReason} characters`);
    if (t.capability === 'write' || t.capability === 'exec') writeExec.push(name);
    if (t.capability === 'exec' && !(typeof t.reason === 'string' && t.reason.trim().length >= 10)) toolProblems.push(`tool ${name}: an exec tool needs a reason (at least 10 characters) a reviewer can read`);
  }
  checks.push(toolProblems.length ? fail('tools-explicit', toolProblems.slice(0, 8).join('; ')) : ok('tools-explicit', `${tools.length} tools`));

  // ---- excessive scope
  const scope: string[] = [];
  if (writeExec.length > BRIDGE_LIMITS.maxWriteExecTools) scope.push(`${writeExec.length} write/exec tools exceed the limit of ${BRIDGE_LIMITS.maxWriteExecTools}`);
  checks.push(scope.length ? fail('excessive-scope', scope.join('; ')) : ok('excessive-scope', writeExec.length ? `high risk: ${writeExec.length} write/exec tool(s): ${writeExec.slice(0, 10).join(', ')}` : undefined));

  // ---- auth
  const auth = isObj(payload.auth) ? payload.auth : null;
  const authProblems: string[] = [];
  if (auth) {
    if (auth.kind !== 'header') authProblems.push('auth.kind must be "header"');
    if (typeof auth.header !== 'string' || !HEADER_NAME.test(auth.header) || FORBIDDEN_HEADERS.has(auth.header.toLowerCase())) authProblems.push('auth.header must be a plain header name that is not on the forbidden list (Host, Cookie, Content-Type ...)');
    if (auth.scheme !== undefined && (typeof auth.scheme !== 'string' || !SCHEMES.has(auth.scheme))) authProblems.push('auth.scheme must be Bearer, Basic, Token, ApiKey or empty');
    if (typeof auth.secret !== 'string' || !SECRET_NAME.test(auth.secret)) authProblems.push('auth.secret must name a secret field (^[a-z][a-z0-9_]{0,31}$); the value is supplied by the user on their device, never in the package');
  }
  checks.push(authProblems.length ? fail('auth-secret-placeholder-only', authProblems.join('; ')) : ok('auth-secret-placeholder-only'));

  // ---- limits
  const limits = isObj(payload.limits) ? payload.limits : {};
  const limitProblems: string[] = [];
  const num = (k: string, max: number) => {
    const v = limits[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) limitProblems.push(`limits.${k} must be an integer from 1 to ${max}`);
  };
  num('timeout_s', BRIDGE_LIMITS.maxTimeoutS); num('max_rpm', BRIDGE_LIMITS.maxRpm);
  checks.push(limitProblems.length ? fail('limits-capped', limitProblems.join('; ')) : ok('limits-capped'));

  // ---- strings: no control characters anywhere (header injection through payload strings)
  const ctl: string[] = [];
  const stack: Array<[unknown, string]> = [[payload, '$']];
  let seen = 0;
  while (stack.length && seen++ < 4000) {
    const [v, p] = stack.pop()!;
    if (typeof v === 'string') { if (CONTROL.test(v)) ctl.push(p); continue; }
    if (Array.isArray(v)) v.forEach((x, i) => stack.push([x, `${p}[${i}]`]));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (CONTROL.test(k)) ctl.push(`${p}.<key>`); stack.push([x, `${p}.${k.length > 24 ? '<key>' : k}`]); }
  }
  checks.push(ctl.length ? fail('no-control-characters', `control characters or line breaks in ${ctl.slice(0, 5).join(', ')}`) : ok('no-control-characters'));

  // ---- permissions must be exactly what the payload implies (no more, no less)
  checks.push(impliedPermissions(pkg.manifest.permissions, impliedBridgePermissions(payload, host), { blockUnused: true }));
  if (host) {
    const net = pkg.manifest.permissions.filter((p) => p.capability === 'network');
    checks.push(net.length === 1 && net[0].scope.toLowerCase() === host ? ok('host-in-network-scope') : fail('host-in-network-scope', `the manifest must declare exactly one network permission whose scope is the server host ${host}`));
  }
  return checks;
}

export function createBridgeValidator(): Validator {
  return (pkg: UnpackedPackage): ValidationCheck[] => {
    const checks = checkPayload(pkg);
    checks.push(checkNoLiteralSecrets(pkg.manifest.payload, new Set()));
    checks.push(checkOnlyFiles(pkg, FILES_ALLOWED));
    checks.push(riskTierCheck('declarative'));
    return checks;
  };
}
