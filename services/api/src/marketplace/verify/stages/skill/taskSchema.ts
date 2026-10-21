// Skill task evaluations: the declaration format (Plan 4 Task 6). A skill package may carry `evals/tasks.json`: up to 5 tasks,
// each with a prompt, input files (base64, sha256-pinned, copied into a scratch workspace), optional expected files and DETERMINISTIC
// checks over the files the run produced. There is no LLM judge and no score. Everything here is untrusted package data.
import { createHash } from 'node:crypto';

export const TASKS_FILE = 'evals/tasks.json';
export const TASKS_SCHEMA = 'agentic.marketplace.skill-evals/1';
export const MAX_TASKS = 5;
export const MAX_TASKS_FILE_BYTES = 1024 * 1024;
export const MAX_TASK_TIMEOUT_SEC = 300;
export const MAX_FILES_PER_TASK = 20;

export interface FileRef { path: string; sha256: string; b64: string }
export type Assertion = { cell?: string; value?: string | number; textContains?: string[]; textExcludes?: string[] };
export type TaskCheck =
  | { kind: 'functional'; file: string; assert: Assertion }
  | { kind: 'integrity'; file: string }
  | { kind: 'render'; file: string; maxBlankPages?: number }
  | { kind: 'fidelity'; file: string; reference: string }
  | { kind: 'diff'; file: string; expected: string; maxDifferingLines?: number }
  | { kind: 'regression'; vs: 'previous-version' };

/** What the declaration says (still base64). */
export interface DeclaredTask { id: string; prompt: string; inputs: FileRef[]; expected: FileRef[]; timeoutSec: number; checks: TaskCheck[] }
/** What a runner receives: bytes decoded and sha256-verified. */
export interface SkillTask {
  id: string; prompt: string; timeoutSec: number;
  inputs: { path: string; bytes: Uint8Array }[]; expected: { path: string; bytes: Uint8Array }[]; checks: TaskCheck[];
}
export interface TaskRun { transcript: string; outputs: { path: string; bytes: Uint8Array }[]; exitCode: number; timedOut: boolean; incomplete?: string }

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHA = /^[0-9a-f]{64}$/;
const CELL = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
/** Declared/produced workspace paths: relative, no traversal, no odd characters, shallow. */
export function safeRelPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= 120 && !p.startsWith('/') && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,4}$/.test(p) && !p.split('/').some((s) => s === '.' || s === '..' || s.startsWith('.') && s.length <= 2);
}

