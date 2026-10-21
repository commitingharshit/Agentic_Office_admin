// Shared, hostile-input-safe helpers for the advanced-type validators (hook, routine, memory, bridge, connector, workflow).
// Everything here treats package content as attacker-controlled: bounded walks (no recursion on untrusted depth), no
// unbounded or backtracking regex over raw input, fail closed on anything it cannot classify.
import type { Validator } from './index.ts';
import { OPERATIONAL } from '../support.ts';
import type { ListingType, PermissionRequest, RiskTier, UnpackedPackage, ValidationCheck } from '../types.ts';

const RISK_TIERS: readonly RiskTier[] = ['data', 'declarative', 'executable'];

// ---------------------------------------------------------------- URLs

const FORBIDDEN_TLDS = new Set(['local', 'localhost', 'internal', 'lan', 'localdomain', 'home', 'corp', 'private', 'intranet', 'test', 'invalid', 'onion', 'arpa', 'example']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z][a-z0-9-]*$/;

/**
 * A public https URL a server may be reached at: https only, port 443 only, a real multi-label DNS name. Parsed by hand from
 * the RAW string (the WHATWG URL parser normalises decimal/octal/hex/IPv6 hosts into forms that look harmless, so it is
 * never the judge). Anything surprising is rejected, never normalised.
 */
export function checkPublicHttpsUrl(raw: string, opts?: { hostAllowlist?: readonly string[] }): { ok: boolean; reason?: string; host?: string } {
  const no = (reason: string) => ({ ok: false, reason });
  if (typeof raw !== 'string' || !raw) return no('URL is empty');
  if (raw.length > 2048) return no('URL is too long');
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return no('URL contains whitespace or control characters');
    if (c > 0x7e) return no('URL contains non-ASCII characters (write internationalised hosts as explicit xn-- names)');
  }
  if (!/^https:\/\//i.test(raw)) return no('URL must start with https://');
  const rest = raw.slice(8);
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) { const ch = rest[i]; if (ch === '/' || ch === '?' || ch === '#' || ch === '\\') { end = i; break; } }
  const authority = rest.slice(0, end);
  if (!authority) return no('URL has no host');
  if (authority.includes('@')) return no('URL must not contain credentials (userinfo)');
  if (authority.includes('%')) return no('URL host must not be percent-encoded');
  if (authority.includes('[') || authority.includes(']')) return no('IP literal hosts are not allowed');
  if (rest[end] === '\\') return no('URL contains a backslash');
  let host = authority, port = '';
  const colon = authority.indexOf(':');
  if (colon >= 0) {
    host = authority.slice(0, colon); port = authority.slice(colon + 1);
    if (port !== '443') return no('Only port 443 is allowed');
  }
  host = host.toLowerCase();
  if (!host) return no('URL has no host');
  if (host.endsWith('.')) return no('Host must not end with a dot');
  if (host.length > 253) return no('Host is too long');
  if (host.includes('..') || host.startsWith('.')) return no('Host has an empty label');
  const labels = host.split('.');
  if (labels.length < 2) return no('Host must be a fully qualified domain name (single-label hosts are internal)');
  for (const l of labels) if (!LABEL.test(l)) return no('Host has an invalid label');
  const tld = labels[labels.length - 1];
  if (!TLD.test(tld)) return no('Host looks like an IP address or numeric name');
  if (FORBIDDEN_TLDS.has(tld)) return no(`Host is in the reserved/internal zone .${tld}`);
  const allowed = new Set((opts?.hostAllowlist ?? []).map((h) => h.toLowerCase()));
  const listed = allowed.has(host);
  if (labels.some((l) => l.startsWith('xn--')) && !listed) return no('Punycode hosts are rejected unless allowlisted');
  if (opts?.hostAllowlist && !listed) return no('Host is not on the allowlist');
  return { ok: true, host };
}

// ---------------------------------------------------------------- secrets

const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['API key (sk-)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/],
  ['AWS access key id', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key block', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
  ['Bearer credential', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ['Basic credential', /\bBasic\s+[A-Za-z0-9+/=]{8,}/i],
  ['URL with embedded password', /:\/\/[^\s/:@]{1,100}:[^\s/@]{1,200}@/],
];
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const TOKENISH = /^[A-Za-z0-9+/_=-]{32,}$/;
const HEXISH = /^[0-9a-fA-F]{32,}$/;

function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const v of n.values()) { const p = v / s.length; h -= p * Math.log2(p); }
  return h;
}
/** Strip invisible characters and fold compatibility forms so `gh​p_...` and fullwidth lookalikes cannot dodge the patterns. */
const normalise = (s: string) => s.normalize('NFKC').replace(/[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯︀-️﻿]/g, '');

