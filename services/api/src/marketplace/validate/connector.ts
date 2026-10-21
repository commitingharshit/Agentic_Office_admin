// Connector validator (type 'connector', Plan 3 Task 8). A connector package is the PUBLIC DEFINITION of a service connection:
// an endpoint template, a query contract (the MCP tools it may expose), the auth kind (none | api_key | bearer), the fields the
// user must supply, a health endpoint and a network allowlist. The PRIVATE INSTANCE (credentials, the user's host and
// workspace values) exists only on the user's device and is never part of a package, a catalog row or installs/sync.
//
// Everything in the payload is attacker-controlled. Unknown keys are errors. oauth2 is rejected with a reason and a path (there
// is no third-party token broker). A field `pattern` is parsed with a deliberately tiny linear-time grammar (no groups,
// alternation, backreferences, lookarounds, unescaped dots or nested quantifiers), and the URL template is reasoned about
// statically: placeholders may sit only in the host, only for non-secret fields, and the pattern's fixed suffix plus the
// template's fixed text must keep every possible host inside the declared allowlist. What a static check cannot know (what a
// DNS name resolves to) is checked again by the Hermes handler at apply, verify and call time (netguard.py).
//
// The resolved shape is also run through the bridge validator (a connector IS a configurable wrapper over a bridge), so every
// bridge rule (public https only, no query, explicit tools, forbidden headers, no sampling/stdio, caps) applies unchanged.
import {
  checkBounded, checkNoLiteralSecrets, checkOnlyFiles, checkPublicHttpsUrl, impliedPermissions, riskTierCheck,
} from './advanced-common.ts';
import { createBridgeValidator, devLoopbackAllowed, impliedBridgePermissions } from './bridge.ts';
import type { Validator } from './index.ts';
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';

export const CONNECTOR_LIMITS = Object.freeze({
  maxPayloadBytes: 64 * 1024, maxDepth: 6, maxKeys: 600, maxFields: 8, maxTools: 50, maxAllowlist: 5, maxPattern: 80, maxQuantified: 3,
  maxTemplate: 512, maxValue: 100, maxTimeoutS: 120, maxRpm: 120, maxResponseKb: 1024, maxLabel: 60, maxText: 300,
});

const TOP_KEYS = new Set(['kind', 'service', 'auth', 'fields', 'bridge', 'health', 'limits', 'network_allowlist', 'data_locality']);
const AUTH_KEYS = new Set(['kind', 'header', 'scheme']);
const FIELD_KEYS = new Set(['key', 'label', 'secret', 'pattern', 'default', 'example', 'required']);
const BRIDGE_KEYS = new Set(['url_template', 'transport', 'tools']);
const TOOL_KEYS = new Set(['name', 'capability', 'summary', 'reason']);
const HEALTH_KEYS = new Set(['path', 'expect_status']);
const LIMIT_KEYS = new Set(['timeout_s', 'max_rpm', 'max_response_kb']);
const DL_KEYS = new Set(['description', 'regions']);
const AUTH_KINDS = new Set(['none', 'api_key', 'bearer']);
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,200}$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const SCHEMES = new Set(['', 'Bearer', 'Basic', 'Token', 'ApiKey']);
const REGION = /^[a-z]{2}(?:-[a-z0-9]{2,12}){0,2}$/;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
/** Credential-shaped keys: an oauth-style connector is rejected whatever it calls itself. */
const OAUTH_KEY = /^(oauth|oauth2|oidc|openid|saml|client_id|client_secret|refresh_token|token_url|authorize_url|authorization_url|redirect_uri|redirect_uris|scopes?)$/i;
const STDIO_KEY = /^(command|args|env|cwd|stdio|shell|executable|sampling|roots|elicitation)$/i;
const FILES_ALLOWED: readonly RegExp[] = [/^README\.md$/, /^docs\/[A-Za-z0-9._-]+\.md$/];
/** Public suffixes a `*.zone` entry must not be: a wildcard over one of these covers unrelated organisations. Not the full PSL (documented gap). */
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'co.in', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'co.za',
  'co.kr', 'com.hk', 'com.tw', 'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'appspot.com', 'azurewebsites.net', 'cloudfront.net',
  'amazonaws.com', 'blogspot.com', 'web.app', 'firebaseapp.com', 'onrender.com', 'fly.dev', 'ngrok.io', 'trycloudflare.com',
]);
const FORBIDDEN_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'localdomain', 'home', 'corp', 'private', 'intranet', 'test', 'invalid', 'onion', 'arpa', 'example']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ok = (name: string, detail?: string): ValidationCheck => ({ name, ok: true, ...(detail ? { detail } : {}) });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = (s: unknown, max: number): s is string => typeof s === 'string' && s.length >= 1 && s.length <= max && !CONTROL.test(s);
const placeholders = (s: string): string[] => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);

