// Workflow validator (type 'workflow', Plan 3 Task 9): a plan document for the DAG runtime (services/dag-runtime).
// The runtime's own `WorkflowStep` tree is the program; this validator treats the package as hostile and accepts only a
// bounded, allow-listed subset of it: tool steps (tools the package declares AND the install consent lists), parallel /
// map / loop / guard / scope containers with hard caps, and agent steps only when the package says so. Human-approval
// steps are rejected (the runtime has no step type for them), as are shell / exec / external-effect tools, runtime
// references the plan did not earn, regex anywhere, secrets, scripts, and parameters that could fill anything but a
// tool argument or agent text. The same rules run again in Python (services/dag-runtime/src/dag_runtime/plan_cli.py,
// reached through the `validate-plan` CLI, check `plan-parses`) and in the Hermes handler at apply and run time.
//
// Every walk here is iterative: the depth of attacker JSON is never the depth of our stack.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRunner, type Runner } from '../blueprint/pyBridge.ts';
import { checkBounded, checkNoLiteralSecrets, checkOnlyFiles, impliedPermissions, riskTierCheck } from './advanced-common.ts';
import { findRepoRoot } from './skillsGuard.ts';
import { scanHookText } from './hook.ts';
import type { SkillScanner } from './skill.ts';
import type { Validator } from './index.ts';
import type { PermissionRequest, UnpackedPackage, ValidationCheck } from '../types.ts';

// ---------------------------------------------------------------- limits (mirrored in dag_runtime/plan_cli.py)
export const MAX_PAYLOAD_BYTES = 128 * 1024;
export const MAX_NODES = 100;
export const MAX_DEPTH = 6;
export const MAX_RETRIES = 3;
export const MAX_TIMEOUT_S = 600;
export const MAX_DEADLINE_S = 1800;
export const MAX_CHILD_NODES = 20;
export const MAX_MAP_ITEMS = 50;
export const MAX_MAP_WORKERS = 8;
export const MAX_LOOP_ITERATIONS = 5;
export const MAX_PARAMS = 8;
export const MAX_PARAM_LEN = 1000;
export const MAX_PARAM_ITEMS = 20;
export const MAX_AGENT_TEXT = 2048;
const MAX_STEPS_VISITED = 5000;
const MAX_LIST = 8;

const BUDGET_CAPS: Readonly<Record<string, number>> = { max_depth: MAX_DEPTH, max_total_nodes: MAX_NODES, max_parallel_agents: 4, max_parallel_tools: 8, deadline_s: MAX_DEADLINE_S };
const PAYLOAD_KEYS = new Set(['kind', 'plan', 'parameters', 'budget', 'requires']);
const COMMON = ['type', 'id', 'depends_on'];
const STEP_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  tool: new Set([...COMMON, 'server', 'tool', 'arguments', 'timeout_s', 'retries']),
  agent: new Set([...COMMON, 'task', 'context', 'expected_output', 'tier', 'allow_recursion', 'max_child_nodes', 'timeout_s', 'retries', 'profile']),
  sequential: new Set([...COMMON, 'steps']),
  parallel: new Set([...COMMON, 'branches', 'join', 'quorum', 'max_concurrency', 'merge', 'then']),
  map: new Set([...COMMON, 'items', 'worker', 'max_workers', 'join', 'quorum', 'then']),
  loop: new Set([...COMMON, 'body', 'until', 'max_iterations', 'stagnation_patience']),
  guard: new Set([...COMMON, 'body', 'verifier', 'transitions']),
  scope: new Set([...COMMON, 'body', 'scope_name', 'commit']),
};
const PARALLEL_JOINS = new Set(['all', 'any', 'quorum', 'race']);
const GUARD_KEYS = new Set(['kind', 'rules', 'schema', 'on_fail', 'max_repairs', 'default_outcome']);
const PARAM_TYPES = new Set(['string', 'number', 'enum', 'string_list']);
const PARAM_KEYS = new Set(['name', 'type', 'max_len', 'max_items', 'min', 'max', 'options', 'label', 'description']);
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const STEP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g;
const REF = /\$\{([^{}]{0,200})\}/g;
const RUNTIME_REFS = new Set(['item', 'item_index', 'loop.iteration', 'loop.previous.output']);
const NODES_REF = /^nodes\.[A-Za-z0-9_-]{1,64}\.output(\|json[A-Za-z0-9_.[\]]{0,80})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ALLOWED_FILES: readonly RegExp[] = [/^README\.md$/, /^LICENSE(?:\.md|\.txt)?$/, /^docs\/[A-Za-z0-9._-]{1,80}\.(?:md|txt)$/];
/** Name tokens that make a tool exec-class or externally effective. A workflow may call neither. */
const EXEC_TOKENS = new Set(['exec', 'execute', 'shell', 'bash', 'eval', 'sql', 'command', 'sandbox']);
const EFFECT_TOKENS = new Set(['send', 'publish', 'upload', 'post', 'forward', 'share', 'invite', 'push']);

