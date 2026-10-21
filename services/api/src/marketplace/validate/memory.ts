// Memory backends (Plan 3 Task 5): a listing is a CONFIG BINDING to a memory provider Hermes already ships. No code, no data,
// no seeds. Everything in the payload is hostile: the provider must be one of the bundled ones, every config key must exist in
// the provider's own published schema, nothing may redirect memory traffic to a host the provider does not already use, secrets
// are env var NAMES from the provider's own schema (never values), and claims Hermes cannot honour (team scope, migration,
// import/export through the marketplace, user-installed provider code) are refused with an explicit reason.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkBounded, checkNoLiteralSecrets, checkOnlyFiles, checkPublicHttpsUrl, impliedPermissions, riskTierCheck } from './advanced-common.ts';
import type { Validator } from './index.ts';
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';

interface ProviderSchema { local: boolean; keys: { key: string; choices?: string[] }[]; secrets: { key: string; env_var: string | null }[]; hasSaveConfig: boolean }
interface Snapshot { schema: string; providers: Record<string, ProviderSchema> }

/** Snapshot of the bundled providers' published config schemas, refreshed by scripts/refresh-memory-schemas.py (a Hermes test fails on drift). */
export function loadMemorySchemas(): Snapshot {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./memory-provider-schemas.json', import.meta.url)), 'utf8')) as Snapshot;
}

/** The service host each REMOTE provider already talks to by default. Data locality is declared from this table, never from the payload. */
export const PROVIDER_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  byterover: 'app.byterover.dev', hindsight: 'api.hindsight.vectorize.io', honcho: 'api.honcho.dev', mem0: 'api.mem0.ai',
  openviking: 'api.vikingdb.cn-beijing.volces.com', retaindb: 'api.retaindb.com', supermemory: 'api.supermemory.ai',
});
export const LOCAL_PROVIDERS: readonly string[] = ['agentic', 'holographic'];

export const SCOPES = ['user', 'agent', 'workspace'] as const;
const ALLOWED_KEYS = new Set(['kind', 'provider', 'scope', 'config', 'secrets']);
/** Keys that claim something this backend cannot do. Named so the rejection says WHY (and the corpus can assert it). */
const UNSUPPORTED_CLAIMS: Record<string, string> = {
  export: 'export is `hermes backup` only; a listing cannot claim an export capability',
  import: 'import is not supported', migrate: 'provider-to-provider migration is not supported', migration: 'provider-to-provider migration is not supported',
  from_provider: 'provider-to-provider migration is not supported', seed: 'a memory listing never carries data', seeds: 'a memory listing never carries data',
  data: 'a memory listing never carries data', memories: 'a memory listing never carries data', code: 'a memory listing never carries code',
  entrypoint: 'a memory listing never carries code', command: 'a memory listing never runs commands', script: 'a memory listing never runs commands',
  install: 'a memory listing never installs packages', pip: 'a memory listing never installs packages', setup: '`hermes memory setup` installs packages and is never run by a listing',
  team: 'team scope is not supported (Hermes has no team notion)', plugin: 'user-installed provider code is not supported', plugin_dir: 'user-installed provider code is not supported',
};
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;
const ENV_DENY_EXACT = new Set(['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'PWD', 'IFS', 'ENV', 'BASH_ENV', 'PS4', 'HERMES_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']);
const ENV_DENY_PREFIX = ['LD_', 'DYLD_', 'PYTHON', 'NODE_', 'HERMES_', 'AGENTICOFFICE_', 'AO_', 'MKT_', 'GIT_', 'SSH_', 'XDG_'];
export function envNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) return 'must be UPPER_SNAKE_CASE, at most 40 characters';
  if (ENV_DENY_EXACT.has(name) || ENV_DENY_PREFIX.some((p) => name.startsWith(p))) return 'is a process-control environment variable and can never be a memory secret';
  return null;
}

