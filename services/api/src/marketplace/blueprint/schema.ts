// Agent blueprint v1: hand-written, fail-closed parser. A blueprint is DATA: strict key allowlist at every level,
// JSON values only, bounded before it is interpreted. No field can carry a command, a base URL, a credential
// or a path outside the package. The component keys are ECS-shaped (class name -> plain data); there is no ECS code.
import { isRange, parseManifest, pathProblem } from '../manifest.ts';
import { BLUEPRINT_LIMITS as L } from './limits.ts';

export const BLUEPRINT_SCHEMA = 'agentic.agent-blueprint/1' as const;
export const COMPONENT_KEYS = ['modelPolicy', 'skillReferences', 'toolPermissions', 'memoryBinding', 'knowledgeSources',
  'verificationPolicy', 'hookBindings', 'delegationPolicy', 'contextScope', 'schedulingPolicy', 'workflowReferences'] as const;
export type ComponentKey = typeof COMPONENT_KEYS[number];
export const blueprintFileName = 'blueprint.json';
export const SOUL_FILE = 'SOUL.md';
export type Ref = { id: string; range: string };
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface AgentBlueprint {
  schema: typeof BLUEPRINT_SCHEMA;
  identity: { name: string; role: string; description: string; instructionsFile: string };
  objective: { goal: string; successCriteria: string[] };
  executionEnvironments: Array<'desktop' | 'gateway' | 'cron' | 'cloud'>;
  modelPolicy?: { primary: { provider: string; model: string; reasoningEffort?: Effort };
    fallbacks?: Array<{ provider: string; model: string }>; allowProviders?: string[]; localOnly?: boolean; maxCostTier?: 'low' | 'standard' | 'high' };
  skillReferences?: Array<Ref & { required: boolean }>;
  // Task 0 amendment: no 'read-only' mode and no readOnly flag (Hermes has no read-only switch); no approvals 'off'.
  toolPermissions?: { mode: 'ask' | 'auto-edit'; toolsets: string[]; kits: string[]; deny: string[] };
  memoryBinding?: { provider: string; scope: 'agent'; writeApproval: boolean };
  knowledgeSources?: Array<{ name: string; kind: 'workspace' | 'connector' | 'url'; ref: string }>;
  verificationPolicy?: { checks: Array<{ name: string; kind: 'skill' | 'rubric'; ref: string; when: 'before-final' | 'each-edit'; onFail: 'retry' | 'ask' | 'abort'; maxAttempts: number }>; requireEvidence: boolean };
  hookBindings?: Array<{ event: string; hook: Ref }>;
  delegationPolicy?: { maxDepth: number; maxConcurrent: number; childModel?: { provider: string; model: string }; children: Array<Ref & { role: string }> };
  contextScope?: { workspaceAccess: 'none' | 'read' | 'write'; pathGlobs: string[]; includeUserProfile: boolean; maxContextTokens?: number };
  schedulingPolicy?: { triggers: Array<{ kind: 'manual' | 'schedule'; schedule?: string; prompt?: string }> };
  workflowReferences?: Ref[];
}
/** The manifest `payload` of an agent listing: lets search facets be queried without parsing the file. */
export type AgentPayload = { blueprint: 'blueprint.json'; schema: typeof BLUEPRINT_SCHEMA; components: ComponentKey[] };
export type BlueprintDiagnostic = { path: string; code: string; message: string };

export class BlueprintError extends Error {
  readonly path: string; readonly code: string;
  constructor(path: string, code: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'BlueprintError'; this.path = path; this.code = code;
  }
  toDiagnostic(): BlueprintDiagnostic { return { path: this.path, code: this.code, message: this.message }; }
}
const fail = (path: string, code: string, message: string): never => { throw new BlueprintError(path, code, message); };