// ---------------------------------------------------------------- tool areas

interface Areas { denied_servers: string[]; servers: Record<string, Record<string, string>> }
let areasCache: Areas | null = null;
/** Snapshot of mcp/shared/tool-taxonomy.json for the servers a workflow may call; test/marketplace-workflow-validate.test.ts fails on drift. */
export function loadToolAreas(): Areas {
  return areasCache ??= JSON.parse(readFileSync(fileURLToPath(new URL('./workflow-tool-areas.json', import.meta.url)), 'utf8')) as Areas;
}
export type ToolClass = { ok: true; area: string } | { ok: false; reason: string };
export function classifyTool(server: string, tool: string): ToolClass {
  const a = loadToolAreas();
  if (a.denied_servers.includes(server)) return { ok: false, reason: `server ${JSON.stringify(server)} is not available to workflows (it reaches other people, the web, or persistent memory)` };
  const tools = Object.prototype.hasOwnProperty.call(a.servers, server) ? a.servers[server] : undefined;
  if (!tools) return { ok: false, reason: `unknown server ${JSON.stringify(server.slice(0, 40))}` };
  const area = Object.prototype.hasOwnProperty.call(tools, tool) ? tools[tool] : undefined;
  if (!area) return { ok: false, reason: `unknown tool ${JSON.stringify(`${server}:${tool}`.slice(0, 80))}` };
  const tokens = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => EXEC_TOKENS.has(t))) return { ok: false, reason: `${tool} is an exec-class tool (workflows may not run code or SQL)` };
  if (tokens.some((t) => EFFECT_TOKENS.has(t))) return { ok: false, reason: `${tool} has an external effect (send, publish, upload, post, share) and is not available to workflows` };
  return { ok: true, area };
}

// ---------------------------------------------------------------- helpers

const ok = (name: string, detail?: string): ValidationCheck => ({ name, ok: true, ...(detail ? { detail } : {}) });
const bad = (name: string, problems: string[]): ValidationCheck => problems.length === 0 ? ok(name) : { name, ok: false, detail: problems.slice(0, MAX_LIST).join('; ') + (problems.length > MAX_LIST ? `; ... and ${problems.length - MAX_LIST} more` : '') };
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const seg = (k: string) => (k.length <= 24 ? k : '<key>');

function* stringsOf(root: unknown, base: string, cap = 4000): Generator<{ path: string; text: string }> {
  const stack: Array<{ v: unknown; p: string }> = [{ v: root, p: base }];
  let n = 0;
  while (stack.length && n++ < cap) {
    const { v, p } = stack.pop()!;
    if (typeof v === 'string') yield { path: p, text: v };
    else if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` }));
    else if (isObj(v)) for (const k of Object.keys(v)) stack.push({ v: v[k], p: `${p}.${seg(k)}` });
  }
}

function* keysOf(root: unknown, cap = 6000): Generator<{ key: string; path: string }> {
  const stack: Array<{ v: unknown; p: string }> = [{ v: root, p: '$' }];
  let n = 0;
  while (stack.length && n++ < cap) {
    const { v, p } = stack.pop()!;
    if (Array.isArray(v)) { v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` })); continue; }
    if (!isObj(v)) continue;
    for (const k of Object.keys(v)) { yield { key: k, path: `${p}.${seg(k)}` }; stack.push({ v: v[k], p: `${p}.${seg(k)}` }); }
  }
}

interface Child { path: string; step: unknown }
function childrenOf(step: Record<string, unknown>, path: string): Child[] {
  const out: Child[] = [];
  const t = step.type;
  if (t === 'sequential' && Array.isArray(step.steps)) step.steps.forEach((s, i) => out.push({ path: `${path}.steps[${i}]`, step: s }));
  if (t === 'parallel' && Array.isArray(step.branches)) step.branches.forEach((s, i) => out.push({ path: `${path}.branches[${i}]`, step: s }));
  if ((t === 'parallel' || t === 'map') && step.then !== undefined && step.then !== null) out.push({ path: `${path}.then`, step: step.then });
  if (t === 'map' && step.worker !== undefined && step.worker !== null) out.push({ path: `${path}.worker`, step: step.worker });
  if ((t === 'loop' || t === 'guard' || t === 'scope') && step.body !== undefined && step.body !== null) out.push({ path: `${path}.body`, step: step.body });
  if (t === 'guard' && isObj(step.transitions)) for (const k of Object.keys(step.transitions)) out.push({ path: `${path}.transitions.${seg(k)}`, step: step.transitions[k] });
  return out;
}

// ---------------------------------------------------------------- the plan walk

export interface ToolUse { server: string; tool: string; path: string }
export interface PlanFacts {
  shape: string[]; acyclic: string[]; caps: string[]; retries: string[]; approval: string[]; agents: string[]; refs: string[]; guards: string[];
  tools: ToolUse[]; agentSteps: number; nodes: number; depth: number;
}

