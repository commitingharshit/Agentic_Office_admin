// Task runners for the `task-evals` stage (Plan 4 Task 6), plus the VERIFY_TOOLS_MODULE plug-in (default export).
//   scripted runner  deterministic: a function stands in for the model and returns the commands to run; the commands (skill
//                    scripts included) run for real inside the Task 5 sandbox. This is what the tests and CI use.
//   hermes runner    OPTIONAL and never a CI gate: one non-interactive `hermes -z` run in a throwaway HERMES_HOME with the skill
//                    installed. Enabled only by VERIFY_TASK_EVALS=real (cost, non-determinism). It needs the network to reach the
//                    model endpoint, and sandbox.ts can only allow or deny the network wholesale, so in this mode the NETWORK IS OPEN
//                    (documented, not contained); writes stay jailed, env is scrubbed to an explicit allowlist, credential dirs unreadable.
// Containment: standalone, each task runs under runSandboxed (requireSandbox: no jail => RunnerUnavailable => stage `skipped:
// sandbox-unavailable`, and no skill code is executed). Inside the verifier worker's child (already sandboxed, and macOS cannot
// nest sandbox-exec) the same executor runs directly and inherits that child's profile.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnpackedPackage } from '../../types.ts';
import { RunnerUnavailable } from '../stages/skill/taskEvals.ts';
import type { SkillTask, TaskRun } from '../stages/skill/taskSchema.ts';
import type { PipelineTools } from '../types.ts';
import { runSandboxed, type SandboxOptions } from './sandbox.ts';

export interface Step { argv: string[]; stdoutTo?: string; timeoutMs?: number; env?: Record<string, string>; continueOnError?: boolean }
export type Script = (skill: UnpackedPackage, task: SkillTask) => Step[] | Promise<Step[]>;
export interface RunnerOptions {
  script: Script;
  sandbox?: Partial<Pick<SandboxOptions, 'denyReadPaths' | 'workRoot' | 'maxRssBytes' | 'maxFileBytes' | 'pollMs' | 'denyNetwork' | 'denyFork'>>;
  /** Skill files laid out under ws/skill. Default: every file of the package. */
  skillDir?: string;
  maxStepOutputBytes?: number;
  forceMode?: 'sandbox' | 'inherit';
}
const EXECUTOR = new URL('./taskeval.mjs', import.meta.url).pathname;
const MAX_JOB_BYTES = 48 * 1024 * 1024;

const b64Map = (files: Iterable<[string, Uint8Array]>) => Object.fromEntries([...files].map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
function parseOutput(stdout: string): TaskRun | undefined {
  try {
    const j = JSON.parse(stdout);
    if (!j || typeof j.transcript !== 'string' || !Array.isArray(j.outputs) || typeof j.exitCode !== 'number') return undefined;
    return { transcript: j.transcript.slice(0, 64 * 1024), exitCode: j.exitCode, timedOut: j.timedOut === true, ...(typeof j.incomplete === 'string' ? { incomplete: j.incomplete.slice(0, 100) } : {}),
      outputs: j.outputs.filter((o: any) => o && typeof o.path === 'string' && typeof o.b64 === 'string').map((o: any) => ({ path: o.path, bytes: new Uint8Array(Buffer.from(o.b64, 'base64')) })) };
  } catch { return undefined; }
}

/** Inside the worker child: run the executor directly (process group, wall clock, stdout cap); the child's own sandbox is the jail. */
function runInherited(jobJson: string, timeoutMs: number, maxStdout: number): Promise<{ stdout: string; reason?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'taskeval-'));
  writeFileSync(join(dir, 'job.json'), jobJson, { mode: 0o600 });
  return new Promise((res) => {
    const child = spawn(process.execPath, [EXECUTOR], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: dir, TMPDIR: dir, LANG: 'C' } });
    const chunks: Buffer[] = []; let size = 0, reason: string | undefined, done = false;
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { reason = 'timeout'; kill(); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > maxStdout) { reason ??= 'output-cap'; kill(); } else chunks.push(b); });
    child.stderr.resume();
    const fin = () => { if (done) return; done = true; clearTimeout(timer); kill(); rmSync(dir, { recursive: true, force: true }); res({ stdout: Buffer.concat(chunks).toString('utf8'), reason }); };
    child.once('close', fin); child.once('error', () => { reason ??= 'spawn-error'; fin(); });
  });
}

