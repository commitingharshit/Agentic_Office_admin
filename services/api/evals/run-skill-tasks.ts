// Runs the skill task-evaluation fixtures (evals/skill-tasks/fixtures/<name>/) through the REAL `task-evals` stage.
//   node evals/run-skill-tasks.ts                 every fixture with the deterministic scripted runner (a function stands in for the
//                                                 model; the skill's own script runs for real inside the Task 5 sandbox). Writes
//                                                 evals/results/skill-tasks.md (no timestamps).
//   node evals/run-skill-tasks.ts --skill <name>  one fixture
//   node evals/run-skill-tasks.ts --live ...      ALSO try real Hermes + a model in a throwaway HERMES_HOME. Needs VERIFY_TASK_EVALS=real
//                                                 and credentials named in VERIFY_TASK_EVALS_PASS_ENV; otherwise reported
//                                                 `SKIPPED: no-credentials`. Cost and non-determinism: never a gate.
// Exit 1 on zero fixtures or any scripted-run failure (a gate that can pass on an empty corpus is a defect).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { MANIFEST_NAME, sha256Hex, unpack } from '../src/marketplace/artifacts.ts';
import type { PermissionRequest, UnpackedPackage } from '../src/marketplace/types.ts';
import { memoryEvidenceSink } from '../src/marketplace/verify/evidence.ts';
import { runPipeline } from '../src/marketplace/verify/runner.ts';
import { createSkillPipeline } from '../src/marketplace/verify/stages/skill/index.ts';
import { createTaskEvalsStage } from '../src/marketplace/verify/stages/skill/taskEvals.ts';
import { TASKS_FILE, buildTasksFile, type TaskCheck } from '../src/marketplace/verify/stages/skill/taskSchema.ts';
import { createHermesRunner, createTaskRunner, type Step } from '../src/marketplace/verify/worker/taskevalTools.ts';
import { registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'skill-tasks', 'fixtures');
const repoRoot = join(here, '..', '..', '..');

interface Fixture {
  name: string; skillDir: string; permissions: PermissionRequest[];
  task: { id: string; prompt: string; timeoutSec: number; inputs: string[]; expected: string[]; checks: TaskCheck[] }; script: Step[];
}
export function loadFixtures(only?: string): Fixture[] {
  return readdirSync(fixturesDir).filter((n) => !only || n === only).sort().map((name) => ({ name, ...JSON.parse(readFileSync(join(fixturesDir, name, 'task.json'), 'utf8')) }));
}

/** The seed skill's files plus `evals/tasks.json` built from the fixture (inputs and expected outputs are real files in the fixture dir). */
export function packageFor(f: Fixture): UnpackedPackage {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string, rel: string) => { for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(dir, r); else files[r] = new Uint8Array(readFileSync(join(dir, r))); } };
  const skillRoot = join(repoRoot, 'services', 'api', f.skillDir);
  walk(skillRoot, '');
  const read = (n: string) => ({ path: n, bytes: new Uint8Array(readFileSync(join(fixturesDir, f.name, n))) });
  files[TASKS_FILE] = buildTasksFile([{ ...f.task, inputs: f.task.inputs.map(read), expected: f.task.expected.map(read) }]);
  const name = f.skillDir.split('/').pop()!;
  const manifest = { schema: 'agentic.marketplace/1', id: `u-eval/${name}`, type: 'skill', version: '1.0.0', title: name, summary: `The ${name} skill.`, license: 'MIT', compat: { app: '*' }, dependencies: [], permissions: f.permissions,
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { name, entry: 'SKILL.md' } };
  return unpack(zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files }));
}

async function runFixture(f: Fixture, live: boolean) {
  const pkg = packageFor(f);
  const tools = { scanner: async () => ({ verdict: 'safe' as const, findings: [] }), hermes: live ? createHermesRunner(process.env) : createTaskRunner({ script: () => f.script }) };
  unregisterPipelineForTest('skill');
  registerPipeline(createSkillPipeline({ taskEvals: { required: true } }));
  const r = await runPipeline('skill', pkg, tools, { evidence: memoryEvidenceSink() });
  unregisterPipelineForTest('skill');
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), only = args.includes('--skill') ? args[args.indexOf('--skill') + 1] : undefined, live = args.includes('--live');
  const fixtures = loadFixtures(only);
  if (!fixtures.length) { console.error('no fixtures found: refusing to pass on an empty corpus'); process.exit(1); }
  const lines = ['# Skill task evaluation results', '', 'Deterministic scripted runner (a function stands in for the model; the skill script runs for real in the sandbox). Checks: functional, diff. No scores.', '', '| Fixture | task-evals | static stages | verdict | evidence |', '|---|---|---|---|---|'];
  let bad = 0;
  for (const f of fixtures) {
    const r = await runFixture(f, false);
    const t = r.stages.find((s) => s.id === 'task-evals')!, others = r.stages.filter((s) => s.id !== 'task-evals');
    if (t.status !== 'pass') bad++;
    lines.push(`| ${f.name} | ${t.status}${t.reason ? ` (${t.reason})` : ''} | ${others.map((s) => `${s.id}:${s.status}`).join(' ')} | ${r.verdict} | ${t.evidence.filter((e) => e.kind === 'check').map((e) => e.label).join('; ')} |`);
  }
  lines.push('', '## Live run (real Hermes + model)', '');
  if (!live) lines.push('Not requested (`--live`).');
  else if (process.env.VERIFY_TASK_EVALS !== 'real' || !process.env.VERIFY_TASK_EVALS_PASS_ENV) lines.push('SKIPPED: no-credentials (set VERIFY_TASK_EVALS=real and VERIFY_TASK_EVALS_PASS_ENV=<names of the provider key variables>).');
  else for (const f of fixtures) { const t0 = Date.now(); const r = await runFixture(f, true); const t = r.stages.find((s) => s.id === 'task-evals')!; console.log(`live ${f.name}: ${t.status} ${t.reason ?? ''} ${Date.now() - t0}ms`); lines.push(`- ${f.name}: ${t.status}${t.reason ? ` (${t.reason})` : ''}; 1 attempt; checks as above. Non-deterministic: this is one run, not a pass rate.`); }
  if (!live || process.env.VERIFY_TASK_EVALS !== 'real') { mkdirSync(join(here, 'results'), { recursive: true }); writeFileSync(join(here, 'results', 'skill-tasks.md'), lines.join('\n') + '\n'); }
  console.log(lines.join('\n'));
  console.log(`fixtures: ${fixtures.length}`);
  process.exit(bad ? 1 : 0);
}