/** One iterative pass over the step tree. Problems are sorted into the check each belongs to. */
export function walkPlan(plan: unknown, agentNodes: boolean): PlanFacts {
  const f: PlanFacts = { shape: [], acyclic: [], caps: [], retries: [], approval: [], agents: [], refs: [], guards: [], tools: [], agentSteps: 0, nodes: 0, depth: 0 };
  const order: Array<{ step: Record<string, unknown>; kids: Record<string, unknown>[] }> = [];
  const stack: Array<{ step: unknown; path: string; depth: number }> = [{ step: plan, path: 'plan', depth: 1 }];
  let visited = 0;
  while (stack.length) {
    const { step, path, depth } = stack.pop()!;
    if (++visited > MAX_STEPS_VISITED) { f.caps.push(`plan has more than ${MAX_STEPS_VISITED} steps`); break; }
    if (!isObj(step)) { f.shape.push(`${path}: a step must be an object`); continue; }
    f.depth = Math.max(f.depth, depth);
    if (depth > MAX_DEPTH) { f.caps.push(`${path}: nested deeper than ${MAX_DEPTH} levels`); continue; }
    const t = step.type;
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(STEP_KEYS, t)) {
      const looksHuman = typeof t === 'string' && /approv|human/i.test(t);
      (looksHuman ? f.approval : f.shape).push(`${path}.type: ${looksHuman ? 'human-approval steps are not supported (the runtime has no step type for them)' : `unknown step type ${JSON.stringify(String(t).slice(0, 40))}`}`);
      continue;
    }
    for (const k of Object.keys(step)) if (!STEP_KEYS[t].has(k)) f.shape.push(`${path}.${seg(k)}: key not allowed on a ${t} step`);
    if (step.id !== undefined && !(typeof step.id === 'string' && STEP_ID_RE.test(step.id))) f.shape.push(`${path}.id: must match ${STEP_ID_RE.source}`);
    if (step.depends_on !== undefined && !(Array.isArray(step.depends_on) && step.depends_on.length <= 20 && step.depends_on.every((d) => typeof d === 'string'))) f.shape.push(`${path}.depends_on: must be a list of at most 20 step ids`);

    if (t === 'tool' || t === 'agent') {
      if (step.retries !== undefined && !(isInt(step.retries) && step.retries >= 0 && step.retries <= MAX_RETRIES)) f.retries.push(`${path}.retries: must be an integer 0..${MAX_RETRIES}`);
      if (step.timeout_s !== undefined && !(isNum(step.timeout_s) && step.timeout_s > 0 && step.timeout_s <= MAX_TIMEOUT_S)) f.retries.push(`${path}.timeout_s: must be a number in (0, ${MAX_TIMEOUT_S}]`);
    }
    if (t === 'tool') {
      if (typeof step.server !== 'string' || typeof step.tool !== 'string') f.shape.push(`${path}: a tool step needs string server and tool`);
      else f.tools.push({ server: step.server, tool: step.tool, path });
      if (step.arguments !== undefined && !isObj(step.arguments)) f.shape.push(`${path}.arguments: must be an object`);
      else for (const s of stringsOf(step.arguments ?? {}, `${path}.arguments`)) refProblems(s.text, s.path, false, f.refs);
    } else if (t === 'agent') {
      f.agentSteps++;
      if (!agentNodes) f.agents.push(`${path}: agent steps need requires.agent_nodes: true`);
      if (step.profile !== undefined) f.agents.push(`${path}.profile: a workflow may not choose a worker profile`);
      if (step.tier !== undefined && !['auto', 'fast', 'smart'].includes(step.tier as string)) f.agents.push(`${path}.tier: must be auto, fast or smart`);
      if (typeof step.task !== 'string' || step.task.trim() === '') f.agents.push(`${path}.task: an agent step needs a task`);
      if (step.allow_recursion !== undefined && typeof step.allow_recursion !== 'boolean') f.agents.push(`${path}.allow_recursion: must be a boolean`);
      if (step.allow_recursion === true && !agentNodes) f.agents.push(`${path}.allow_recursion: recursion needs requires.agent_nodes: true`);
      if (step.max_child_nodes !== undefined && !(isInt(step.max_child_nodes) && step.max_child_nodes >= 0 && step.max_child_nodes <= MAX_CHILD_NODES)) f.caps.push(`${path}.max_child_nodes: must be 0..${MAX_CHILD_NODES}`);
      if (step.allow_recursion === true && step.max_child_nodes === undefined) f.caps.push(`${path}.max_child_nodes: a recursive agent step must set an explicit max_child_nodes (<= ${MAX_CHILD_NODES})`);
      for (const k of ['task', 'context', 'expected_output'] as const) if (typeof step[k] === 'string') refProblems(step[k] as string, `${path}.${k}`, false, f.refs);
    } else if (t === 'parallel') {
      if (step.join !== undefined && !PARALLEL_JOINS.has(step.join as string)) f.shape.push(`${path}.join: must be one of ${[...PARALLEL_JOINS].join(', ')}`);
      if (step.merge !== undefined && !['none', 'concat'].includes(step.merge as string)) f.shape.push(`${path}.merge: must be none or concat (synthesize calls an outside model)`);
    } else if (t === 'map') {
      if (Array.isArray(step.items)) {
        if (step.items.length < 1 || step.items.length > MAX_MAP_ITEMS) f.caps.push(`${path}.items: needs 1..${MAX_MAP_ITEMS} entries`);
        for (const s of stringsOf(step.items, `${path}.items`)) refProblems(s.text, s.path, false, f.refs);
      } else if (typeof step.items === 'string') refProblems(step.items, `${path}.items`, true, f.refs);
      else f.shape.push(`${path}.items: must be a list or a reference string`);
      if (step.max_workers !== undefined && !(isInt(step.max_workers) && step.max_workers >= 1 && step.max_workers <= MAX_MAP_WORKERS)) f.caps.push(`${path}.max_workers: must be 1..${MAX_MAP_WORKERS}`);
    } else if (t === 'loop') {
      if (!(isInt(step.max_iterations) && step.max_iterations >= 1 && step.max_iterations <= MAX_LOOP_ITERATIONS)) f.caps.push(`${path}.max_iterations: required, 1..${MAX_LOOP_ITERATIONS}`);
      if (step.until !== undefined) {
        if (!Array.isArray(step.until)) f.shape.push(`${path}.until: must be a list`);
        else step.until.forEach((r, i) => { if (typeof r !== 'string' || r.length > 200 || /^regex/.test(r.split('::').pop()!)) f.guards.push(`${path}.until[${i}]: must be a short non-regex predicate string`); });
      }
    } else if (t === 'guard') guardProblems(step.verifier, `${path}.verifier`, f.guards);

    const kids = childrenOf(step, path);
    const kidSteps = kids.filter((k) => isObj(k.step)).map((k) => k.step as Record<string, unknown>);
    order.push({ step, kids: kidSteps });
    // sibling dependency rules for chains and fan-outs: depends_on names an EARLIER sibling, ids are unique
    const list = t === 'sequential' ? step.steps : t === 'parallel' ? step.branches : null;
    if (Array.isArray(list)) {
      const seen = new Set<string>();
      list.forEach((c, i) => {
        if (!isObj(c)) return;
        const cid = typeof c.id === 'string' ? c.id : null;
        if (cid && seen.has(cid)) f.acyclic.push(`${path}[${i}]: duplicate step id ${JSON.stringify(cid.slice(0, 40))} among siblings`);
        if (Array.isArray(c.depends_on)) for (const d of c.depends_on) {
          if (typeof d !== 'string') continue;
          if (cid && d === cid) f.acyclic.push(`${path}[${i}]: step ${JSON.stringify(cid)} depends on itself`);
          else if (!seen.has(d)) f.acyclic.push(`${path}[${i}]: depends_on ${JSON.stringify(d.slice(0, 40))} is not an earlier sibling (forward and unknown dependencies could form a cycle)`);
        }
        if (cid) seen.add(cid);
      });
    }
    for (const k of kids) stack.push({ step: k.step, path: k.path, depth: depth + 1 });
  }
  f.nodes = estimateNodes(order);
  return f;
}