const PATHY_KEY = /(?:path|dir|directory|file|folder|root)$/i;
const URLY_KEY = /(?:url|uri|endpoint|host|server)$/i;
/** `$HERMES_HOME/<clean relative path>` is the only path a package may name. */
export function hermesRelativePath(v: string): boolean {
  const m = /^\$HERMES_HOME\/(.+)$/.exec(v);
  if (!m || v.length > 256) return false;
  return m[1].split('/').every((s) => s !== '' && s !== '.' && s !== '..' && /^[A-Za-z0-9._-]+$/.test(s)) && !/\.\.|^\./.test(m[1]);
}
const looksLikePath = (v: string) => /^(?:[/~\\.]|[A-Za-z]:)/.test(v) || v.includes('..') || v.includes('\\') || v.includes('\u0000');

function configProblems(provider: string, schema: ProviderSchema, config: unknown): string[] {
  const out: string[] = [];
  if (config === undefined) return out;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return ['config must be an object of string values'];
  const known = new Map(schema.keys.map((k) => [k.key, k]));
  const host = PROVIDER_HOSTS[provider];
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    const ck = JSON.stringify(k.length > 40 ? k.slice(0, 40) + '...' : k);
    const spec = Object.prototype.hasOwnProperty.call(Object.fromEntries(known), k) ? known.get(k) : undefined;
    if (!spec) { out.push(`config key ${ck} is not in the ${provider} provider's published schema`); continue; }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') { out.push(`config ${ck} must be a string, number or boolean`); continue; }
    const s = String(v);
    if (s.length > 512) { out.push(`config ${ck} is too long`); continue; }
    if (spec.choices && !spec.choices.includes(s)) { out.push(`config ${ck} must be one of ${spec.choices.join(', ')}`); continue; }
    if (s.includes('://') || URLY_KEY.test(k)) {
      const u = checkPublicHttpsUrl(s);
      if (!u.ok) out.push(`config ${ck}: ${u.reason}`);
      else if (!host || u.host !== host) out.push(`config ${ck}: a listing may not redirect memory traffic (the only allowed host for ${provider} is ${host ?? 'none: it is local'})`);
    } else if (PATHY_KEY.test(k) || looksLikePath(s)) {
      if (!hermesRelativePath(s)) out.push(`config ${ck}: paths must be $HERMES_HOME/<relative path> without '..'`);
    }
  }
  return out;
}