type Obj = Record<string, unknown>;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---- phase 1: bounded, accessor-free copy of untrusted input. Nothing recurses before the bounds hold. ----
function boundedCopy(raw: unknown): unknown {
  let nodes = 0, bytes = 0;
  const root: { v: unknown } = { v: undefined };
  const stack: Array<{ src: unknown; depth: number; path: string; set: (v: unknown) => void }> = [{ src: raw, depth: 1, path: '', set: v => { root.v = v; } }];
  while (stack.length) {
    const { src, depth, path, set } = stack.pop()!;
    if (++nodes > L.maxNodes) fail(path, 'too_many_nodes', `document has more than ${L.maxNodes} values`);
    if (depth > L.maxDepth + 1) fail(path, 'too_deep', `nesting deeper than ${L.maxDepth}`);
    if (src === null || typeof src === 'boolean') { bytes += 5; set(src); }
    else if (typeof src === 'number') {
      if (!Number.isFinite(src)) fail(path, 'not_json', 'numbers must be finite');
      bytes += 16; set(src);
    } else if (typeof src === 'string') {
      if (src.length > L.maxString) fail(path, 'too_long', `string longer than ${L.maxString} characters`);
      bytes += src.length + 2; set(src);
    } else if (Array.isArray(src)) {
      if (depth > L.maxDepth) fail(path, 'too_deep', `nesting deeper than ${L.maxDepth}`);
      if (src.length > L.maxArray) fail(path, 'too_many_items', `array longer than ${L.maxArray}`);
      const out: unknown[] = new Array(src.length);
      bytes += 2 + src.length;
      for (let i = 0; i < src.length; i++) {
        const d = Object.getOwnPropertyDescriptor(src, i);
        if (!d) fail(`${path}[${i}]`, 'not_json', 'sparse arrays are not allowed');
        if (!('value' in d!)) fail(`${path}[${i}]`, 'accessor', 'accessor properties are not allowed');
        stack.push({ src: d!.value, depth: depth + 1, path: `${path}[${i}]`, set: v => { out[i] = v; } });
      }
      set(out);
    } else if (typeof src === 'object') {
      if (depth > L.maxDepth) fail(path, 'too_deep', `nesting deeper than ${L.maxDepth}`);
      const proto = Object.getPrototypeOf(src);
      if (proto !== Object.prototype && proto !== null) fail(path, 'not_json', 'only plain objects are allowed');
      const keys = Object.keys(src as object);
      if (keys.length > L.maxKeys) fail(path, 'too_many_items', `object with more than ${L.maxKeys} keys`);
      const out: Obj = Object.create(null);
      bytes += 2;
      for (const k of keys) {
        const kp = path ? `${path}.${k}` : k;
        if (FORBIDDEN_KEYS.has(k)) fail(kp, 'forbidden_key', `key ${JSON.stringify(k)} is not allowed`);
        if (k.length > 64) fail(kp, 'too_long', 'key longer than 64 characters');
        const d = Object.getOwnPropertyDescriptor(src, k)!;
        if (!('value' in d)) fail(kp, 'accessor', 'accessor properties are not allowed');
        bytes += k.length + 4;
        stack.push({ src: d.value, depth: depth + 1, path: kp, set: v => { out[k] = v; } });
      }
      set(out);
    } else fail(path, 'not_json', `${typeof src} is not a JSON value`);
    if (bytes > L.maxBytes) fail(path, 'too_large', `document larger than ${L.maxBytes} bytes`);
  }
  return root.v;
}

/** JSON text entry point: the byte cap is checked before JSON.parse, duplicate keys (a parser-differential
 *  smuggling vector) are rejected, then the value goes through the same bounded copy as parseBlueprint. */
export function parseBlueprintText(text: string): AgentBlueprint {
  if (typeof text !== 'string') fail('', 'not_json', 'blueprint must be JSON text');
  if (text.length > L.maxTextBytes || new TextEncoder().encode(text).length > L.maxBytes) fail('', 'too_large', `blueprint.json larger than ${L.maxBytes} bytes`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('', 'not_json', 'blueprint.json is not valid JSON'); }
  const dup = findDuplicateKey(text);
  if (dup) fail(dup, 'duplicate_key', 'duplicate object key');
  return parseBlueprint(value);
}

/** Scans already-validated JSON text for an object that repeats a key (escapes decoded). Returns a path-ish label. */
export function findDuplicateKey(text: string): string | null {
  const stack: Array<Set<string> | null> = [];
  let i = 0, expectKey = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j + 1; continue;
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { stack.pop(); expectKey = false; }
    else if (c === ',') expectKey = stack[stack.length - 1] !== null && stack.length > 0;
    i++;
  }
  return null;
}