export function createTaskRunner(o: RunnerOptions): NonNullable<PipelineTools['hermes']> {
  return {
    async runTask(skill: UnpackedPackage, task: SkillTask): Promise<TaskRun> {
      const steps = await o.script(skill, task);
      const prefix = o.skillDir ? o.skillDir.replace(/\/?$/, '/') : '';
      const skillFiles = [...skill.files].filter(([k]) => k.startsWith(prefix) && !k.startsWith('evals/')).map(([k, v]) => [k.slice(prefix.length), v] as [string, Uint8Array]);
      const timeoutMs = task.timeoutSec * 1000;
      const job = JSON.stringify({ steps, skill: b64Map(skillFiles), inputs: b64Map(task.inputs.map((i) => [i.path.replace(/^in\//, ''), i.bytes])), timeoutMs, maxStepOutputBytes: o.maxStepOutputBytes });
      if (job.length > MAX_JOB_BYTES) return { transcript: '', outputs: [], exitCode: -1, timedOut: false, incomplete: 'job-too-large' };
      const inherited = o.forceMode ? o.forceMode === 'inherit' : !!process.env.VERIFY_JOB_SHA;
      let stdout: string, reason: string | undefined;
      if (inherited) ({ stdout, reason } = await runInherited(job, timeoutMs + 5000, 40 * 1024 * 1024));
      else {
        const r = await runSandboxed({
          command: process.execPath, args: [EXECUTOR], files: { 'job.json': new TextEncoder().encode(job) },
          timeoutMs: timeoutMs + 5000, maxStdoutBytes: 40 * 1024 * 1024, maxRssBytes: 1024 ** 3, maxFileBytes: 16 * 1024 * 1024,
          requireSandbox: true, denyNetwork: true, jailWrites: true, ...(o.sandbox ?? {}),
        });
        if (r.reason === 'sandbox-unavailable') throw new RunnerUnavailable('sandbox-unavailable', r.stderrTail);
        stdout = r.stdout.toString('utf8');
        reason = r.ok ? undefined : r.reason === 'exit' || r.reason === 'signal' ? `sandbox-${r.reason}` : r.reason;
      }
      const run = reason ? undefined : parseOutput(stdout);
      if (run) return run;
      if (reason === 'timeout') return { transcript: '', outputs: [], exitCode: 124, timedOut: true };
      return { transcript: '', outputs: [], exitCode: -1, timedOut: false, incomplete: `executor:${reason ?? 'invalid-output'}` };
    },
  };
}

/** The optional real runner: Hermes with a scripted-model-free, single non-interactive invocation. NOT exercised by any CI gate. */
export function createHermesRunner(env: Record<string, string | undefined>): NonNullable<PipelineTools['hermes']> {
  const passNames = (env.VERIFY_TASK_EVALS_PASS_ENV ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Z][A-Z0-9_]{1,63}$/.test(s));
  const pass = Object.fromEntries(passNames.filter((n) => env[n]).map((n) => [n, env[n]!]));
  const bin = env.VERIFY_TASK_EVALS_HERMES_BIN || 'hermes';
  return createTaskRunner({
    skillDir: undefined,
    sandbox: { denyNetwork: false },
    script: (skill, task) => {
      const name = String((skill.manifest.payload as { name?: string } | undefined)?.name ?? 'skill');
      return [
        // lay the skill into the throwaway HERMES_HOME the run uses (home = the sandbox workdir)
        { argv: ['/bin/sh', '-c', `mkdir -p "$HOME/hermes-home/skills" && cp -R skill "$HOME/hermes-home/skills/${name.replace(/[^a-z0-9-]/g, '')}"`] },
        { argv: [bin, '-z', task.prompt, '--skills', name, '--yolo'], timeoutMs: task.timeoutSec * 1000, env: { HERMES_HOME: '${HOME}/hermes-home', ...pass } },
      ];
    },
  });
}

/** VERIFY_TOOLS_MODULE entry: task evals are off unless VERIFY_TASK_EVALS=real. */
export default function tools(env: Record<string, string | undefined> = process.env): PipelineTools {
  return env.VERIFY_TASK_EVALS === 'real' ? { hermes: createHermesRunner(env) } : {};
}
