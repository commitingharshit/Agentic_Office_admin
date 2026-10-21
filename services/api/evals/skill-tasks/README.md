# Skill task evaluations

Opt-in dynamic stage `task-evals` of the skill verification pipeline (Plan 4 Task 6). It runs the example tasks a skill
declares and checks the files the run produced with deterministic checkers. There is no LLM judge and no score: each check
is pass or fail with evidence.

## Declaring tasks

A skill package may carry `evals/tasks.json` (`schema: "agentic.marketplace.skill-evals/1"`, at most 5 tasks, 1 MiB for the
file; the format is `src/marketplace/verify/stages/skill/taskSchema.ts`, re-exported by `schema.ts`). Skill packages allow
text files only, so input and expected files are carried inline as base64 with a pinned sha256 (a mismatch fails the task).
Checks: `functional` (cell value, text contains/excludes), `integrity` (safe zip, well-formed parts, `officecli validate`
when present), `render` (no blank pages, needs officecli), `fidelity` (pixel and SSIM against a reference render, needs
officecli and the visual comparator), `diff` (line diff against an expected file within `maxDifferingLines`), `regression`
(every task the previous version passed must still pass). A check that needs a missing tool is `skipped`, never `pass`.

## Semantics

- Default: `skipped: not-enabled` (no task runner on the verifier). It does not make the verdict `incomplete` because the stage
  is non-required by default.
- `createSkillPipeline({ taskEvals: { required: true } })` (the type's verification policy) makes a skipped stage
  (`not-enabled`, `no-evals-declared`, `sandbox-unavailable`) an `incomplete` verdict. A failed task is `fail` either way:
  a skill that passes every static stage but fails its task evals is never verified.
- Runners: the scripted runner (tests, CI) runs real commands in the Task 5 sandbox; the Hermes runner
  (`VERIFY_TASK_EVALS=real`) is manual only and has an open network (see `okf/architecture/marketplace-service.md`).

## Fixtures and the runner

`fixtures/<name>/{task.json,<inputs>,<expected>}` describes one task for a seed skill under `scripts/dev-seed/`; `task.json`
names the skill directory, the permissions its manifest declares, the task, and the scripted model's commands.
`node evals/run-skill-tasks.ts [--skill <name>] [--live]` packages the skill plus `evals/tasks.json`, runs the whole skill
pipeline with the stage required, and writes `evals/results/skill-tasks.md`.
