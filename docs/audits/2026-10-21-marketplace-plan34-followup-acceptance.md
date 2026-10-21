# Marketplace Plan 3 and 4 follow-up: acceptance record (2026-10-21)

Branch `feat/mp-followup-plan34`, from master `0db86d092`. Machine: one shared macOS laptop with many other agents running (load
average 50 to 105 during the runs), so timings are not comparable and load-sensitive tests may need a solo rerun. Every number below
was printed by the command named next to it; nothing is carried over from an earlier record.

## What was done, and what was not

| Item | State |
|---|---|
| Plan 3 T10 hook scripts | NOT implemented, by the standing security ruling. Confirmed fail-closed, see below |
| Plan 3 T11 UI polish | Done at the model and unit level: a plain-language payload summary (hook rules, bridge tools and host, connector hosts and fields, routine schedule and prompt, workflow outline, memory provider) generated in the main process from the verified payload, shown in the permission dialog and the native confirmation; the hook decision log in the installed item. The live window pass was NOT run (no Electron build here) |
| Plan 3 T13 eval runner | Done and run: `evals/run-advanced-gate.ts` and its meta-tests. The Hermes-side corpora ran as pytest |
| Plan 3 T15 acceptance doc | This file. The per-type flows were NOT re-run (see below) |
| Plan 4 T7 verification eval | Done and run on real tools: 75 cases. Visual-sanity was NOT made required (no calibration beyond four decks) |
| Plan 4 T13 desktop verification display | Done in the detail pane (Security tab). The listing-card badge is NOT built: the list API carries no verification field |
| Plan 4 T14 admin console | Done as a patch rebased on the committed control-plane tree, with its server routes. NOT rendered live |
| Plan 4 T16 live gaps | `lib-ax.mjs` only (Accessibility helper, tested). The flow steps are NOT added and nothing was run in a window |
| Plan 4 T17 screenshot pass | NOT run. The static half (raw color scan) is built and run |
| Plan 4 T18 gates | Scripts written and the gates run; `marketplace-acceptance.sh` written, NOT run end to end (needs the fork build) |
| Plan 4 T19 release readiness | Rollback scripts and their test, the release document, okf updates |

## Hook scripts are still fail-closed

Three independent layers, checked against the tree today:

- `OPERATIONAL.hook.modes.script` is `false`; `typeSupport()` reports `{"declarative":true,"script":false}` with the reason, and
  `isPublishable('hook','script')` is `false` (printed by a node one-liner).
- The server validator rejects `payload.kind: "script"` and any script or executable file in a hook package (corpus cases x18 script
  file, x19 exec.script permission, x25 script kind; all in the advanced gate, 28 of 28 hook cases detected).
- The Hermes side parses only `kind: "declarative"` with exactly `{kind, rules}` (`hook_engine.parse_rules`), and no sandbox or
  hook-runner module exists in `vendor/hermes-agent/hermes_cli/marketplace_ext/` or in accounts-sync.

## Evidence-gated enablement

`test/marketplace-enablement.test.ts` ran in the full accounts-sync suite below (every operational type has a passing evidence record
whose script exists; every unsupported type carries a reason). The truth table is computed from the tree and agrees:

```
type       validator pipeline adapter evidence operational  note
template   yes       yes      yes     yes      yes         
skill      yes       yes      yes     yes      yes         
agent      yes       no       yes     yes      yes         
memory     yes       no       yes     yes      yes         
connector  yes       no       yes     yes      yes         
bridge     yes       no       yes     yes      yes         
surface    no        no       no      no       no          Surfaces are not supported: a surface is arbitrary in-gateway code holding account credentials, with no sandbox.
workflow   yes       no       yes     yes      yes         
hook       yes       no       yes     yes      yes         
routine    yes       no       yes     yes      yes         
bundle     yes       no       yes     yes      yes         

Only template and skill have a registered verification pipeline; every other type ships on its validator, the evidence flow and manual review (Plan 4 Appendix A lists the stages the owning plans add).
```

## Commands and results (this tree)