export function parseTasks(bytes: Uint8Array): { tasks: DeclaredTask[] } | { error: string } {
  if (bytes.byteLength > MAX_TASKS_FILE_BYTES) return { error: `${TASKS_FILE} is over ${MAX_TASKS_FILE_BYTES} bytes` };
  let j: any;
  try { j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return { error: `${TASKS_FILE} is not valid UTF-8 JSON` }; }
  if (!j || typeof j !== 'object' || j.schema !== TASKS_SCHEMA || !Array.isArray(j.tasks)) return { error: `${TASKS_FILE}: expected {schema:"${TASKS_SCHEMA}", tasks:[...]}` };
  if (j.tasks.length === 0) return { error: 'no tasks declared' };
  if (j.tasks.length > MAX_TASKS) return { error: `${j.tasks.length} tasks (limit ${MAX_TASKS})` };
  const tasks: DeclaredTask[] = [], seen = new Set<string>();
  for (const t of j.tasks) {
    const e = (m: string) => ({ error: `task ${typeof t?.id === 'string' ? t.id : '?'}: ${m}` });
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id)) return { error: 'task id must match [a-z0-9-]{1,40}' };
    if (seen.has(t.id)) return e('duplicate id'); seen.add(t.id);
    if (typeof t.prompt !== 'string' || !t.prompt || t.prompt.length > 4000) return e('prompt must be a non-empty string up to 4000 characters');
    const timeoutSec = t.timeoutSec ?? 60;
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TASK_TIMEOUT_SEC) return e(`timeoutSec must be an integer 1..${MAX_TASK_TIMEOUT_SEC}`);
    const refs = (name: string): FileRef[] | { error: string } => {
      const a = t[name] ?? [];
      if (!Array.isArray(a) || a.length > MAX_FILES_PER_TASK) return e(`${name} must be an array of at most ${MAX_FILES_PER_TASK} files`);
      const out: FileRef[] = [];
      for (const f of a) {
        if (!f || !safeRelPath(f.path) || typeof f.b64 !== 'string' || typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) return e(`${name}: each file needs a safe relative path, sha256 and b64`);
        out.push({ path: f.path, sha256: f.sha256, b64: f.b64 });
      }
      return out;
    };
    const inputs = refs('inputs'); if ('error' in inputs) return inputs;
    const expected = refs('expected'); if ('error' in expected) return expected;
    if (!Array.isArray(t.checks) || t.checks.length === 0 || t.checks.length > 20) return e('checks must be a non-empty array (max 20)');
    const checks: TaskCheck[] = [];
    for (const c of t.checks) {
      const k = c?.kind;
      if (k === 'regression') { if (c.vs !== 'previous-version') return e('regression.vs must be "previous-version"'); checks.push({ kind: 'regression', vs: 'previous-version' }); continue; }
      if (!safeRelPath(c?.file)) return e(`check ${String(k)}: file must be a safe relative path`);
      if (k === 'functional') {
        const a = c.assert;
        if (!a || typeof a !== 'object') return e('functional needs assert');
        const list = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 500));
        if (!list(a.textContains) || !list(a.textExcludes)) return e('textContains/textExcludes must be arrays of non-empty strings');
        if (a.cell !== undefined && (typeof a.cell !== 'string' || !CELL.test(a.cell))) return e('assert.cell must look like B12');
        if (a.cell !== undefined && !(typeof a.value === 'string' || typeof a.value === 'number')) return e('assert.cell needs assert.value');
        if (a.cell === undefined && !a.textContains?.length && !a.textExcludes?.length) return e('functional assert is empty');
        checks.push({ kind: 'functional', file: c.file, assert: { ...(a.cell ? { cell: a.cell, value: a.value } : {}), ...(a.textContains ? { textContains: a.textContains } : {}), ...(a.textExcludes ? { textExcludes: a.textExcludes } : {}) } });
      } else if (k === 'integrity') checks.push({ kind: 'integrity', file: c.file });
      else if (k === 'render') {
        if (c.maxBlankPages !== undefined && !(Number.isInteger(c.maxBlankPages) && c.maxBlankPages >= 0 && c.maxBlankPages <= 100)) return e('render.maxBlankPages must be an integer 0..100');
        checks.push({ kind: 'render', file: c.file, ...(c.maxBlankPages !== undefined ? { maxBlankPages: c.maxBlankPages } : {}) });
      } else if (k === 'fidelity' || k === 'diff') {
        const ref = k === 'fidelity' ? c.reference : c.expected;
        if (!safeRelPath(ref) || !(expected as FileRef[]).some((f) => f.path === ref)) return e(`${k}: ${k === 'fidelity' ? 'reference' : 'expected'} must name a file in "expected"`);
        if (k === 'fidelity') checks.push({ kind: 'fidelity', file: c.file, reference: ref });
        else {
          if (c.maxDifferingLines !== undefined && !(Number.isInteger(c.maxDifferingLines) && c.maxDifferingLines >= 0 && c.maxDifferingLines <= 1000)) return e('diff.maxDifferingLines must be an integer 0..1000');
          checks.push({ kind: 'diff', file: c.file, expected: ref, ...(c.maxDifferingLines !== undefined ? { maxDifferingLines: c.maxDifferingLines } : {}) });
        }
      } else return e(`unknown check kind ${JSON.stringify(String(k)).slice(0, 40)}`);
    }
    tasks.push({ id: t.id, prompt: t.prompt, inputs, expected, timeoutSec, checks });
  }
  return { tasks };
}

/** Decodes and hash-verifies the files of a declared task. A mismatch is an authoring error (fail), never silently accepted. */
export function materialise(t: DeclaredTask): SkillTask | { error: string } {
  const dec = (refs: FileRef[], what: string): { path: string; bytes: Uint8Array }[] | { error: string } => {
    const out: { path: string; bytes: Uint8Array }[] = [];
    for (const r of refs) {
      const bytes = new Uint8Array(Buffer.from(r.b64, 'base64'));
      if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) return { error: `${what} ${r.path}: sha256 does not match the declared bytes` };
      out.push({ path: r.path, bytes });
    }
    return out;
  };
  const inputs = dec(t.inputs, 'input'); if ('error' in inputs) return inputs;
  const expected = dec(t.expected, 'expected'); if ('error' in expected) return expected;
  return { id: t.id, prompt: t.prompt, timeoutSec: t.timeoutSec, inputs, expected, checks: t.checks };
}

/** Builds a declaration file from in-memory files (used by the fixture runner and tests). */
export function buildTasksFile(tasks: { id: string; prompt: string; timeoutSec?: number; inputs?: { path: string; bytes: Uint8Array }[]; expected?: { path: string; bytes: Uint8Array }[]; checks: TaskCheck[] }[]): Uint8Array {
  const ref = (f: { path: string; bytes: Uint8Array }): FileRef => ({ path: f.path, sha256: createHash('sha256').update(f.bytes).digest('hex'), b64: Buffer.from(f.bytes).toString('base64') });
  return new TextEncoder().encode(JSON.stringify({ schema: TASKS_SCHEMA, tasks: tasks.map((t) => ({ id: t.id, prompt: t.prompt, timeoutSec: t.timeoutSec ?? 60, inputs: (t.inputs ?? []).map(ref), expected: (t.expected ?? []).map(ref), checks: t.checks })) }));
}