function guardProblems(g: unknown, path: string, out: string[]): void {
  if (!isObj(g)) { out.push(`${path}: verifier must be an object`); return; }
  for (const k of Object.keys(g)) if (!GUARD_KEYS.has(k)) out.push(`${path}.${seg(k)}: unknown verifier key`);
  if (g.kind !== 'predicate' && g.kind !== 'json_schema') out.push(`${path}.kind: only predicate and json_schema verifiers are accepted (regex and agent verifiers are not)`);
  if (g.on_fail !== undefined && !['reject', 'repair'].includes(g.on_fail as string)) out.push(`${path}.on_fail: must be reject or repair`);
  if (g.max_repairs !== undefined && !(isInt(g.max_repairs) && g.max_repairs >= 0 && g.max_repairs <= 2)) out.push(`${path}.max_repairs: must be 0..2`);
  if (g.rules !== undefined) {
    if (!Array.isArray(g.rules)) out.push(`${path}.rules: must be a list`);
    else g.rules.forEach((r, i) => { if (typeof r !== 'string' || r.length > 200 || /^regex/.test(r.split('::').pop()!)) out.push(`${path}.rules[${i}]: regex rules and long rules are not accepted`); });
  }
  if (g.schema !== undefined) {
    let size = 0; try { size = JSON.stringify(g.schema).length; } catch { size = Infinity; }
    if (size > 8192) out.push(`${path}.schema: larger than 8 KB`);
    for (const { key, path: p } of keysOf(g.schema, 500)) if (['pattern', 'patternProperties', '$ref', '$dynamicRef'].includes(key)) out.push(`${path}.schema${p.slice(1)}: ${key} is not accepted`);
  }
}

