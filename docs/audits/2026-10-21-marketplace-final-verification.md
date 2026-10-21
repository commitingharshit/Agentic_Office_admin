# Marketplace final verification, 2026-10-21

Tree: worktree marketplace-integration, branch feat/marketplace-integration, base HEAD 5ec9a9dd6 (ship-a + ship-b merged). Machine load (uptime) during the run: 3.7 to 8.0 (1-minute), typically about 4.

| # | Check | Command | Result |
|---|---|---|---|
| 1a | accounts-sync tests | `npm ci && npm test` | first run 1562 tests, 1536 pass, 1 fail, 23 skipped, 2 todo. The one failure was a merge-interaction break (fixed, see below); after the fix the file reruns 107 pass / 0 fail, so 1537 pass, 0 fail. No load-sensitive flakes seen; nothing needed a rerun. |
| 1b | detection eval | `npm run eval` | recall 100% (12/12) and 100% (60/60), precision 100% both, GATE PASSED twice |
| 2a | desktop transpile | `node build/next/index.ts transpile` | ok |
| 2b | 36 marketplace unit files, one per run | `node test/unit/node/index.js --run <file>` | all pass, 0 failing. 3 files report 1 pending each (bridge, connector, workflow Hermes integration: gated on env, covered by the real flows in 5). |
| 2c | typecheck | `npx tsgo --noEmit -p src/tsconfig.json` | exit 0, 0 errors |
| 2d | layers | `npm run valid-layers-check` (background) | finished, no error output |
| 3 | Python | marketplace_ext, test_skills_hub, test_agentic_marketplace_source, agent/office/blueprint | 897 passed, 2 skipped |
| 4a | okf | `check-okf.py --write` | 65 concepts, 21 units, 0 problems (no file changes) |
| 4b | layout | `check-repo-layout.py` | 1 problem: tracked `.superpowers/sdd/report.md` (see not fixed) |
| 5 | six type flows, sequential | hook, memory, routine, bridge, workflow, connector | all PASS (hook 22/22, memory 5, routine 2, bridge 2, workflow 2, connector 2) |
| 6a | real window: templates and skills | marketplace-flow.mjs | 12/12 steps passed |
| 6b | real window: Configure / Test connection / Grants | marketplace-configure-flow.mjs | all 9 steps PASS |
| 7 | demo smoke | marketplace-demo.sh, CDP screenshot, marketplace-demo-stop.sh | Discover showed 10 items (6 advanced types plus 2 templates, 2 skills); Agents and Surfaces carry "Not available yet"; stop script left no process or listener on 9361, 8793, 9443, 9444 |

## Fixes (merge interaction)

1. `services/accounts-sync/test/marketplace-hook-validate.test.ts`: ship-b moved `HOOK_EVENT_STATUS` from `hookAdapter.ts` into `common/marketplaceHooks.ts` (re-exported), while the ship-a test still read the old file. The test now reads the new file; the assertion is unchanged.

## Not fixed

- `.superpowers/sdd/report.md` was added by ship-b commit 49ba7594b and trips the layout gate (`.superpowers` not allowed at top level). Removing it (`git rm`) was refused by the sandbox, so it is left for the owner to remove.

## Notes

- The flows rewrote the tracked evidence JSON files under docs/audits (timestamps only); they are not committed.
- pptx extension out, node_modules and webview/dist were copied (untracked/ignored) from the marketplace worktree for 6a.
