# Marketplace Plan 2 acceptance (agents and bundles), 2026-10-21

Branch `feat/mp-followup-plan2`, base master 0db86d092. Every line says what ran and what it showed. Nothing is claimed that was not run.

## Server flows A1 to A8 (real evidence)

`cd services/accounts-sync && node --test test/marketplace-acceptance-plan2.test.ts`: 9 tests, 9 pass. It runs on a real embedded Postgres (real `ao_app` / `ao_admin`
roles, RLS on), the REAL Python compiler bridge and the REAL persona scanner (Hermes Skills Guard from the vendored venv). It is skipped, with a reason, when
that venv is absent; it never falls back to a fake. While writing it the first run failed 6 of 9 for real reasons (a missing `tool.invoke` declaration, a wildcard
scope in a bundle, a hook event name, a revocation that is terminal), which is the evidence that the checks bite.

| Flow | Server half (this file) | Desktop half (where it is proven) | Result |
|---|---|---|---|
| A1 publish and use | creator publishes an agent: `compiles`, `dry-run`, `persona-scan`, `refs-resolve` pass, `permissions-subset` reports `derived: ...; declared: ...`, `unsupported-reported` names `schedulingPolicy`; private to its owner | install and profile: `bundleInstaller.test.ts`, `agentAdapter.test.ts`, `agentHermes.integration.test.ts` (see below) | server pass |
| A2 escalation refused | `terminal` toolset with nothing declared: version `rejected`, `permissions-subset` failed, artifact download 409 | n/a | pass |
| A3 revocation | skill dependency revoked: next sync reports `dependency_revoked` for the installed agent; a revoked version can never be published again (DB trigger) | tombstone and memory untouched: `bundleInstaller.test.ts` (agent test), `agentAdapter.test.ts` | server pass |
| A4 bundle atomicity | a bundle with a rejected member is never published; a bundle of verified members is | all-or-nothing install, lockfile byte-identical on failure at member 1, 2, last: `bundleInstaller.test.ts`, real `hermes`: `bundleHermes.integration.test.ts` | server pass |
| A5 team toolkit | pin v1, publish v2: the member still sees v1 and gets no update; re-pin moves it; a member is 403, an outsider 404, RLS shows an outsider zero rows | n/a | pass |
| A6 org policy | allowlist: only `marketplace.policy` may write (engineer 403); the shared evaluator denies an unlisted publisher with a reason | lockfile edits do not bypass, offline pauses installs: `policyGate.test.ts`, `bundleInstaller.test.ts` | server pass |
| A7 honesty | a blueprint with a hook binding publishes and `unsupported-reported` lists `hookBindings`; Legal Research read-only dry run: `marketplace-fixtures.test.ts` | Not available yet sections: Agent Builder (below) | pass |
| A8 fixtures are not listings | a fresh database has 0 agent and 0 bundle listings; no file under `src`, `scripts`, `db` names the fixtures | n/a | pass |

## T12 Agent Builder (publish from the builder)

- Pure models, each test seen failing first: graph with cycle detection (`agentGraphModel.test.ts`, 6), test panel where a skipped step is a failed step and publish outcomes that never claim success for a non-installable version (`agentBuilderPublish.test.ts`, 7), skill choices with real declared permissions (`agentBuilderSkills.test.ts`, 3), nav entry and open-once rule (`marketplaceNavModel.test.ts`).
- Main process, with a fake Hermes and a fake marketplace server: `AgentAdapter.testDraft` (2 tests: throwaway home, nothing installed, hostile id and oversize tree refused before any process) and `MarketplaceInstaller.testAgentDraft` / `uploadPackage` (3 tests: refs resolved by the server for this caller, skill trees downloaded and verified, zip posted as the caller, every server answer returned, public refused).
- UI: `browser/views/agentBuilder/{builderPanel,dependencyGraph,testPanel,publish}.ts`, "Create agent" in My Creations (enabled only when the server says agents are supported) and `workbench.action.marketplace.createAgent`. The builder is loaded on first use, so the lazy-loading audit (`marketplaceLazyLoading.test.ts`) still holds. The existing source-hardening test scans the new files (textContent only, no inline styles).
- Deviation: the plan names error codes `blueprint_invalid`, `permissions_exceed_declared`, `dependency_not_visible`, `visibility_escalation`; the server never sends them as codes, it reports failed validation checks (`blueprint-parse`, `permissions-subset`, `refs-resolve`, `visibility-no-escalation`). The publish model gives text for both.
- NOT done: the builder does not ask live Hermes for its capabilities (there is no such CLI op); it shows the built-in lists with its own banner. A new version of an existing agent is not loaded back into the builder. `scripts/e2e/plan/marketplace-agent-builder.mjs` was not written and no real-window run was made (see Not verified).