// ---------------------------------------------------------------- the pattern grammar

export interface PatternToken { kind: 'lit' | 'class'; chars: string; min: number; max: number; quantified: boolean }
export type PatternOk = { ok: true; tokens: PatternToken[]; minLen: number; maxLen: number; source: string };
export type PatternResult = PatternOk | { ok: false; reason: string };

/**
 * `^ atom* $` where an atom is a literal character (a-z A-Z 0-9 - _), `\.`, `\-`, or a positive class `[...]` of ranges a-z, A-Z,
 * 0-9 and the characters `- _ .`, optionally followed by ONE of `?`, `+`, `*`, `{n}`, `{n,m}` (m <= 63). No groups, alternation,
 * backreferences, lookarounds, unescaped `.`, negated classes or nested/stacked quantifiers. At most three quantified atoms, so
 * the worst-case matching cost is a small polynomial on a value capped at 100 characters. The Hermes handler implements the same grammar.
 */
export function parseFieldPattern(src: unknown): PatternResult {
  const no = (reason: string): PatternResult => ({ ok: false, reason });
  if (typeof src !== 'string') return no('pattern must be a string');
  if (src.length > CONNECTOR_LIMITS.maxPattern) return no(`pattern is longer than ${CONNECTOR_LIMITS.maxPattern} characters`);
  if (!/^[\x20-\x7e]*$/.test(src)) return no('pattern must be plain ASCII');
  if (!src.startsWith('^') || !src.endsWith('$') || src.length < 3) return no('pattern must be anchored (^...$)');
  const body = src.slice(1, -1);
  const tokens: PatternToken[] = [];
  const fam = (x: string) => /[a-z]/.test(x) ? 'l' : /[A-Z]/.test(x) ? 'u' : /[0-9]/.test(x) ? 'd' : '';
  let i = 0;
  let quantified = 0;
  while (i < body.length) {
    const c = body[i];
    let tok: PatternToken;
    if (c === '\\') {
      const n = body[i + 1];
      if (n !== '.' && n !== '-') return no('only \\. and \\- may be escaped (no \\d, \\w, backreferences or other escapes)');
      tok = { kind: 'lit', chars: n, min: 1, max: 1, quantified: false }; i += 2;
    } else if (c === '[') {
      const end = body.indexOf(']', i + 1);
      if (end < 0) return no('unterminated character class');
      const inner = body.slice(i + 1, end);
      if (inner.length < 1 || inner.length > 20) return no('character class must have 1-20 characters');
      if (inner.startsWith('^')) return no('negated character classes are not allowed');
      let set = '';
      for (let j = 0; j < inner.length;) {
        const a = inner[j];
        if (a === '\\') return no('escapes inside a character class are not allowed');
        if (inner[j + 1] === '-' && j + 2 < inner.length) {
          const b = inner[j + 2];
          if (!fam(a) || fam(a) !== fam(b) || a > b) return no('character class ranges may only be a-z, A-Z or 0-9');
          for (let k = a.charCodeAt(0); k <= b.charCodeAt(0); k++) set += String.fromCharCode(k);
          j += 3;
        } else {
          if (!/^[A-Za-z0-9_.-]$/.test(a)) return no('character class may only contain letters, digits and - _ .');
          set += a; j += 1;
        }
      }
      tok = { kind: 'class', chars: [...new Set(set)].sort().join(''), min: 1, max: 1, quantified: false }; i = end + 1;
    } else if (/^[A-Za-z0-9_-]$/.test(c)) {
      tok = { kind: 'lit', chars: c, min: 1, max: 1, quantified: false }; i += 1;
    } else if (c === '(' || c === ')' || c === '|') {
      return no('groups and alternation are not allowed');
    } else if (c === '.') {
      return no('an unescaped "." matches any character; write \\. for a literal dot');
    } else {
      return no(`character ${JSON.stringify(c)} is not allowed in a pattern`);
    }
    const q = body[i];
    if (q === '+' || q === '*' || q === '?') {
      tok.min = q === '+' ? 1 : 0; tok.max = q === '?' ? 1 : CONNECTOR_LIMITS.maxValue; tok.quantified = true; i += 1;
    } else if (q === '{') {
      const m = /^\{(\d{1,2})(?:,(\d{1,2}))?\}/.exec(body.slice(i));
      if (!m) return no('malformed {n,m} quantifier');
      const lo = Number(m[1]); const hi = m[2] === undefined ? lo : Number(m[2]);
      if (hi > 63 || lo > hi || hi < 1) return no('quantifier bounds must satisfy 0 <= n <= m <= 63 and m >= 1');
      tok.min = lo; tok.max = hi; tok.quantified = true; i += m[0].length;
    }
    if (tok.quantified) quantified += 1;
    const after = body[i];
    if (after === '+' || after === '*' || after === '?' || after === '{') return no('stacked or nested quantifiers are not allowed');
    tokens.push(tok);
  }
  if (tokens.length === 0) return no('pattern is empty');
  if (quantified > CONNECTOR_LIMITS.maxQuantified) return no(`at most ${CONNECTOR_LIMITS.maxQuantified} quantified parts are allowed`);
  return { ok: true, tokens, minLen: tokens.reduce((n, t) => n + t.min, 0), maxLen: tokens.reduce((n, t) => n + t.max, 0), source: src };
}

