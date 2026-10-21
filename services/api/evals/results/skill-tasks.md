# Skill task evaluation results

Deterministic scripted runner (a function stands in for the model; the skill script runs for real in the sandbox). Checks: functional, diff. No scores.

| Fixture | task-evals | static stages | verdict | evidence |
|---|---|---|---|---|
| docx-outline | pass | manifest:pass spec:pass references:pass scan:pass permissions-consistency:pass tool-grounding:skipped trigger-proxy:skipped | pass | 1 task(s) passed all deterministic checks; task:outline-of-sample: pass; outline-of-sample functional:out/outline.txt: pass; outline-of-sample diff:out/outline.txt: pass; differing lines |

## Live run (real Hermes + model)

SKIPPED: no-credentials (set VERIFY_TASK_EVALS=real and VERIFY_TASK_EVALS_PASS_ENV=<names of the provider key variables>).