function refProblems(s: string, path: string, allowNodes: boolean, out: string[]): void {
  let n = 0;
  for (const m of s.matchAll(REF)) { n++; const inner = m[1]; if (!RUNTIME_REFS.has(inner) && !(allowNodes && NODES_REF.test(inner))) out.push(`${path}: runtime reference \${...} is not one of item, item_index, loop.iteration, loop.previous.output`); }
  const opens = s.split('${').length - 1;
  if (opens !== n) out.push(`${path}: malformed \${...} reference`);
}

function estimateNodes(order: Array<{ step: Record<string, unknown>; kids: Record<string, unknown>[] }>): number {
  const memo = new Map<unknown, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const { step, kids } = order[i];
    let n: number;
    switch (step.type) {
      case 'tool': case 'agent': n = 1; break;
      case 'map': {
        const per = isObj(step.worker) ? memo.get(step.worker) ?? 0 : 0;
        const count = Array.isArray(step.items) ? step.items.length : isInt(step.max_workers) ? step.max_workers : 4;
        n = count * per + (isObj(step.then) ? memo.get(step.then) ?? 0 : 0); break;
      }
      case 'loop': {
        const body = isObj(step.body) ? memo.get(step.body) ?? 0 : 0;
        n = body * (isInt(step.max_iterations) && step.max_iterations > 0 ? step.max_iterations : 1); break;
      }
      default: n = kids.reduce((a, k) => a + (memo.get(k) ?? 0), 0);
    }
    memo.set(step, n);
  }
  return order.length ? memo.get(order[0].step) ?? 0 : 0;
}

// ---------------------------------------------------------------- parameters

export interface ParamDecl { name: string; type: string; max_len?: number; max_items?: number; min?: number; max?: number; options?: string[] }

function paramProblems(raw: unknown, out: string[]): Map<string, ParamDecl> {
  const declared = new Map<string, ParamDecl>();
  if (raw === undefined) return declared;
  if (!Array.isArray(raw) || raw.length > MAX_PARAMS) { out.push(`parameters: must be a list of at most ${MAX_PARAMS}`); return declared; }
  raw.forEach((p, i) => {
    const at = `parameters[${i}]`;
    if (!isObj(p)) { out.push(`${at}: must be an object`); return; }
    for (const k of Object.keys(p)) if (!PARAM_KEYS.has(k)) out.push(`${at}.${seg(k)}: unknown parameter key`);
    if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) { out.push(`${at}.name: must match ${NAME_RE.source}`); return; }
    if (declared.has(p.name)) out.push(`${at}.name: duplicate parameter name`);
    if (typeof p.type !== 'string' || !PARAM_TYPES.has(p.type)) { out.push(`${at}.type: must be one of ${[...PARAM_TYPES].join(', ')}`); return; }
    if ((p.type === 'string' || p.type === 'string_list') && p.max_len !== undefined && !(isInt(p.max_len) && p.max_len >= 1 && p.max_len <= MAX_PARAM_LEN)) out.push(`${at}.max_len: must be 1..${MAX_PARAM_LEN}`);
    if (p.type === 'string_list' && p.max_items !== undefined && !(isInt(p.max_items) && p.max_items >= 1 && p.max_items <= MAX_PARAM_ITEMS)) out.push(`${at}.max_items: must be 1..${MAX_PARAM_ITEMS}`);
    if (p.type === 'number') for (const k of ['min', 'max'] as const) if (p[k] !== undefined && !(isNum(p[k]) && Math.abs(p[k] as number) <= 1e9)) out.push(`${at}.${k}: must be a finite number within +-1e9`);
    if (p.type === 'enum' && !(Array.isArray(p.options) && p.options.length >= 1 && p.options.length <= 20 && p.options.every((o) => typeof o === 'string' && o.length >= 1 && o.length <= 80 && !CONTROL.test(o)))) out.push(`${at}.options: must be 1..20 short strings`);
    declared.set(p.name, p as unknown as ParamDecl);
  });
  return declared;
}