function secretIn(str: string, allowed: ReadonlySet<string>): string | null {
  if (str.length > 100_000) return 'string too long to scan';
  let s = normalise(str);
  // ${NAME} is a reference, not a value; only allowlisted names are accepted, the rest is scanned without them
  let unknownPlaceholder: string | null = null;
  s = s.replace(PLACEHOLDER, (_m, name: string) => { if (!allowed.has(name)) unknownPlaceholder ??= name; return ' '; });
  if (unknownPlaceholder) return `placeholder \${${unknownPlaceholder}} is not allowed here`;
  for (const [label, re] of SECRET_PATTERNS) if (re.test(s)) return label;
  for (const tok of s.split(/[\s"',;:=()[\]{}<>|]+/)) {
    if (tok.length < 32 || tok.length > 4096 || !TOKENISH.test(tok)) continue;
    if (HEXISH.test(tok) || entropy(tok) >= 4.0) return 'high-entropy string that looks like a secret';
  }
  return null;
}

/** Passed where placeholders are irrelevant: treats every ${NAME} as acceptable so only real secret patterns count. */
const EVERYTHING: ReadonlySet<string> = { has: () => true } as unknown as ReadonlySet<string>;
const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function* walk(value: unknown, lim: { maxDepth: number; maxKeys: number }): Generator<{ kind: 'string' | 'key' | 'problem'; text: string; path: string }> {
  const stack: Array<{ v: unknown; d: number; p: string }> = [{ v: value, d: 0, p: '$' }];
  let seen = 0;
  while (stack.length) {
    const { v, d, p } = stack.pop()!;
    if (++seen > lim.maxKeys * 4 + 1000) { yield { kind: 'problem', text: 'too many values', path: p }; return; }
    if (typeof v === 'string') { yield { kind: 'string', text: v, path: p }; continue; }
    if (v === null || typeof v !== 'object') continue;
    if (d >= lim.maxDepth) { yield { kind: 'problem', text: 'nested too deeply', path: p }; continue; }
    if (Array.isArray(v)) { v.forEach((x, i) => stack.push({ v: x, d: d + 1, p: `${p}[${i}]` })); continue; }
    for (const k of Object.keys(v as object)) {
      // a key can itself be the secret: it never appears in a path (and so never in a report) unless it is short and clean
      const seg = k.length <= 24 && !secretIn(k, EVERYTHING) ? k : '<key>';
      yield { kind: 'key', text: k, path: `${p}.${seg}` };
      stack.push({ v: (v as Record<string, unknown>)[k], d: d + 1, p: `${p}.${seg}` });
    }
  }
}

/** Walks any JSON value (keys and strings) and fails on anything that looks like a literal credential. `${NAME}` passes only for NAME in `allowedPlaceholders`. */
export function checkNoLiteralSecrets(value: unknown, allowedPlaceholders: ReadonlySet<string>): ValidationCheck {
  const hits: string[] = [];
  for (const w of walk(value, { maxDepth: 64, maxKeys: 5000 })) {
    if (hits.length >= 5) break;
    if (w.kind === 'problem') { hits.push(`${w.path}: ${w.text} to scan`); continue; }
    const why = secretIn(w.text, allowedPlaceholders);
    if (why) hits.push(`${w.path}: ${why}`);   // never echo the value itself
  }
  return { name: 'no-literal-secrets', ok: hits.length === 0, ...(hits.length ? { detail: hits.join('; ') } : {}) };
}

// ---------------------------------------------------------------- bounds

/** Size, depth and key-count caps for a JSON value from a package. Checked without recursion and before any stringify of an oversized value. */
export function checkBounded(value: unknown, lim: { maxBytes: number; maxDepth: number; maxKeys: number }): ValidationCheck {
  const fail = (detail: string): ValidationCheck => ({ name: 'payload-bounded', ok: false, detail });
  let keys = 0, maxD = 0, approx = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (d > maxD) maxD = d;
    if (maxD > lim.maxDepth) return fail(`nested deeper than ${lim.maxDepth}`);
    if (typeof v === 'string') { approx += v.length; if (approx > lim.maxBytes * 4) return fail('too large'); continue; }
    if (v === null || typeof v !== 'object') { approx += 8; continue; }
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as object);
    keys += entries.length;
    if (keys > lim.maxKeys) return fail(`more than ${lim.maxKeys} keys/items`);
    for (const [k, x] of entries) {
      if (!Array.isArray(v) && HOSTILE_KEYS.has(k)) return fail(`reserved key ${JSON.stringify(k)}`);
      approx += k.length; stack.push({ v: x, d: d + 1 });
    }
  }
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(value) ?? '').length; } catch { return fail('not serialisable'); }
  if (bytes > lim.maxBytes) return fail(`${bytes} bytes exceeds the ${lim.maxBytes} byte limit`);
  return { name: 'payload-bounded', ok: true };
}