export function createMemoryValidator(): Validator {
  return (pkg: UnpackedPackage): ValidationCheck[] => {
    const checks: ValidationCheck[] = [];
    const add = (name: string, problems: string[]) => checks.push({ name, ok: problems.length === 0, ...(problems.length ? { detail: problems.slice(0, 8).join('; ') } : {}) });
    const payload = pkg.manifest.payload as unknown;
    const bounded = checkBounded(payload, { maxBytes: 16 * 1024, maxDepth: 6, maxKeys: 200 });
    checks.push(bounded);
    checks.push(riskTierCheck('declarative'));
    if (!bounded.ok || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      checks.push({ name: 'payload-shape', ok: false, detail: bounded.ok ? 'payload must be an object' : 'payload rejected before inspection' });
      return checks;
    }
    const p = payload as Record<string, unknown>;

    const claims = Object.keys(p).filter((k) => Object.prototype.hasOwnProperty.call(UNSUPPORTED_CLAIMS, k)).map((k) => `${JSON.stringify(k)}: ${UNSUPPORTED_CLAIMS[k]}`);
    add('unsupported-claims', claims);
    add('payload-shape', [
      ...(p.kind === 'memory' ? [] : ['payload.kind must be "memory"']),
      ...Object.keys(p).filter((k) => !ALLOWED_KEYS.has(k) && !Object.prototype.hasOwnProperty.call(UNSUPPORTED_CLAIMS, k)).map((k) => `unknown payload key ${JSON.stringify(k.slice(0, 40))}`),
    ]);

    const snap = (() => { try { return loadMemorySchemas(); } catch { return null; } })();
    if (!snap) { checks.push({ name: 'provider-bundled', ok: false, detail: 'the provider schema snapshot is unavailable (failing closed)' }); return checks; }
    const provider = typeof p.provider === 'string' ? p.provider : '';
    const known = provider !== '' && Object.prototype.hasOwnProperty.call(snap.providers, provider);
    checks.push({ name: 'provider-bundled', ok: known, ...(known ? {} : { detail: `provider ${JSON.stringify(provider.slice(0, 40))} is not a bundled memory provider (${Object.keys(snap.providers).join(', ')}); listings never ship provider code` }) });

    const scope = p.scope;
    const scopeOk = typeof scope === 'string' && (SCOPES as readonly string[]).includes(scope);
    checks.push({ name: 'scope-supported', ok: scopeOk, ...(scopeOk ? {} : { detail: scope === 'team' ? 'team scope is not supported: Hermes has no team notion. Use user, agent or workspace' : `scope must be one of ${SCOPES.join(', ')}` }) });

    const schema = known ? snap.providers[provider] : undefined;
    add('config-keys-known', schema ? configProblems(provider, schema, p.config) : ['no provider to check the config against']);

    // secrets: env var NAMES, taken from the provider's own schema, never values
    const secretProblems: string[] = [];
    const declared: PermissionRequest[] = [];
    const sec = p.secrets;
    if (sec !== undefined && !Array.isArray(sec)) secretProblems.push('secrets must be a list');
    else if (Array.isArray(sec)) {
      if (sec.length > 8) secretProblems.push('too many secrets');
      const seen = new Set<string>();
      for (const s of sec.slice(0, 8)) {
        if (s === null || typeof s !== 'object' || Array.isArray(s)) { secretProblems.push('each secret must be {key, env_var}'); continue; }
        const o = s as Record<string, unknown>;
        const extra = Object.keys(o).filter((k) => k !== 'key' && k !== 'env_var');
        if (extra.length) secretProblems.push(`a secret takes only key and env_var, not ${JSON.stringify(extra[0].slice(0, 20))} (secrets never carry values)`);
        const bad = envNameProblem(o.env_var);
        if (bad) { secretProblems.push(`secret env_var ${bad}`); continue; }
        const name = o.env_var as string;
        if (seen.has(name)) secretProblems.push(`secret ${name} is listed twice`);
        seen.add(name);
        const spec = schema?.secrets.find((x) => x.key === o.key && x.env_var === name);
        if (!spec) secretProblems.push(`secret ${JSON.stringify(String(o.key).slice(0, 30))} / ${name} is not a secret field of the ${provider || 'chosen'} provider`);
        declared.push({ capability: 'secrets.use', scope: name, reason: '' });
      }
    }
    add('secrets-declared-only', secretProblems);

    checks.push(checkNoLiteralSecrets(payload, new Set()));
    // a memory listing never carries data, seeds or code: only docs may ship next to the manifest
    checks.push(checkOnlyFiles(pkg, [/^README\.md$/i, /^docs\/[A-Za-z0-9][A-Za-z0-9_. -]{0,80}\.(?:md|txt)$/]));

    // data locality is a property of the PROVIDER, not of the payload: local providers need no network permission, remote ones declare their host
    const required: PermissionRequest[] = [...declared];
    if (known) {
      const local = LOCAL_PROVIDERS.includes(provider);
      checks.push({ name: 'data-locality', ok: true, detail: local ? 'local: memories stay on this device' : `remote: memories are sent to ${PROVIDER_HOSTS[provider] ?? 'an unknown host'}` });
      if (!local) {
        const host = PROVIDER_HOSTS[provider];
        if (!host) checks[checks.length - 1] = { name: 'data-locality', ok: false, detail: `no declared service host for ${provider}` };
        else required.push({ capability: 'network', scope: host, reason: '' });
      }
    }
    checks.push(impliedPermissions(pkg.manifest.permissions ?? [], required, { blockUnused: true }));
    return checks;
  };
}