/** Placeholders `{{name}}` may sit only in tool `arguments` values, agent text, and a map's `items`; never in server, tool, type, profile, id, rules or keys. */
function placeholderProblems(plan: unknown, declared: Map<string, ParamDecl>, out: string[]): void {
  const checkValue = (value: unknown, path: string) => {
    const stack: Array<{ v: unknown; p: string }> = [{ v: value, p: path }];
    let n = 0;
    while (stack.length && n++ < 4000) {
      const { v, p } = stack.pop()!;
      if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, p: `${p}[${i}]` }));
      else if (isObj(v)) for (const k of Object.keys(v)) { if (k.includes('{{') || k.includes('}}')) out.push(`${p}: a placeholder is not allowed in a key`); stack.push({ v: v[k], p: `${p}.${seg(k)}` }); }
      else if (typeof v === 'string') {
        const names = [...v.matchAll(PLACEHOLDER)].map((m) => m[1]);
        if (v.split('{{').length - 1 !== names.length || v.split('}}').length - 1 !== names.length) { out.push(`${p}: malformed {{placeholder}}`); continue; }
        for (const nm of names) {
          const d = declared.get(nm);
          if (!d) out.push(`${p}: placeholder {{${nm}}} is not a declared parameter`);
          else if (d.type === 'string_list' && !/^\s*\{\{\s*[A-Za-z0-9_]+\s*\}\}\s*$/.test(v)) out.push(`${p}: list parameter ${nm} must fill a whole value`);
        }
      }
    }
  };
  const stack: Array<{ s: unknown; p: string }> = [{ s: plan, p: 'plan' }];
  let n = 0;
  while (stack.length && n++ < MAX_STEPS_VISITED) {
    const { s, p } = stack.pop()!;
    if (!isObj(s)) continue;
    const t = s.type;
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (['steps', 'branches', 'then', 'worker', 'body', 'transitions'].includes(k)) continue;
      const allowed = (t === 'tool' && k === 'arguments') || (t === 'agent' && (k === 'task' || k === 'context' || k === 'expected_output')) || (t === 'map' && k === 'items');
      if (allowed) checkValue(v, `${p}.${k}`);
      else for (const x of stringsOf(v, `${p}.${seg(k)}`, 500)) if (x.text.includes('{{') || x.text.includes('}}')) out.push(`${x.path}: a parameter placeholder is not allowed in this field`);
    }
    for (const c of childrenOf(s, p)) stack.push({ s: c.step, p: c.path });
  }
}

// ---------------------------------------------------------------- the plan-parses CLI wrapper

export interface PlanCheckResult { ok: boolean; nodes: number; depth: number; errors: Array<{ path: string; message: string }> }
/** Parses and compiles the document with the DAG runtime's own code. `{unavailable}` = it could not answer (the report is then never verified). */
export type PlanChecker = (doc: unknown) => Promise<PlanCheckResult | { unavailable: string }>;

export interface PlanCheckerOptions { repoRoot?: string; python?: string; timeoutMs?: number; runner?: Runner }
export function createDagPlanChecker(opts: PlanCheckerOptions = {}): PlanChecker {
  return async (doc) => {
    let root: string;
    try { root = resolve(opts.repoRoot ?? findRepoRoot()); } catch (e) { return { unavailable: (e as Error).message }; }
    const src = join(root, 'services', 'dag-runtime', 'src');
    if (!existsSync(join(src, 'dag_runtime', 'plan_cli.py'))) return { unavailable: 'the DAG runtime sources were not found' };
    const venv = join(root, 'services', 'dag-runtime', '.venv', 'bin', 'python');
    const python = opts.python ?? process.env.DAG_RUNTIME_PYTHON ?? (existsSync(venv) ? venv : 'python3');
    const base = await mkdtemp(join(tmpdir(), 'mkt-wf-plan-'));
    try {
      const file = join(base, 'plan.json');
      await writeFile(file, JSON.stringify(doc), { mode: 0o600 });
      const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: base, PYTHONPATH: src, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' };
      const out = await (opts.runner ?? spawnRunner)({ python, argv: ['-B', '-m', 'dag_runtime', 'validate-plan', file], stdin: '', env, cwd: base, timeoutMs: opts.timeoutMs ?? 30_000, maxStdout: 256 * 1024 });
      if (out.timedOut) return { unavailable: 'the plan check timed out' };
      if (out.overflow) return { unavailable: 'the plan check printed too much' };
      let j: any;
      try { j = JSON.parse(out.stdout.trim().split('\n').pop() ?? ''); } catch { return { unavailable: `the plan check did not answer (exit ${out.code})` }; }
      if (!isObj(j) || typeof j.ok !== 'boolean' || !(out.code === 0 || out.code === 1 || out.code === 2)) return { unavailable: 'the plan check gave an unexpected answer' };
      if (j.ok && out.code !== 0) return { unavailable: 'the plan check contradicted itself' };
      const errors = Array.isArray(j.errors) ? j.errors.slice(0, 20).map((e: any) => ({ path: String(e?.path ?? '').slice(0, 120), message: String(e?.message ?? '').slice(0, 300) })) : [];
      return { ok: j.ok, nodes: isInt(j.nodes) ? j.nodes : 0, depth: isInt(j.depth) ? j.depth : 0, errors };
    } finally { await rm(base, { recursive: true, force: true }).catch(() => undefined); }
  };
}

// ---------------------------------------------------------------- the validator

export interface WorkflowValidatorOptions { planChecker?: PlanChecker; scanner?: SkillScanner }