/** A shortest value the pattern accepts (at least one character). Used to build a representative host for the static checks. */
function sampleOf(p: PatternOk): string {
  let s = '';
  for (const t of p.tokens) s += (t.kind === 'class' ? (/[a-z0-9]/.exec(t.chars)?.[0] ?? t.chars[0]) : t.chars[0]).repeat(t.min);
  return s || 'a';
}

/** Trailing run of unquantified literal tokens: the part of every possible value that is fixed. */
function fixedSuffix(p: PatternOk): string {
  let s = '';
  for (let i = p.tokens.length - 1; i >= 0; i--) { const t = p.tokens[i]; if (t.kind !== 'lit' || t.quantified) break; s = t.chars + s; }
  return s;
}

/** What a pattern used in a URL host may emit: variable characters can never leave a single DNS label (no dot, colon, slash or at-sign). */
function hostSafeTokens(p: PatternOk): string | null {
  for (const t of p.tokens) {
    if (t.kind === 'class' && !/^[a-z0-9-]+$/.test(t.chars)) return 'a pattern used in a URL may only use lower-case letters, digits and hyphen in its character classes (no uppercase, dots or underscores)';
    if (t.kind === 'lit' && t.quantified && !/^[a-z0-9-]$/.test(t.chars)) return 'a repeated literal in a URL pattern must be a lower-case letter, digit or hyphen';
    if (t.kind === 'lit' && !t.quantified && !/^[a-z0-9.-]$/.test(t.chars)) return 'a literal in a URL pattern may only be a lower-case letter, digit, hyphen or \\.';
  }
  return null;
}

// ---------------------------------------------------------------- allowlist

interface AllowEntry { raw: string; wildcard: boolean; zone: string }
function parseAllowEntry(raw: unknown): { ok: true; entry: AllowEntry } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 253) return no('entries must be host names up to 253 characters');
  if (raw !== raw.toLowerCase()) return no('entries must be lower-case');
  if (/[^a-z0-9.*-]/.test(raw)) return no('entries may only contain letters, digits, hyphen, dots and one leading "*."');
  if (raw.includes('*') && (!raw.startsWith('*.') || raw.indexOf('*', 1) >= 0)) return no('only one wildcard label is allowed and it must be the first: "*.example.com"');
  const wildcard = raw.startsWith('*.');
  const zone = wildcard ? raw.slice(2) : raw;
  if (!zone) return no('empty host');
  if (devLoopbackAllowed() && !wildcard && (zone === '127.0.0.1' || zone === 'localhost')) return { ok: true, entry: { raw, wildcard, zone } };
  const labels = zone.split('.');
  if (labels.length < 2) return no(wildcard ? 'a wildcard over a bare top-level domain is not allowed' : 'a bare single-label host is not allowed');
  if (!labels.every((l) => LABEL.test(l))) return no('invalid host label');
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*$/.test(tld)) return no('top-level domain must be alphabetic (IP addresses are not allowed)');
  if (FORBIDDEN_TLDS.has(tld)) return no(`the .${tld} zone is reserved or internal`);
  if (labels.some((l) => l.startsWith('xn--'))) return no('punycode hosts are not accepted');
  if (wildcard && PUBLIC_SUFFIXES.has(zone)) return no(`"*.${zone}" would cover unrelated organisations (public suffix)`);
  return { ok: true, entry: { raw, wildcard, zone } };
}
const hostCovered = (host: string, e: AllowEntry) => e.wildcard ? host.endsWith('.' + e.zone) && host.length > e.zone.length + 1 : host === e.zone;