| # | Check | Command | Result |
|---|---|---|---|
| a | accounts-sync suite (embedded Postgres) | `cd services/accounts-sync && npm test` | tests 1889, pass 1690, fail 0, skipped 197, todo 2. The first run had 2 failures, both caused by this work and fixed: a catalog row-shape test (new `verification` field) and a known-gap rule in the advanced gate |
| a2 | The same suite against a real `pgvector/pgvector:pg17` (`marketplace-gates.sh --only postgres`, throwaway container, removed afterwards) | `AO_TEST_PG=... node db/migrate.ts && npm test` | tests 1890, pass 1855, fail 30, skipped 3. The full chain 0001 to 0030 migrated cleanly. 29 of the 30 failures are payments, growth and run-telemetry tests, not marketplace code; the payments ones fail with `SASL: client password must be a string` (database passwords in this ad hoc container setup), the others were not looked at. One is marketplace: `marketplace-schema.test.ts` "0016 applies on top of the whole chain", where the owner role (a member of `ao_app` in a real chain) trips `marketplace_visibility_guard`. It is in a Postgres-gated file that no earlier record shows as run; migrations were not touched by this branch. NOT fixed, NOT investigated further |
| b | Evals | `npm run eval` | scan gate 12/12 recall, FP 0/12; template validator 60/60, FP 0/6; blueprint 54/54 (nothing skipped, Hermes venv present); bundle 35/35; advanced types: hook 4+28, bridge 1+99, connector 1+75, routine 6+63, memory 6+38, workflow 6+35 (benign+malicious), recall 100%, 0 false positives, all over their size floors. Results files unchanged by the rerun (deterministic) |
| b2 | Verification pipeline eval | `npm run eval:verification` (real officecli 1.0.158 and the Rust kernels built with `cargo build --release`) | 75 cases: benign verdict `fail` 0/9, hostile 60/60, broken 6/6 at the named stage; no case skipped. Benign required stages skipped: 2 docx and 2 xlsx `not-discriminating` (by design), 1 pdf `prerequisite-skipped:render-pages`. Run twice, identical case results. Measured pptx preview fidelity: own thumbnail MAD 0.0017 to 0.0032 against a 0.02 limit and SSIM 0.9961 to 0.9979 against 0.9; the swapped preview MAD 0.4923 and SSIM 0.363 |
| b3 | Template differential vs officecli | `npm run eval:differential` | DIFFERENTIAL PASSED (562 cases, 0 gaps). The committed results file was NOT updated: this run's counts differ slightly (officecli errors 3 vs 9) because it ran under load average above 100 |
| c | Hermes | `pytest tests/hermes_cli/marketplace_ext tests/tools/test_agentic_marketplace_source.py` (venv of the main checkout) | 492 passed, 2 skipped |
| d | Desktop type check | `npm run typecheck-client` (tsgo) | 0 errors |
| e | Desktop marketplace unit files, one run per file | `npm run test-node -- --run <file>` x 41 | 513 passing, 6 pending, 2 failing. The 2 failures (`agentHermes.integration` and `agentBuilderModel` capabilities drift) fail identically on an untouched checkout of `0db86d092`, so they are not caused by this work |
| f | okf and layout | `check-okf.py`, `check-repo-layout.py` | 72 concepts, 25 units, 0 problems; 32967 files, 0 problems |
| g | Gate scripts | `marketplace-gates.sh --only truth_table`, `--only control_plane_patch`, skip handling with and without `--allow-skip` | PASS, PASS; a SKIP not named by `--allow-skip` exits 1, a named one exits 0 |
| h | Admin pages patch | `git apply --check --directory=services/control-plane docs/audits/marketplace-admin-pages-current.patch`; in a scratch copy: `tsc --noEmit`, `next build`, `npm test` | applies; tsc clean; build passes; 20 pass, 3 fail (the same 3 test files fail on the untouched base tree) |
| i | New tests | advanced gate meta-tests 7, verification eval meta-tests 10, admin verification routes 3 (real Postgres), migrations and rollback 5, desktop verification model 10, payload summary 10, hook audit rows 3, plan summary 1, Accessibility helper 4 (`node --test scripts/e2e/plan/lib-ax.test.mjs`), console helpers 4 | all pass. Mutation-checked: the verification eval gate (two checks removed, tests failed), the rollback scripts (a removed DROP failed the test). The advanced gate meta-tests were not mutation-checked |

## Not verified

- Any real-window flow: there is no Electron build on this machine (`apps/desktop/.build/electron` is absent), and the window ports 9351 and 9361 were off limits. So Plan 3 T11's live pass, Plan 4 T16 (revoke through the window, signed-in gate, flows 6 to 8, the native confirmation dialog) and T17 (screenshots, computed-contrast checks) were not run. `axTrusted()` returned true on this machine, so the dialog step is runnable by an operator once a window exists.
- The per-type e2e flows (`marketplace-<type>-flow.mjs`) were not re-run: they write to fixed directories under `/tmp/ao-mkt-*`, which another session may be using. The evidence records are the earlier runs and are checked by `marketplace-enablement.test.ts`.
- `marketplace-acceptance.sh` was not run end to end.
- Skill task evaluations against a real Hermes and model: no provider credentials in this environment (`run-skill-tasks.ts --live` prints `SKIPPED: no-credentials`; the result file now says so). The scripted runner passes.
- The admin pages were not rendered live. The listing-card "Verified" badge is not built.
- Plan 4 T7 calibration of the visual comparator thresholds beyond pptx: there is no visual comparator here; `visual-sanity` stays non-required.
- The Postgres-gated failures listed under a2.