// ---------------------------------------------------------------- files

const hasPrefix = (b: Uint8Array, ...bytes: number[]) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
function executableKind(b: Uint8Array): string | null {
  if (hasPrefix(b, 0x23, 0x21)) return 'script (#!)';
  if (hasPrefix(b, 0x7f, 0x45, 0x4c, 0x46)) return 'ELF binary';
  if (hasPrefix(b, 0x4d, 0x5a)) return 'Windows executable';
  if (hasPrefix(b, 0xfe, 0xed, 0xfa, 0xce) || hasPrefix(b, 0xfe, 0xed, 0xfa, 0xcf) || hasPrefix(b, 0xce, 0xfa, 0xed, 0xfe) || hasPrefix(b, 0xcf, 0xfa, 0xed, 0xfe) || hasPrefix(b, 0xca, 0xfe, 0xba, 0xbe)) return 'Mach-O binary';
  return null;
}
/** Only files matching `allowed` may ship; an executable by content (shebang, ELF, PE, Mach-O) is refused whatever its name says. */
export function checkOnlyFiles(pkg: UnpackedPackage, allowed: readonly RegExp[]): ValidationCheck {
  const bad: string[] = [];
  for (const [path, bytes] of pkg.files) {
    if (!allowed.some((re) => { re.lastIndex = 0; return re.test(path); })) { bad.push(`${JSON.stringify(path)}: file kind not allowed for this type`); continue; }
    const ex = executableKind(bytes);
    if (ex) bad.push(`${JSON.stringify(path)}: contains an executable (${ex})`);
    if (bad.length >= 10) break;
  }
  return { name: 'only-allowed-files', ok: bad.length === 0, ...(bad.length ? { detail: bad.join('; ') } : {}) };
}

// ---------------------------------------------------------------- permissions

const WILDCARD = /^\s*(?:\*+|\*\.\*|)\s*$/;
/**
 * The manifest must declare every capability the payload IMPLIES (same capability, same scope), and every declared scope
 * must be specific (never empty or `*`). Declared-but-unused capabilities pass with a note, or fail with
 * `blockUnused` (elevated types: an over-declared package must not publish).
 */
export function impliedPermissions(caps: readonly PermissionRequest[], required: readonly PermissionRequest[], opts?: { blockUnused?: boolean }): ValidationCheck {
  const problems: string[] = [];
  const key = (p: PermissionRequest) => `${p.capability}\u0000${p.scope}`;
  const declared = new Map<string, PermissionRequest>();
  for (const c of caps) {
    if (typeof c?.scope !== 'string' || WILDCARD.test(c.scope) || c.scope.includes('*')) problems.push(`${String(c?.capability)}: scope must be specific (no wildcard)`);
    else declared.set(key(c), c);
  }
  for (const r of required) if (!declared.has(key(r))) problems.push(`undeclared: the payload needs ${r.capability} on ${JSON.stringify(r.scope)}`);
  const need = new Set(required.map(key));
  const unused = [...declared.entries()].filter(([k]) => !need.has(k)).map(([, c]) => `${c.capability} on ${JSON.stringify(c.scope)}`);
  if (unused.length && opts?.blockUnused) problems.push(`declared but not used: ${unused.join(', ')}`);
  const ok = problems.length === 0;
  const detail = [...problems, ...(ok && unused.length ? [`note: declared but not used: ${unused.join(', ')}`] : [])].join('; ');
  return { name: 'permissions-match-payload', ok, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------- risk tier and placeholders

/** A validator reports the tier its payload implies with this check; validateArtifact lifts it into ValidationReport.riskTier (never below the type's policy floor). */
export function riskTierCheck(tier: RiskTier): ValidationCheck {
  return { name: 'risk-tier', ok: RISK_TIERS.includes(tier), detail: tier };
}
export function parseRiskTier(checks: readonly ValidationCheck[]): RiskTier | null {
  const c = checks.find((k) => k.name === 'risk-tier');
  return c && c.ok && RISK_TIERS.includes(c.detail as RiskTier) ? (c.detail as RiskTier) : null;
}

/** Until a type's own task replaces its file, the type is explicitly unsupported with the reason from OPERATIONAL. */
export function placeholderValidator(type: ListingType): Validator {
  return () => {
    const e = OPERATIONAL[type];
    return [{ name: 'type-supported', ok: false, detail: `${e?.reason ?? `type ${type} is not supported`}${e?.path ? ` Path: ${e.path}` : ''}` }];
  };
}