// ---------------------------------------------------------------- the payload

interface Field { key: string; label: string; secret: boolean; pattern?: PatternOk; required: boolean }
interface Resolved { fields: Field[]; allow: AllowEntry[]; sampleUrl: string; sampleHost: string; tools: Array<Record<string, unknown>>; authKind: string; header?: string; scheme: string; secretKey?: string }

export function impliedConnectorPermissions(r: { allow: readonly string[]; secretKey?: string; writeTools: readonly string[] }): PermissionRequest[] {
  const out: PermissionRequest[] = r.allow.map((h) => ({ capability: 'network', scope: h, reason: '' }));
  if (r.secretKey) out.push({ capability: 'secrets.use', scope: r.secretKey, reason: '' });
  for (const t of r.writeTools) out.push({ capability: 'tool.invoke', scope: t, reason: '' });
  return out;
}

function checkPayload(pkg: UnpackedPackage): { checks: ValidationCheck[]; resolved?: Resolved; payload?: Record<string, unknown> } {
  const checks: ValidationCheck[] = [];
  const payload = pkg.manifest.payload as unknown;
  const bounded = checkBounded(payload, { maxBytes: CONNECTOR_LIMITS.maxPayloadBytes, maxDepth: CONNECTOR_LIMITS.maxDepth, maxKeys: CONNECTOR_LIMITS.maxKeys });
  checks.push(bounded);
  if (!bounded.ok) return { checks };
  if (!isObj(payload)) { checks.push(fail('payload-shape', 'payload must be an object')); return { checks }; }

  // ---- shape: unknown keys are errors; oauth and stdio get their own reasons
  const shape: string[] = [];
  const oauth: string[] = [];
  const stdio: string[] = [];
  const scan = (o: Record<string, unknown>, allowed: Set<string>, path: string) => {
    for (const k of Object.keys(o)) {
      const shown = k.length > 40 ? '<key>' : k;
      if (OAUTH_KEY.test(k)) oauth.push(`${path}.${shown}`);
      else if (STDIO_KEY.test(k)) stdio.push(`${path}.${shown}`);
      else if (!allowed.has(k)) shape.push(`${path}.${shown}: unknown key`);
    }
  };
  scan(payload, TOP_KEYS, '$');
  if (payload.kind !== 'connector') shape.push('$.kind must be "connector"');
  if (typeof payload.service !== 'string' || !SERVICE_RE.test(payload.service)) shape.push('$.service must match ^[a-z0-9][a-z0-9-]{0,63}$');
  const auth = isObj(payload.auth) ? payload.auth : null;
  if (!auth) shape.push('$.auth must be an object'); else scan(auth, AUTH_KEYS, '$.auth');
  const bridge = isObj(payload.bridge) ? payload.bridge : null;
  if (!bridge) shape.push('$.bridge must be an object'); else scan(bridge, BRIDGE_KEYS, '$.bridge');
  if (payload.health !== undefined) { if (isObj(payload.health)) scan(payload.health, HEALTH_KEYS, '$.health'); else shape.push('$.health must be an object'); }
  if (payload.limits !== undefined) { if (isObj(payload.limits)) scan(payload.limits, LIMIT_KEYS, '$.limits'); else shape.push('$.limits must be an object'); }
  if (payload.data_locality !== undefined) { if (isObj(payload.data_locality)) scan(payload.data_locality, DL_KEYS, '$.data_locality'); else shape.push('$.data_locality must be an object'); }
  const fieldsRaw = Array.isArray(payload.fields) ? payload.fields : null;
  if (!fieldsRaw) shape.push('$.fields must be an array');
  else fieldsRaw.forEach((f, i) => { if (isObj(f)) scan(f, FIELD_KEYS, `$.fields[${i}]`); else shape.push(`$.fields[${i}] must be an object`); });
  const toolsRaw = bridge && Array.isArray(bridge.tools) ? bridge.tools : null;
  if (bridge && !toolsRaw) shape.push('$.bridge.tools must be an array');
  else if (toolsRaw) toolsRaw.forEach((t, i) => { if (isObj(t)) scan(t, TOOL_KEYS, `$.bridge.tools[${i}]`); else shape.push(`$.bridge.tools[${i}] must be an object`); });
  const allowRaw = Array.isArray(payload.network_allowlist) ? payload.network_allowlist : null;
  if (!allowRaw) shape.push('$.network_allowlist must be an array');

  const authKindRaw = auth?.kind;
  const oauthKind = typeof authKindRaw === 'string' && /oauth|oidc|openid|saml/i.test(authKindRaw);
  if (oauth.length || oauthKind) {
    checks.push(fail('auth-kind-supported', `oauth2 connectors are not supported in this release: there is no third-party token broker (no consent flow, refresh or revocation service). Path: a token broker in the control plane is a separate plan; until then use an api_key or bearer connector. Found: ${(oauthKind ? ['$.auth.kind'] : oauth).slice(0, 5).join(', ')}`));
  } else {
    checks.push(typeof authKindRaw === 'string' && AUTH_KINDS.has(authKindRaw) ? ok('auth-kind-supported', authKindRaw) : fail('auth-kind-supported', 'auth.kind must be "none", "api_key" or "bearer"'));
  }
  checks.push(stdio.length ? fail('no-stdio', `connectors reach remote https MCP servers only (no command, sampling, roots or elicitation): ${stdio.slice(0, 5).join(', ')}`) : ok('no-stdio'));
  checks.push(shape.length ? fail('payload-shape', shape.slice(0, 8).join('; ')) : ok('payload-shape'));
  if (shape.length || oauth.length || oauthKind || !auth || !bridge || !fieldsRaw || !toolsRaw || !allowRaw) return { checks, payload };
  if (typeof authKindRaw !== 'string' || !AUTH_KINDS.has(authKindRaw)) return { checks, payload };
  const authKind = authKindRaw;

  // ---- fields
  const problems: string[] = [];
  const fields: Field[] = [];
  const keys = new Set<string>();
  if (fieldsRaw.length > CONNECTOR_LIMITS.maxFields) problems.push(`at most ${CONNECTOR_LIMITS.maxFields} fields`);
  for (const [i, f] of fieldsRaw.slice(0, CONNECTOR_LIMITS.maxFields).entries()) {
    if (!isObj(f)) continue;
    const key = f.key;
    if (typeof key !== 'string' || !FIELD_KEY.test(key)) { problems.push(`$.fields[${i}].key must match ^[a-z][a-z0-9_]{0,31}$`); continue; }
    if (keys.has(key)) { problems.push(`duplicate field ${key}`); continue; }
    keys.add(key);
    if (!plain(f.label, CONNECTOR_LIMITS.maxLabel)) problems.push(`field ${key}: label must be plain text up to ${CONNECTOR_LIMITS.maxLabel} characters`);
    if (typeof f.secret !== 'boolean') problems.push(`field ${key}: "secret" must be true or false`);
    if (f.required !== undefined && typeof f.required !== 'boolean') problems.push(`field ${key}: "required" must be a boolean`);
    const secret = f.secret === true;
    let pattern: PatternOk | undefined;
    if (secret) {
      for (const k of ['pattern', 'default', 'example'] as const) if (f[k] !== undefined) problems.push(`secret field ${key} must not have a ${k} (a credential is never part of a package)`);
    } else {
      if (f.pattern !== undefined) {
        const p = parseFieldPattern(f.pattern);
        if (!p.ok) problems.push(`field ${key}: ${p.reason}`); else pattern = p;
      }
      for (const k of ['default', 'example'] as const) {
        const v = f[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > CONNECTOR_LIMITS.maxValue || CONTROL.test(v)) problems.push(`field ${key}: ${k} must be plain text up to ${CONNECTOR_LIMITS.maxValue} characters`);
        else if (pattern) {
          let m = false;
          try { m = new RegExp(`^(?:${(f.pattern as string).slice(1, -1)})$`).test(v); } catch { m = false; }
          if (!m) problems.push(`field ${key}: ${k} does not match its own pattern`);
        }
      }
    }
    fields.push({ key, label: typeof f.label === 'string' ? f.label : key, secret, ...(pattern ? { pattern } : {}), required: f.required !== false });
  }
  const secretFields = fields.filter((f) => f.secret);
  if (authKind === 'none' && secretFields.length) problems.push('an auth "none" connector must not declare secret fields');
  if (authKind !== 'none' && secretFields.length !== 1) problems.push(`an ${authKind} connector declares exactly one secret field (the credential); found ${secretFields.length}`);
  checks.push(problems.length ? fail('fields-safe', problems.slice(0, 8).join('; ')) : ok('fields-safe', `${fields.length} fields`));

  // ---- auth header
  const headerProblems: string[] = [];
  let header: string | undefined; let scheme = '';
  if (authKind === 'api_key') {
    header = typeof auth.header === 'string' ? auth.header : undefined;
    scheme = typeof auth.scheme === 'string' ? auth.scheme : '';
    if (!header || !HEADER_NAME.test(header)) headerProblems.push('api_key auth needs a plain header name (auth.header)');
    if (!SCHEMES.has(scheme)) headerProblems.push('auth.scheme must be empty, Bearer, Basic, Token or ApiKey');
  } else if (authKind === 'bearer') {
    if (auth.header !== undefined && auth.header !== 'Authorization') headerProblems.push('bearer auth always uses the Authorization header');
    if (auth.scheme !== undefined && auth.scheme !== 'Bearer') headerProblems.push('bearer auth always uses the Bearer scheme');
    header = 'Authorization'; scheme = 'Bearer';
  } else if (auth.header !== undefined || auth.scheme !== undefined) headerProblems.push('an auth "none" connector sends no credential header');
  checks.push(headerProblems.length ? fail('auth-header', headerProblems.join('; ')) : ok('auth-header'));

  // ---- allowlist
  const allow: AllowEntry[] = [];
  const allowProblems: string[] = [];
  if (allowRaw.length < 1 || allowRaw.length > CONNECTOR_LIMITS.maxAllowlist) allowProblems.push(`network_allowlist must have 1-${CONNECTOR_LIMITS.maxAllowlist} entries`);
  for (const [i, e] of allowRaw.slice(0, CONNECTOR_LIMITS.maxAllowlist + 1).entries()) {
    const p = parseAllowEntry(e);
    if (!p.ok) allowProblems.push(`network_allowlist[${i}]: ${p.reason}`);
    else if (allow.some((a) => a.raw === p.entry.raw)) allowProblems.push(`network_allowlist[${i}]: duplicate`);
    else allow.push(p.entry);
  }
  checks.push(allowProblems.length ? fail('allowlist-specific', allowProblems.slice(0, 6).join('; ')) : ok('allowlist-specific', allow.map((a) => a.raw).join(', ')));

  // ---- URL template
  const tmpl = bridge.url_template;
  let sampleUrl: string | undefined; let sampleHost: string | undefined;
  const urlProblems: string[] = [];
  if (typeof tmpl !== 'string' || tmpl.length < 9 || tmpl.length > CONNECTOR_LIMITS.maxTemplate) urlProblems.push(`url_template must be a string of 9-${CONNECTOR_LIMITS.maxTemplate} characters`);
  else if (!/^https:\/\//i.test(tmpl)) urlProblems.push('url_template must start with https://');
  else {
    const rest = tmpl.slice(8);
    const cut = rest.search(/[/?#\\]/);
    const authority = cut < 0 ? rest : rest.slice(0, cut);
    const tail = cut < 0 ? '' : rest.slice(cut);
    const names = placeholders(authority);
    if (/[{}]/.test(authority.replace(/\{[^{}]*\}/g, ''))) urlProblems.push('malformed "{" or "}" in the host of url_template');
    if (/[{}]/.test(tail)) urlProblems.push('braces are not allowed in the URL path: placeholders are only allowed in the host (path smuggling)');
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const sampleFor = new Map<string, string>();
    for (const n of names) {
      const f = byKey.get(n);
      if (!f) urlProblems.push(`placeholder {${n.slice(0, 32)}} is not a declared field`);
      else if (f.secret) urlProblems.push(`placeholder {${n}} names a secret field; a secret can never appear in a URL`);
      else if (!f.pattern) urlProblems.push(`placeholder {${n}} needs a pattern on its field (an unconstrained value can point anywhere)`);
      else {
        const bad = hostSafeTokens(f.pattern);
        if (bad) urlProblems.push(`field ${n}: ${bad}`);
        else if (f.pattern.minLen < 1) urlProblems.push(`field ${n}: the pattern must require at least one character`);
        else sampleFor.set(n, sampleOf(f.pattern));
      }
    }
    if (!urlProblems.length) {
      sampleUrl = `https://${authority.replace(/\{([^{}]*)\}/g, (_m, n: string) => sampleFor.get(n) ?? 'a')}${tail}`;
      let r: { ok: boolean; reason?: string; host?: string } = checkPublicHttpsUrl(sampleUrl);
      const devHost = /^https:\/\/(localhost|127\.0\.0\.1)(?::\d{4,5})?(?=\/|$)/.exec(sampleUrl);
      if (!r.ok && devLoopbackAllowed() && names.length === 0 && devHost) r = { ok: true, host: devHost[1] };
      if (!r.ok) urlProblems.push(r.reason ?? 'not a public https URL');
      else {
        sampleHost = r.host!;
        if (!allow.some((e) => hostCovered(sampleHost!, e))) urlProblems.push(`the host ${sampleHost} is not covered by network_allowlist`);
        if (names.length) {
          // every possible host must end in an allowlisted wildcard zone: the pattern's fixed suffix + the template's fixed text after the last placeholder
          const lastName = names[names.length - 1];
          const marker = '{' + lastName + '}';
          const afterLast = authority.slice(authority.lastIndexOf(marker) + marker.length);
          const suffix = fixedSuffix(byKey.get(lastName)!.pattern!) + afterLast;
          if (!allow.some((e) => e.wildcard && suffix.endsWith('.' + e.zone))) urlProblems.push('the template and the field pattern must FORCE the host to end in an allowlisted wildcard zone (for example pattern ^[a-z0-9-]+\\.example\\.com$ with "*.example.com"); otherwise a value could point the connector at another host');
          const before = authority.slice(0, authority.indexOf('{'));
          if (before && !/^[a-z0-9-]*$/.test(before)) urlProblems.push('text before a placeholder in the host may only be lower-case letters, digits and hyphen');
        }
      }
    }
  }
  checks.push(urlProblems.length ? fail('url-template-bounded', urlProblems.slice(0, 8).join('; ')) : ok('url-template-bounded', sampleHost));

  // ---- query contract (tools): connectors never carry exec tools
  const toolProblems: string[] = [];
  for (const [i, t] of toolsRaw.entries()) if (isObj(t) && t.capability === 'exec') toolProblems.push(`$.bridge.tools[${i}]: a connector exposes read or write tools only (exec tools are bridge-only)`);
  checks.push(toolProblems.length ? fail('tools-no-exec', toolProblems.join('; ')) : ok('tools-no-exec'));

  // ---- health endpoint (the verify operation checks credentials against it)
  const health = isObj(payload.health) ? payload.health : null;
  const healthProblems: string[] = [];
  if (authKind !== 'none' && !health) healthProblems.push('a connector with credentials must declare a health endpoint so the connection can be verified honestly');
  if (health) {
    if (typeof health.path !== 'string' || !HEALTH_PATH.test(health.path) || /(^|\/)\.\.?(\/|$)/.test(health.path) || health.path.includes('//')) healthProblems.push('health.path must be an absolute path of plain characters without dot segments');
    const es = health.expect_status;
    if (es !== undefined && (!Array.isArray(es) || es.length < 1 || es.length > 5 || !es.every((s) => Number.isInteger(s) && (s as number) >= 200 && (s as number) <= 299))) healthProblems.push('health.expect_status must be 1-5 success status codes (200-299)');
  }
  checks.push(healthProblems.length ? fail('health-endpoint', healthProblems.join('; ')) : ok('health-endpoint'));

  // ---- limits
  const limits = isObj(payload.limits) ? payload.limits : {};
  const limitProblems: string[] = [];
  const num = (k: string, max: number) => { const v = limits[k]; if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)) limitProblems.push(`limits.${k} must be an integer from 1 to ${max}`); };
  num('timeout_s', CONNECTOR_LIMITS.maxTimeoutS); num('max_rpm', CONNECTOR_LIMITS.maxRpm); num('max_response_kb', CONNECTOR_LIMITS.maxResponseKb);
  checks.push(limitProblems.length ? fail('limits-capped', limitProblems.join('; ')) : ok('limits-capped'));

  // ---- data locality (public, plain text, shown at install)
  const dl = isObj(payload.data_locality) ? payload.data_locality : null;
  const dlProblems: string[] = [];
  if (dl) {
    if (dl.description !== undefined && !plain(dl.description, CONNECTOR_LIMITS.maxText)) dlProblems.push('data_locality.description must be plain text up to 300 characters');
    if (dl.regions !== undefined && (!Array.isArray(dl.regions) || dl.regions.length > 8 || !dl.regions.every((r) => typeof r === 'string' && REGION.test(r)))) dlProblems.push('data_locality.regions must be up to 8 region codes such as "eu" or "us-east"');
  }
  checks.push(dlProblems.length ? fail('data-locality', dlProblems.join('; ')) : ok('data-locality'));

  const resolved: Resolved | undefined = checks.every((c) => c.ok) && sampleUrl && sampleHost
    ? { fields, allow, sampleUrl, sampleHost, tools: toolsRaw.filter(isObj), authKind, header, scheme, secretKey: secretFields[0]?.key }
    : undefined;
  return { checks, resolved, payload };
}

export function createConnectorValidator(): Validator {
  const bridge = createBridgeValidator();
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const { checks, resolved, payload } = checkPayload(pkg);
    if (resolved && payload) {
      // The resolved shape is a bridge: run every bridge rule on it (URL, tools, header, limits, secrets, control characters).
      const lim = isObj(payload.limits) ? payload.limits : {};
      const bridgePayload: Record<string, unknown> = {
        kind: 'bridge',
        server: { url: resolved.sampleUrl, transport: (payload.bridge as Record<string, unknown>).transport ?? 'streamable-http' },
        tools: resolved.tools,
        ...(resolved.authKind !== 'none' ? { auth: { kind: 'header', header: resolved.header, scheme: resolved.scheme, secret: resolved.secretKey } } : {}),
        limits: { ...(lim.timeout_s !== undefined ? { timeout_s: lim.timeout_s } : {}), ...(lim.max_rpm !== undefined ? { max_rpm: lim.max_rpm } : {}) },
      };
      const synthetic: UnpackedPackage = {
        files: pkg.files,
        manifest: { ...pkg.manifest, type: 'bridge', payload: bridgePayload, permissions: impliedBridgePermissions(bridgePayload, resolved.sampleHost) },
      };
      const inner = await bridge(synthetic);
      // permission, file and secret checks are connector-specific and done below; everything else keeps the bridge's own check name
      for (const c of inner) if (!['permissions-match-payload', 'host-in-network-scope', 'only-allowed-files', 'risk-tier', 'no-literal-secrets'].includes(c.name)) checks.push(c);

      // permissions: exactly what the definition implies; network scopes are the allowlist entries
      const writeTools = resolved.tools.filter((t) => t.capability === 'write').map((t) => String(t.name));
      const implied = impliedConnectorPermissions({ allow: resolved.allow.map((a) => a.raw), secretKey: resolved.secretKey, writeTools });
      const wantNet = new Set(resolved.allow.map((a) => a.raw));
      const gotNet = pkg.manifest.permissions.filter((p) => p.capability === 'network').map((p) => String(p.scope).toLowerCase());
      const netOk = gotNet.length === wantNet.size && new Set(gotNet).size === gotNet.length && gotNet.every((s) => wantNet.has(s));
      checks.push(netOk ? ok('network-scope-matches-allowlist') : fail('network-scope-matches-allowlist', `the manifest must declare exactly one network permission per allowlist entry (${[...wantNet].join(', ')}); a wildcard scope is only allowed as the same "*.zone" entry`));
      checks.push(impliedPermissions(pkg.manifest.permissions.filter((p) => p.capability !== 'network'), implied.filter((p) => p.capability !== 'network'), { blockUnused: true }));
    }
    checks.push(checkNoLiteralSecrets(pkg.manifest.payload, new Set()));
    checks.push(checkOnlyFiles(pkg, FILES_ALLOWED));
    checks.push(riskTierCheck('declarative'));
    return checks;
  };
}
