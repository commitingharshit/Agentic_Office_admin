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
