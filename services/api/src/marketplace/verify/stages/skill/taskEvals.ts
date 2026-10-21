// Stage 8 (opt-in, dynamic): run the skill's declared example tasks and check the produced files with deterministic checkers.
// The default is `skipped: not-enabled` (never a pass). Whether a skip makes the verdict `incomplete` is the pipeline's policy:
// the stage is non-required by default and `required` only when the type's verification policy says so (createSkillPipeline).
// A skill that passes every static stage but fails its task evals is `fail`: it can never be "verified".
import type { Evidence, PipelineResult, StageDef, StageOutput } from '../../types.ts';
import { TASKS_FILE, materialise, parseTasks, type SkillTask, type TaskRun } from './taskSchema.ts';
import { diff, fidelity, functional, integrity, render, sanitizeOutputs, type CheckVerdict } from './taskCheckers.ts';

export const TASK_EVALS_STAGE_ID = 'task-evals';
const TRANSCRIPT_BLOB_BYTES = 64 * 1024;

/** Thrown by a runner that cannot contain the run (no sandbox, no network denial): the stage is skipped, never evaluated. */
export class RunnerUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string, msg?: string) { super(msg ?? reason); this.name = 'RunnerUnavailable'; this.reason = reason; }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const taskLabel = (id: string, status: string) => `task:${id}: ${status}`;

function previousPassed(prev: PipelineResult | undefined): Set<string> | undefined {
  const s = prev?.stages.find((x) => x.id === TASK_EVALS_STAGE_ID);
  if (!s) return undefined;
  const ids = new Set<string>();
  for (const e of s.evidence) { const m = /^task:([a-z0-9-]+): pass$/.exec(e.label); if (m) ids.add(m[1]); }
  return ids;
}

export function createTaskEvalsStage(o: { required?: boolean; timeoutMs?: number } = {}): StageDef {
  return {
    id: TASK_EVALS_STAGE_ID, title: 'Skill task evaluations (fixtures, deterministic checks)', required: o.required === true, timeoutMs: o.timeoutMs ?? 1_800_000, after: ['manifest'],
    async run(ctx): Promise<StageOutput> {
      const runner = ctx.tools.hermes;
      if (!runner) return { status: 'skipped', reason: 'not-enabled', evidence: [{ kind: 'text', label: 'task evaluations are opt-in', detail: 'no task runner is configured on this verifier' }] };
      const file = ctx.pkg.files.get(TASKS_FILE);
      if (!file) return { status: 'skipped', reason: 'no-evals-declared', evidence: [] };
      const parsed = parseTasks(file);
      if ('error' in parsed) return { status: 'fail', reason: `invalid-evals: ${parsed.error}`.slice(0, 500), evidence: [{ kind: 'check', label: 'evals declaration refused', detail: parsed.error.slice(0, 500) }] };

      const evidence: Evidence[] = [], failed: string[] = [], skippedWhy: string[] = [], passedIds = new Set<string>();
      const prior = previousPassed(ctx.previous);
      for (const d of parsed.tasks) {
        if (ctx.signal.aborted) { failed.push(`${d.id}: stage deadline`); break; }
        const task = materialise(d);
        if ('error' in task) { failed.push(`${d.id}: ${task.error}`); evidence.push({ kind: 'check', label: taskLabel(d.id, 'fail'), detail: task.error }); continue; }
        let run: TaskRun;
        try { run = await runner.runTask(ctx.pkg, task, ctx.signal) as TaskRun; }
        catch (e) {
          if (e instanceof RunnerUnavailable) { skippedWhy.push(e.reason); evidence.push({ kind: 'text', label: taskLabel(d.id, 'skipped'), detail: e.reason }); continue; }
          failed.push(`${d.id}: runner-error`); evidence.push({ kind: 'check', label: taskLabel(d.id, 'fail'), detail: `runner error: ${clip(String((e as Error)?.message ?? e), 300)}` }); continue;
        }
        const r = await judge(task, run, ctx);
        evidence.push({ kind: 'check', label: taskLabel(task.id, r.status), ...(r.reason ? { detail: clip(r.reason, 600) } : {}) });
        evidence.push(...r.evidence);
        if (r.status === 'fail') {
          failed.push(`${task.id}: ${clip(r.reason ?? 'failed', 80)}`);
          try {   // bounded transcript of a failing run, as untrusted text
            const t = clip(String(run.transcript ?? ''), TRANSCRIPT_BLOB_BYTES);
            if (t) { const blob = await ctx.evidence.addBlob('text/plain', new TextEncoder().encode(t)); evidence.push({ kind: 'log', label: `task ${task.id} transcript (untrusted, truncated)`, blob }); }
          } catch { /* evidence limit: the reason above already says why */ }
        } else if (r.status === 'skipped') skippedWhy.push(r.reason ?? 'skipped');
        else passedIds.add(task.id);
      }
      // regression: every task the previous version passed must still pass (no previous stage => nothing to compare).
      const wantsRegression = parsed.tasks.some((t) => t.checks.some((c) => c.kind === 'regression'));
      if (wantsRegression) {
        if (!prior) evidence.push({ kind: 'check', label: 'regression: no previous task-evals result to compare', detail: 'treated as pass' });
        else for (const id of prior) if (!passedIds.has(id)) { failed.push(`${id}: regression`); evidence.push({ kind: 'check', label: `regression:${id}`, detail: `task ${id} passed in the previous version and does not pass now` }); }
      }
      if (failed.length) return { status: 'fail', reason: `task-failed: ${failed.join('; ')}`.slice(0, 500), evidence };
      if (skippedWhy.length) return { status: 'skipped', reason: `check-skipped: ${[...new Set(skippedWhy)].join('; ')}`.slice(0, 500), evidence };
      evidence.unshift({ kind: 'check', label: `${parsed.tasks.length} task(s) passed all deterministic checks` });
      return { status: 'pass', evidence };
    },
  };
}