// ---- phase 2: structure ----
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
function obj(v: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Obj {
  if (!isObj(v)) return fail(path, 'type', 'must be an object');
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(path ? `${path}.${k}` : k, 'unknown_key', `unknown key ${k}`);
  for (const k of required) if (v[k] === undefined) fail(path ? `${path}.${k}` : k, 'required', `${k} is required`);
  return v;
}
// Control characters (and U+2028/2029/0085 line separators, lone surrogates) never belong in a blueprint string.
const BAD_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufeff\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Credential-shaped strings are refused anywhere in a blueprint (the publish-time scanner in Task 4 is the second layer).
const SECRET_SHAPES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/i];
function text(v: unknown, path: string, max = L.maxString, multiline = false, allowEmpty = false): string {
  if (typeof v !== 'string') return fail(path, 'type', 'must be a string');
  if (!v && !allowEmpty) fail(path, 'empty', 'must not be empty');
  if (v.length > max) fail(path, 'too_long', `must be at most ${max} characters`);
  if (LONE_SURROGATE.test(v)) fail(path, 'bad_unicode', 'contains an unpaired surrogate');
  if (BAD_CHARS.test(v) || (!multiline && /[\n\r\t]/.test(v))) fail(path, 'bad_chars', 'contains control characters');
  if (v !== v.trim() && !multiline) fail(path, 'pattern', 'must not start or end with whitespace');
  for (const re of SECRET_SHAPES) if (re.test(v)) fail(path, 'secret_shape', 'looks like a credential; blueprints never carry secrets');
  return v;
}
function pat(v: unknown, path: string, re: RegExp, what: string, max = 128): string {
  if (typeof v !== 'string') return fail(path, 'type', 'must be a string');
  if (v.length > max || !re.test(v)) fail(path, 'pattern', `must be ${what}`);
  return text(v, path, max);
}
function bool(v: unknown, path: string): boolean { return typeof v === 'boolean' ? v : fail(path, 'type', 'must be a boolean'); }
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return fail(path, 'type', 'must be an integer');
  if (v < min || v > max) fail(path, 'range', `must be between ${min} and ${max}`);
  return v;
}
function oneOf<T extends string>(v: unknown, path: string, set: readonly T[]): T {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) return fail(path, 'enum', `must be one of ${set.join(', ')}`);
  return v as T;
}
function arr(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) return fail(path, 'type', 'must be an array');
  if (v.length > max) fail(path, 'too_many_items', `at most ${max} entries`);
  if (v.length < min) fail(path, 'too_few_items', `at least ${min} entries`);
  return v;
}
function strList(v: unknown, path: string, max: number, each: (s: unknown, p: string) => string, unique = true): string[] {
  const out = arr(v, path, 0, max).map((s, i) => each(s, `${path}[${i}]`));
  if (unique && new Set(out).size !== out.length) fail(path, 'duplicate', 'entries must be unique');
  return out;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;           // toolsets, providers: no wildcard, no separators beyond . _ -
const TOOLSET_RE = /^[a-z][a-z0-9_]*$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;  // no '@' (userinfo), no spaces
const EVENT_RE = /^[a-z][a-z_]*$/;
const LOGICAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** A listing reference. id/range validation is the manifest parser's own (ID_RE, reserved slugs, isRange): we run
 *  the dependency entry through parseManifest instead of re-implementing it, so the two can never drift. */
function ref(v: unknown, path: string, extra: readonly string[] = []): Obj {
  const o = obj(v, path, ['id', 'range', ...extra]);
  const id = text(o.id, `${path}.id`, 128), range = text(o.range, `${path}.range`, 128);
  const self = id === 'bp-check/self' ? 'bp-check/other' : 'bp-check/self';
  try {
    parseManifest({ schema: 'agentic.marketplace/1', id: self, type: 'skill', version: '1.0.0', title: 't', summary: 's', license: 'MIT',
      compat: { app: '^1.0.0' }, dependencies: [{ id, range }], permissions: [], files: [], payload: {} });
  } catch (e: any) {
    fail(`${path}.${String(e?.path ?? '').includes('range') ? 'range' : 'id'}`, 'bad_ref', 'must be a publisher/slug listing id and a semver range');
  }
  if (!isRange(range)) fail(`${path}.range`, 'bad_ref', 'must be a semver range');
  return o;
}
const toRef = (o: Obj): Ref => ({ id: o.id as string, range: o.range as string });
/** Ids that read the same to a person (hyphens removed: pdf-tool / pdftool) must not both appear in one list: one is a look-alike of the other. */
const confusableKey = (id: string): string => id.replace(/-/g, '');
function noConfusable(ids: string[], path: string): void {
  const seen = new Map<string, string>();
  for (const id of ids) {
    const prior = seen.get(confusableKey(id));
    if (prior !== undefined && prior !== id) fail(path, 'confusable_id', `${id} is confusable with ${prior}`);
    seen.set(confusableKey(id), id);
  }
}
function refList(v: unknown, path: string, max: number): Ref[] {
  const out = arr(v, path, 0, max).map((r, i) => toRef(ref(r, `${path}[${i}]`)));
  if (new Set(out.map(r => r.id)).size !== out.length) fail(path, 'duplicate', 'a listing may be referenced once');
  noConfusable(out.map(r => r.id), path);
  return out;
}
function modelRef(v: unknown, path: string, extra: readonly string[] = []): Obj {
  const o = obj(v, path, ['provider', 'model', ...extra], ['provider', 'model']);
  return { provider: pat(o.provider, `${path}.provider`, NAME_RE, 'a provider name ([a-z0-9._-])', 64), model: pat(o.model, `${path}.model`, MODEL_RE, 'a model id', 128) };
}

const ENVS = ['desktop', 'gateway', 'cron', 'cloud'] as const;

/** Parse untrusted blueprint data. Throws BlueprintError {path, code}. Bounded before it recurses. */
export function parseBlueprint(input: unknown): AgentBlueprint {
  const raw = boundedCopy(input);
  const top = obj(raw, '', ['schema', 'identity', 'objective', 'executionEnvironments', ...COMPONENT_KEYS], ['schema', 'identity', 'objective', 'executionEnvironments']);
  if (top.schema !== BLUEPRINT_SCHEMA) fail('schema', 'schema', `must be '${BLUEPRINT_SCHEMA}'`);
  const idn = obj(top.identity, 'identity', ['name', 'role', 'description', 'instructionsFile']);
  const instr = text(idn.instructionsFile, 'identity.instructionsFile', 240);
  const pp = pathProblem(instr);
  if (pp) fail('identity.instructionsFile', 'path', pp);
  if (instr !== SOUL_FILE) fail('identity.instructionsFile', 'path', `must be exactly ${SOUL_FILE}`);
  const out: AgentBlueprint = {
    schema: BLUEPRINT_SCHEMA,
    identity: { name: text(idn.name, 'identity.name', 80), role: text(idn.role, 'identity.role', 120), description: text(idn.description, 'identity.description', L.maxString, true), instructionsFile: instr },
    objective: (() => {
      const o = obj(top.objective, 'objective', ['goal', 'successCriteria']);
      return { goal: text(o.goal, 'objective.goal', L.maxString, true),
        successCriteria: arr(o.successCriteria, 'objective.successCriteria', 1, 32).map((s, i) => text(s, `objective.successCriteria[${i}]`, 500)) };
    })(),
    executionEnvironments: strList(top.executionEnvironments, 'executionEnvironments', 4, (s, p) => oneOf(s, p, ENVS)) as AgentBlueprint['executionEnvironments'],
  };
  if (!out.executionEnvironments.length) fail('executionEnvironments', 'too_few_items', 'at least one environment');

  if (top.modelPolicy !== undefined) {
    const o = obj(top.modelPolicy, 'modelPolicy', ['primary', 'fallbacks', 'allowProviders', 'localOnly', 'maxCostTier'], ['primary']);
    const pr = modelRef(o.primary, 'modelPolicy.primary', ['reasoningEffort']);
    const prim = obj(o.primary, 'modelPolicy.primary', ['provider', 'model', 'reasoningEffort'], ['provider', 'model']);
    const mp: NonNullable<AgentBlueprint['modelPolicy']> = { primary: { provider: pr.provider as string, model: pr.model as string } };
    if (prim.reasoningEffort !== undefined) mp.primary.reasoningEffort = oneOf(prim.reasoningEffort, 'modelPolicy.primary.reasoningEffort', ['minimal', 'low', 'medium', 'high', 'xhigh']);
    if (o.fallbacks !== undefined) mp.fallbacks = arr(o.fallbacks, 'modelPolicy.fallbacks', 0, 8).map((f, i) => modelRef(f, `modelPolicy.fallbacks[${i}]`) as { provider: string; model: string });
    if (o.allowProviders !== undefined) mp.allowProviders = strList(o.allowProviders, 'modelPolicy.allowProviders', 16, (s, p) => pat(s, p, NAME_RE, 'a provider name', 64));
    if (o.localOnly !== undefined) mp.localOnly = bool(o.localOnly, 'modelPolicy.localOnly');
    if (o.maxCostTier !== undefined) mp.maxCostTier = oneOf(o.maxCostTier, 'modelPolicy.maxCostTier', ['low', 'standard', 'high']);
    out.modelPolicy = mp;
  }
  if (top.skillReferences !== undefined) {
    const list = arr(top.skillReferences, 'skillReferences', 0, L.maxArray).map((r, i) => {
      const o = ref(r, `skillReferences[${i}]`, ['required']);
      if (o.required === undefined) fail(`skillReferences[${i}].required`, 'required', 'required is required');
      return { ...toRef(o), required: bool(o.required, `skillReferences[${i}].required`) };
    });
    if (new Set(list.map(r => r.id)).size !== list.length) fail('skillReferences', 'duplicate', 'a skill may be referenced once');
    noConfusable(list.map(r => r.id), 'skillReferences');
    out.skillReferences = list;
  }
  if (top.toolPermissions !== undefined) {
    const o = obj(top.toolPermissions, 'toolPermissions', ['mode', 'toolsets', 'kits', 'deny']);
    out.toolPermissions = {
      mode: oneOf(o.mode, 'toolPermissions.mode', ['ask', 'auto-edit']),
      toolsets: strList(o.toolsets, 'toolPermissions.toolsets', L.maxArray, (s, p) => pat(s, p, TOOLSET_RE, 'a toolset name (no wildcards)', 64)),
      kits: strList(o.kits, 'toolPermissions.kits', 16, (s, p) => pat(s, p, TOOLSET_RE, 'a kit name (no wildcards)', 64)),
      deny: strList(o.deny, 'toolPermissions.deny', L.maxArray, (s, p) => pat(s, p, TOOLSET_RE, 'a tool or toolset name', 64)),
    };
  }
  if (top.memoryBinding !== undefined) {
    const o = obj(top.memoryBinding, 'memoryBinding', ['provider', 'scope', 'writeApproval']);
    out.memoryBinding = { provider: pat(o.provider, 'memoryBinding.provider', NAME_RE, 'a memory provider name', 64), scope: oneOf(o.scope, 'memoryBinding.scope', ['agent']), writeApproval: bool(o.writeApproval, 'memoryBinding.writeApproval') };
  }
  if (top.knowledgeSources !== undefined) {
    out.knowledgeSources = arr(top.knowledgeSources, 'knowledgeSources', 0, 32).map((s, i) => {
      const p = `knowledgeSources[${i}]`, o = obj(s, p, ['name', 'kind', 'ref']);
      const kind = oneOf(o.kind, `${p}.kind`, ['workspace', 'connector', 'url']);
      const name = text(o.name, `${p}.name`, 80);
      let r = text(o.ref, `${p}.ref`, 500);
      if (kind === 'url') {
        let u: URL;
        try { u = new URL(r); } catch { return fail(`${p}.ref`, 'pattern', 'must be an https URL'); }
        if (u.protocol !== 'https:' || u.username || u.password || /@/.test(r.split('?')[0].replace(/^https:\/\//, '').split('/')[0]) || u.search || u.hash)
          fail(`${p}.ref`, 'pattern', 'must be a plain https URL without userinfo, query or fragment');
      } else if (kind === 'workspace') {
        const prob = pathProblem(r);
        if (prob) fail(`${p}.ref`, 'path', prob);
      } else r = pat(r, `${p}.ref`, LOGICAL_RE, 'a logical connector name', 200);
      return { name, kind, ref: r };
    });
  }
  if (top.verificationPolicy !== undefined) {
    const o = obj(top.verificationPolicy, 'verificationPolicy', ['checks', 'requireEvidence']);
    out.verificationPolicy = {
      checks: arr(o.checks, 'verificationPolicy.checks', 0, 16).map((c, i) => {
        const p = `verificationPolicy.checks[${i}]`, k = obj(c, p, ['name', 'kind', 'ref', 'when', 'onFail', 'maxAttempts']);
        const kind = oneOf(k.kind, `${p}.kind`, ['skill', 'rubric']);
        const r = kind === 'skill' ? toRef(ref({ id: k.ref, range: '*' }, p)).id : pat(k.ref, `${p}.ref`, LOGICAL_RE, 'a logical rubric name', 200);
        return { name: text(k.name, `${p}.name`, 80), kind, ref: r, when: oneOf(k.when, `${p}.when`, ['before-final', 'each-edit']),
          onFail: oneOf(k.onFail, `${p}.onFail`, ['retry', 'ask', 'abort']), maxAttempts: int(k.maxAttempts, `${p}.maxAttempts`, 1, 5) };
      }),
      requireEvidence: bool(o.requireEvidence, 'verificationPolicy.requireEvidence'),
    };
  }
  if (top.hookBindings !== undefined) {
    out.hookBindings = arr(top.hookBindings, 'hookBindings', 0, 16).map((h, i) => {
      const p = `hookBindings[${i}]`, o = obj(h, p, ['event', 'hook']);
      return { event: pat(o.event, `${p}.event`, EVENT_RE, 'a hook event name', 64), hook: toRef(ref(o.hook, `${p}.hook`)) };
    });
  }
  if (top.delegationPolicy !== undefined) {
    const o = obj(top.delegationPolicy, 'delegationPolicy', ['maxDepth', 'maxConcurrent', 'childModel', 'children'], ['maxDepth', 'maxConcurrent', 'children']);
    const dp: NonNullable<AgentBlueprint['delegationPolicy']> = {
      maxDepth: int(o.maxDepth, 'delegationPolicy.maxDepth', 1, 5), maxConcurrent: int(o.maxConcurrent, 'delegationPolicy.maxConcurrent', 1, 16),
      children: arr(o.children, 'delegationPolicy.children', 0, 16).map((c, i) => {
        const r = ref(c, `delegationPolicy.children[${i}]`, ['role']);
        if (r.role === undefined) fail(`delegationPolicy.children[${i}].role`, 'required', 'role is required');
        return { ...toRef(r), role: text(r.role, `delegationPolicy.children[${i}].role`, 120) };
      }),
    };
    if (new Set(dp.children.map(c => c.id)).size !== dp.children.length) fail('delegationPolicy.children', 'duplicate', 'a child may be listed once');
    noConfusable(dp.children.map(c => c.id), 'delegationPolicy.children');
    if (o.childModel !== undefined) dp.childModel = modelRef(o.childModel, 'delegationPolicy.childModel') as { provider: string; model: string };
    out.delegationPolicy = dp;
  }
  if (top.contextScope !== undefined) {
    const o = obj(top.contextScope, 'contextScope', ['workspaceAccess', 'pathGlobs', 'includeUserProfile', 'maxContextTokens'], ['workspaceAccess', 'pathGlobs', 'includeUserProfile']);
    const cs: NonNullable<AgentBlueprint['contextScope']> = {
      workspaceAccess: oneOf(o.workspaceAccess, 'contextScope.workspaceAccess', ['none', 'read', 'write']),
      pathGlobs: strList(o.pathGlobs, 'contextScope.pathGlobs', 32, (s, p) => {
        const g = text(s, p, 200);
        if (/(^|\/)\.\.(\/|$)/.test(g) || g.startsWith('/') || g.startsWith('~') || g.includes('\\') || /^[A-Za-z]:/.test(g)) fail(p, 'path', 'must be a relative glob inside the workspace');
        return g;
      }),
      includeUserProfile: bool(o.includeUserProfile, 'contextScope.includeUserProfile'),
    };
    if (o.maxContextTokens !== undefined) cs.maxContextTokens = int(o.maxContextTokens, 'contextScope.maxContextTokens', 1000, 2_000_000);
    out.contextScope = cs;
  }
  if (top.schedulingPolicy !== undefined) {
    const o = obj(top.schedulingPolicy, 'schedulingPolicy', ['triggers']);
    out.schedulingPolicy = { triggers: arr(o.triggers, 'schedulingPolicy.triggers', 0, 16).map((t, i) => {
      const p = `schedulingPolicy.triggers[${i}]`, k = obj(t, p, ['kind', 'schedule', 'prompt'], ['kind']);
      const kind = oneOf(k.kind, `${p}.kind`, ['manual', 'schedule']);
      const tr: { kind: typeof kind; schedule?: string; prompt?: string } = { kind };
      if (kind === 'schedule' && k.schedule === undefined) fail(`${p}.schedule`, 'required', 'a schedule trigger needs a schedule');
      if (kind === 'manual' && k.schedule !== undefined) fail(`${p}.schedule`, 'unknown_key', 'a manual trigger has no schedule');
      if (k.schedule !== undefined) tr.schedule = text(k.schedule, `${p}.schedule`, 120);
      if (k.prompt !== undefined) tr.prompt = text(k.prompt, `${p}.prompt`, L.maxString, true);
      return tr;
    }) };
  }
  if (top.workflowReferences !== undefined) out.workflowReferences = refList(top.workflowReferences, 'workflowReferences', 16);
  return out;
}

/** Component keys present on a parsed blueprint, in COMPONENT_KEYS order (the manifest payload `components`). */
export function presentComponents(bp: AgentBlueprint): ComponentKey[] {
  return COMPONENT_KEYS.filter(k => bp[k] !== undefined);
}