export function createWorkflowValidator(opts: WorkflowValidatorOptions = {}): Validator {
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const checks: ValidationCheck[] = [];
    const payload = pkg.manifest.payload as unknown;
    const bounded = checkBounded(payload, { maxBytes: MAX_PAYLOAD_BYTES, maxDepth: 40, maxKeys: 3000 });
    checks.push(bounded);
    if (!bounded.ok) { checks.push(riskTierCheck('declarative')); return checks; }

    // payload shape: keys, kind, requires, budget
    const shape: string[] = [];
    let plan: unknown, requires: Record<string, unknown> = {};
    let agentNodes = false;
    const servers = new Set<string>();
    if (!isObj(payload)) shape.push('payload must be an object');
    else {
      for (const k of Object.keys(payload)) if (!PAYLOAD_KEYS.has(k)) shape.push(`payload.${seg(k)}: unknown key`);
      if (payload.kind !== 'workflow') shape.push('payload.kind must be "workflow"');
      plan = payload.plan;
      if (!isObj(plan)) shape.push('payload.plan must be a step object');
      if (payload.requires !== undefined && !isObj(payload.requires)) shape.push('payload.requires must be an object');
      else requires = (payload.requires as Record<string, unknown>) ?? {};
      for (const k of Object.keys(requires)) if (k !== 'servers' && k !== 'agent_nodes') shape.push(`payload.requires.${seg(k)}: unknown key`);
      if (requires.agent_nodes !== undefined && typeof requires.agent_nodes !== 'boolean') shape.push('payload.requires.agent_nodes must be a boolean');
      agentNodes = requires.agent_nodes === true;
      if (!Array.isArray(requires.servers) || requires.servers.length > 8 || !requires.servers.every((s) => typeof s === 'string' && SERVER_RE.test(s))) shape.push('payload.requires.servers must be a list of at most 8 server names');
      else for (const s of requires.servers as string[]) servers.add(s);
      if (payload.budget !== undefined) {
        if (!isObj(payload.budget)) shape.push('payload.budget must be an object');
        else for (const [k, v] of Object.entries(payload.budget)) {
          const cap = Object.prototype.hasOwnProperty.call(BUDGET_CAPS, k) ? BUDGET_CAPS[k] : undefined;
          if (cap === undefined) shape.push(`payload.budget.${seg(k)}: unknown budget key`);
          else if (!(isNum(v) && v > 0 && v <= cap)) shape.push(`payload.budget.${k}: must be in (0, ${cap}]`);
        }
      }
    }
    checks.push(bad('workflow-shape', shape));

    // human approval: any key anywhere
    const approval: string[] = [];
    for (const { key, path } of keysOf(payload)) if (/approv|human/i.test(key)) approval.push(`${path}: human-approval steps are not supported (the runtime has no step type for them)`);

    const planOk = isObj(plan);
    const facts = walkPlan(planOk ? plan : {}, agentNodes);
    const skip = (name: string): ValidationCheck => ({ name, ok: false, detail: 'skipped: the payload shape is invalid' });
    checks.push(planOk ? bad('plan-shape', facts.shape) : skip('plan-shape'));
    checks.push(planOk ? bad('acyclic', facts.acyclic) : skip('acyclic'));
    const caps = [...facts.caps];
    if (planOk) {
      if (facts.nodes > MAX_NODES) caps.push(`plan would create ${facts.nodes} nodes; the limit is ${MAX_NODES}`);
      const bn = isObj(payload) && isObj(payload.budget) ? (payload.budget as Record<string, unknown>).max_total_nodes : undefined;
      if (isNum(bn) && facts.nodes > bn) caps.push(`budget.max_total_nodes is ${bn} but the plan needs ${facts.nodes}`);
    }
    checks.push(planOk ? bad('plan-caps', caps) : skip('plan-caps'));
    checks.push(planOk ? bad('retries-bounded', facts.retries) : skip('retries-bounded'));
    checks.push(bad('no-human-approval', [...approval, ...facts.approval]));
    checks.push(planOk ? bad('plan-references', [...facts.refs, ...facts.guards]) : skip('plan-references'));

    // tools declared, classified, and covered by permissions
    const toolProblems: string[] = [];
    const required: PermissionRequest[] = [];
    const seenReq = new Set<string>();
    const addReq = (capability: PermissionRequest['capability'], scope: string, reason: string) => { const k = `${capability}\u0000${scope}`; if (!seenReq.has(k)) { seenReq.add(k); required.push({ capability, scope, reason }); } };
    const writeServers = new Set<string>();
    const highRisk: string[] = [];
    for (const u of facts.tools) {
      if (!servers.has(u.server)) { toolProblems.push(`${u.path}: server ${JSON.stringify(u.server.slice(0, 40))} is not listed in requires.servers`); continue; }
      const c = classifyTool(u.server, u.tool);
      if (!c.ok) { toolProblems.push(`${u.path}: ${c.reason}`); continue; }
      addReq('tool.invoke', `${u.server}:${u.tool}`, `The workflow calls ${u.tool} on ${u.server}`);
      if (c.area === 'edit' || c.area === 'author') { writeServers.add(u.server); highRisk.push(`${u.server}:${u.tool} (${c.area})`); }
    }
    for (const s of servers) if (!facts.tools.some((u) => u.server === s)) toolProblems.push(`requires.servers lists ${JSON.stringify(s)} but no step uses it`);
    for (const s of writeServers) addReq('fs.workspace.write', s, `The workflow may change documents through ${s}`);
    if (facts.agentSteps > 0 && agentNodes) addReq('tool.invoke', 'agent-nodes', 'The workflow starts agent steps');
    if (agentNodes && facts.agentSteps === 0 && planOk) toolProblems.push('requires.agent_nodes is true but the plan has no agent step');
    checks.push(planOk ? bad('tools-declared', toolProblems) : skip('tools-declared'));
    if (highRisk.length) checks.push(ok('high-risk-tools', `changes documents: ${[...new Set(highRisk)].slice(0, 12).join(', ')}`));

    // parameters
    const paramProbs: string[] = [];
    const declared = isObj(payload) ? paramProblems(payload.parameters, paramProbs) : new Map<string, ParamDecl>();
    if (planOk) placeholderProblems(plan, declared, paramProbs);
    checks.push(bad('params-typed', paramProbs));

    // agent steps: flagged, no profile override, text scanned
    checks.push(planOk ? bad('agent-steps-flagged', facts.agents) : skip('agent-steps-flagged'));
    const texts: string[] = [];
    if (planOk) {
      const st: unknown[] = [plan]; let n = 0;
      while (st.length && n++ < MAX_STEPS_VISITED) {
        const s = st.pop();
        if (!isObj(s)) continue;
        if (s.type === 'agent') for (const k of ['task', 'context', 'expected_output'] as const) if (typeof s[k] === 'string') texts.push(s[k] as string);
        for (const c of childrenOf(s, '')) st.push(c.step);
      }
    }
    const scanProblems: string[] = [];
    texts.forEach((t, i) => { const why = scanHookText(t, MAX_AGENT_TEXT); if (why) scanProblems.push(`agent text #${i + 1} ${why}`); });
    if (texts.length === 0) checks.push(ok('agent-task-scan', 'no agent steps'));
    else {
      checks.push(bad('agent-task-scan', scanProblems));
      if (!opts.scanner) checks.push({ name: 'agent-task-scan-guard', ok: true, skipped: true, required: true, detail: 'skipped: no scanner configured' });
      else {
        try {
          const body = texts.join('\n\n---\n\n');
          const r = await opts.scanner(new Map([['SKILL.md', new TextEncoder().encode(`# workflow agent tasks\n\n${body}\n`)]]), 'workflow-agent-tasks');
          checks.push(r.verdict === 'safe' && r.findings.length === 0 ? ok('agent-task-scan-guard') : { name: 'agent-task-scan-guard', ok: false, detail: `verdict ${r.verdict}; ${r.findings.length} finding(s)` });
        } catch (e) { checks.push({ name: 'agent-task-scan-guard', ok: false, detail: `scanner failed: ${e instanceof Error ? e.message : String(e)}` }); }
      }
    }

    // secrets: the payload only (the manifest's own fields are checked elsewhere)
    checks.push(checkNoLiteralSecrets(payload, new Set(['item', 'item_index'])));   // ${item} is the map's own reference, not a secret placeholder

    // permissions
    checks.push(planOk ? impliedPermissions(pkg.manifest.permissions, required, { blockUnused: true }) : skip('permissions-match-payload'));

    // files: docs only
    checks.push(checkOnlyFiles(pkg, ALLOWED_FILES));

    // the runtime's own parser and compiler (REQUIRED for `verified`: without it the report cannot publish)
    const cheap = shape.length === 0 && facts.shape.length === 0 && facts.acyclic.length === 0 && caps.length === 0 && facts.retries.length === 0 && approval.length === 0 && facts.approval.length === 0;
    if (!opts.planChecker) checks.push({ name: 'plan-parses', ok: true, skipped: true, required: true, detail: 'skipped: no DAG plan checker configured' });
    else if (!cheap) checks.push({ name: 'plan-parses', ok: false, detail: 'skipped: the plan already fails the structural checks above' });
    else {
      try {
        const p = payload as Record<string, unknown>;
        const r = await opts.planChecker({ kind: 'workflow', plan, parameters: p.parameters ?? [], budget: p.budget ?? {}, requires });
        if ('unavailable' in r) checks.push({ name: 'plan-parses', ok: true, skipped: true, required: true, detail: `skipped: ${r.unavailable}` });
        else if (r.ok) checks.push(ok('plan-parses', `${r.nodes} node(s), depth ${r.depth}`));
        else checks.push({ name: 'plan-parses', ok: false, detail: r.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ') || 'the runtime rejected the plan' });
      } catch (e) { checks.push({ name: 'plan-parses', ok: true, skipped: true, required: true, detail: `skipped: ${e instanceof Error ? e.message : String(e)}` }); }
    }

    checks.push(riskTierCheck('declarative'));
    return checks;
  };
}
