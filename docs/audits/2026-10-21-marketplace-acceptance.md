# Marketplace acceptance run, 2026-10-21 (ship step A)

Tree: branch `feat/mp-ship-a` at the enablement commit `e48658d9a` plus the follow-up working changes listed in the last section. Machine: one shared
macOS laptop with other agents running; load average is recorded per row because several tests are load-sensitive. Nothing was rerun to get a
better number except where stated.

| # | Check | Command | Result | Counts | Machine load (1 min) |
|---|---|---|---|---|---|
| a | Full accounts-sync suite | `cd services/accounts-sync && npm test` | 1 failure on the first run, caused by the enablement itself (a bundle-validator test used `hook` as its "unsupported member type"; `hook` is now operational). Test changed to use `surface`; that file rerun: 17/17 | tests 1562, pass 1536, fail 1 (then fixed), skipped 23, todo 2 | 22 to 41 |
| a2 | Skipped tests, by reason | | 21 need `AO_TEST_PG` (a real Postgres: none here; the embedded-Postgres suites ran), 1 needs built Rust kernels, 2 need `DAG_RUNTIME_PYTHON`. The two DAG tests were rerun with it set: `marketplace-workflow-validate.test.ts` 85/85, 0 skipped | | |
| a3 | Load-sensitive tests (pptx render, nested-workbook bomb, creator compare budget, verify-worker RSS/timeout) | in the full run | all passed on the first run, nothing needed a solo rerun | | |
| a4 | Enforcement test | `node --test test/marketplace-enablement.test.ts` | pass; mutation-checked (flipping `surface`, or pointing `workflow` at a missing file, fails it) | 7/7 | low |
| b | Eval gates | `npm run eval` | scan gate PASSED: malicious recall 100% (12/12), precision 100%, FP 0/12. Template validator gate PASSED: recall 100% (60/60), precision 100%, FP 0/6 | | low |
| b2 | Template differential vs officecli (`npm run eval:differential`) | NOT RUN separately: skipped (slow, 500 mutations). `marketplace-template-differential.test.ts` ran inside (a) and passed | | | |
| c1 | Zip differential, 3 readers | `HERMES_PYTHON=<hermes venv python> node scripts/dev/marketplace-zip-differential.mjs` | FAILED first with 7 undocumented divergences (server rejects `special-file` modes that desktop and Hermes ignore). Documented as two entries in `known-divergences.json` (server stricter; both accepting readers still produce identical bytes), rerun: OK, 614 zips, no undocumented divergence, no content or safety violation | server 114 accept / 500 reject, desktop 122 / 492; 63 documented divergences | low |
| c2 | Supply-chain attack suite | `node test/marketplace-supplychain.test.ts` (also in (a)) | pass | 107 tests, 105 pass, 0 fail, 2 todo (documented known gaps) | |
| d1 | e2e hook (declarative) | `node scripts/e2e/plan/marketplace-hook-flow.mjs` | PASS, real capabilities endpoint (no override) | 22/22 steps | 15 |
| d2 | e2e memory | `marketplace-memory-flow.mjs` | PASS | 5 passing, 0 pending | 64 |
| d3 | e2e routine | `marketplace-routine-flow.mjs` | PASS | 2 passing | 48 |
| d4 | e2e bridge | `marketplace-bridge-flow.mjs --evidence ...` | PASS (run twice: with and without `--evidence`) | 2 passing, 14 evidence steps | 38 |
| d5 | e2e workflow (real `dag_runtime serve`) | `AO_DAG_RUNTIME_PYTHON=... marketplace-workflow-flow.mjs` | PASS | 2 passing | 24 |
| d6 | e2e connector (api_key) | `marketplace-connector-flow.mjs --evidence ...` | PASS | 2 passing, 19 evidence steps | 19 |
| e | Real-window flow, templates and skills | `node scripts/e2e/plan/marketplace-flow.mjs` | Run 1: 11/12 (5b: the pptx editor extension was not built in this worktree; its `out`, `node_modules` and `webview/dist` were then linked from the `marketplace` worktree). Runs 2 and 3: 11/12 (5c: harness defect, after 5b focus is inside the pptx webview where F1 does not open the palette, the same thing step 6 already works around). Fix in the flow only (leave through the Marketplace tab first; no assertion weakened). Run 4: **12/12** | 12 steps | 17 / 8 / 8 / 7 |
| f1 | Desktop marketplace unit files (one per run) | `npm run test-node -- --run <file>` x 34 | all pass | 439 passing, 0 failing, 3 pending (the three `*Hermes.integration` tests for bridge, connector, workflow skip themselves unless started by their flow script; those flows are d4, d5, d6) | |
| f2 | Type check | `npm run typecheck-client` (tsgo) | clean | 0 errors | |
| f3 | okf | `python3 scripts/dev/check-okf.py --write` | clean after the truth-table link exists | | |
| f4 | Layout | `python3 scripts/dev/check-repo-layout.py` | 0 problems | 32536 files | |
| g | One-command demo (`scripts/dev/marketplace-demo.sh`) | run, 6 screenshots via CDP, `marketplace-demo-stop.sh`, `ps` | up in 21 s; Discover lists 10 items including all six advanced types; category nav derived from capabilities; template installed and listed in Installed; after stop no process and no listening port remained | | |

## What the real-window flow does not cover

It covers templates and skills only. No advanced type has been installed through the window in an automated flow: the six type flows drive the
real desktop install service, adapters and Hermes without a window. Configure/Grant screens for advanced types are the separate ship-b step.

## Not verified

- The 21 Postgres-dependent legacy tests (`AO_TEST_PG` unset), the Rust-kernel template test, Linux behaviour of the verifier sandbox.
- Template differential run on its own (skipped as slow).
- bearer and none connector modes end to end (api_key only; the others have validator and Hermes unit tests).
- Agent-node workflows (need worker profiles), a real model run of a routine, a running gateway picking up a new memory provider.