## T13 Team Library UI

| Item | Status |
|---|---|
| Team Library assignments, bundle detail, installed agent view, policy messaging | **TO BE FILLED IN BY THE COORDINATOR after merging branch `feat/mp-followup-t13`.** Nothing for T13 is claimed here; this branch contains only the workbench service passthroughs (`planBundle`, `installBundle`, `uninstallBundle`, `policy`, `assignments`, `planAssignment`, `testAgent`, `uninstall` with `deleteAgentData`) that the UI will call. |

## T14 Admin pages (services/control-plane)

- The overlay patch applied with two hand-merged hunks (`nav.ts`, `admin-api.ts`) and was deleted. Added: agent review (component table supported / not available yet / unknown, compiler and dry run, derived vs declared permissions, dependencies), bundle review (members and pins, closure, union), manual-review summary with the server's hash, Install Policy (`marketplace.policy` only; the page does not even fetch without it), Team Assignments (read-only, blocked pins), Agents & Bundles list, publish for agent and bundle.
- Roles and audit follow the console's pattern: the API enforces every permission and writes `admin_audit`; the console shows what `GET /admin/marketplace/me` (new, tested) says the API will accept, and fails closed to no marketplace permission when it does not answer.
- Server addition with a test: `permissions-subset` now carries `derived: ...; declared: ...`.
- Evidence: `npx tsc --noEmit` clean; `npm run build` ok; `npm test` 71 tests, 71 pass with `AUTH_TEST_PG` set (includes `marketplace.test.ts` 8, `marketplace-plan2.test.ts` 11, `marketplace-pages.test.ts` 7: a real `next start` against a stub admin API that records requests, asserting the analyst never triggers a policy request).

## Gates run

| Check | Result |
|---|---|
| accounts-sync `npm test` (fresh pgvector pg17 container, all role passwords set) | 1863 tests, 1855 pass, 3 fail, 3 skipped. The 3: `0016 applies on top of the whole chain` and `marketplace schema (full migration chain)` and `reliability and analytics ...` fail identically on the unchanged baseline run taken before any change here; `eligible promotion` passed on its own (growth-api 7/7) and failed once in the full run (flaky under load, untouched code) |
| accounts-sync `npm run eval` | 4 GATE PASSED |
| `test/migration-numbers.test.ts` | passes in the full run (no migration added; next free is 0031) |
| desktop `npx tsgo --noEmit -p src/tsconfig.json` | 0 errors |
| desktop marketplace unit files (42 files, run one per process) | 514 passing, 2 failing, 6 pending. The 2 failing, both unrelated to files changed here: `agentBuilderModel.test.ts` "capabilities ... bundled copy has not drifted" (Hermes `capabilities.json` was regenerated by the last master commit) and `agentHermes.integration.test.ts` (the real compiler derives `network` for the test agent) |
| control-plane tsc, build, tests | clean, ok, 71/71 |
| layout and okf gates | see the final report of this task |

## Not verified

- No real-window (CDP) run of the Agent Builder or the admin pages, and no screenshots: ports 9351/9361 were off limits and no fork build was launched elsewhere. The UI is proven by the pure models, source-hardening tests and typecheck, and the admin pages by a real `next start` against a stub API.
- The admin pages were not driven against the real accounts-sync handler end to end; the stub returns the shapes the API tests pin.
- `agentHermes.integration.test.ts` and the capabilities drift test fail; they were not re-run on master to prove they fail there too (their inputs are untouched by this branch).
- Plan 3 overlay `marketplace-admin-pages-advanced.patch` does not apply any more and was not re-applied.
- The full migration chain tests (`0016 applies on top ...`) fail on this tree before and after this work.