async function judge(task: SkillTask, run: TaskRun, ctx: Parameters<StageDef['run']>[0]): Promise<{ status: 'pass' | 'fail' | 'skipped'; reason?: string; evidence: Evidence[] }> {
  const ev: Evidence[] = [];
  if (run?.timedOut) return { status: 'fail', reason: 'timeout', evidence: ev };
  if (typeof run?.incomplete === 'string' && run.incomplete) return { status: 'fail', reason: `incomplete: ${clip(run.incomplete, 200)}`, evidence: ev };
  if (!run || run.exitCode !== 0) return { status: 'fail', reason: `run-exit-${Number.isFinite(run?.exitCode) ? run.exitCode : 'unknown'}`, evidence: ev };
  const out = sanitizeOutputs(run);
  for (const p of out.problems) ev.push({ kind: 'check', label: 'output refused', detail: p });
  const verdicts: CheckVerdict[] = [];
  for (const c of task.checks) {
    if (c.kind === 'regression') continue;
    const bytes = out.files.get(c.file);
    if (!bytes) { verdicts.push({ status: 'fail', label: `${c.kind}:${c.file}`, detail: 'output file is missing' }); continue; }
    let v: CheckVerdict;
    if (c.kind === 'functional') v = functional(c, bytes);
    else if (c.kind === 'integrity') v = await integrity(c, bytes, ctx.tools);
    else if (c.kind === 'render') v = await render(c, bytes, ctx.tools, ctx.signal);
    else if (c.kind === 'diff') { const x = task.expected.find((f) => f.path === c.expected)?.bytes; v = x ? diff(c, bytes, x) : { status: 'fail', label: `diff:${c.file}`, detail: 'expected file missing' }; }
    else { const x = task.expected.find((f) => f.path === c.reference)?.bytes; v = x ? await fidelity(c, bytes, x, ctx.tools, ctx.signal) : { status: 'fail', label: `fidelity:${c.file}`, detail: 'reference missing' }; }
    verdicts.push(v);
  }
  for (const v of verdicts) {
    ev.push({ kind: 'check', label: `${task.id} ${v.label}: ${v.status}`, ...(v.detail ? { detail: clip(v.detail, 600) } : {}) });
    ev.push(...(v.evidence ?? []));
  }
  const bad = verdicts.filter((v) => v.status === 'fail');
  if (bad.length) return { status: 'fail', reason: bad.map((v) => `${v.label}: ${v.detail ?? 'failed'}`).join('; '), evidence: ev };
  const sk = verdicts.filter((v) => v.status === 'skipped');
  if (sk.length) return { status: 'skipped', reason: sk.map((v) => `${v.label}: ${v.detail}`).join('; '), evidence: ev };
  return { status: 'pass', evidence: ev };
}
