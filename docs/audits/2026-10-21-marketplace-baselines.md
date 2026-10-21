# Marketplace baselines (Plan 4, Task 0), 2026-10-21

Machine: macOS Darwin 25.5.0, 10 cores, 24 GB RAM. Other agents were running throughout, so timings are upper bounds.
Machine-readable copy: [2026-10-21-marketplace-baselines.json](2026-10-21-marketplace-baselines.json).

## Desktop unit suite

Command: `cd apps/desktop && node build/next/index.ts transpile && node test/unit/node/index.js` (whole suite, node_modules cloned from the marketplace checkout). Load average at start: 8.6 (master), 5.4 (branch).

| Suite | master f624e036a | branch ea9081e49 | Delta |
|---|---|---|---|
| passing | 11678 | 11882 | +204 |
| failing | 24 | 24 | 0 |
| pending | 191 | 192 | +1 |
| transpile / run time | 9 s / 51 s | 9 s / 34 s | |

**Failures introduced by the marketplace branch: 0.** The failing sets are identical by full title (24 each: ClaudeAgent 16, AgentSideEffects 7, ChatModeService 1). Nothing was fixed either. The +204 passing tests are the marketplace desktop tests.

Pre-existing failing tests (both sides):

- AgentSideEffects > handleAction — session/turnStarted > parses protocol attachment URI strings before passing them to the agent
- AgentSideEffects > handleAction — session/turnStarted > passes protocol selection attachment range straight through to the agent
- AgentSideEffects > pending message sync > syncs queued message to agent on ChatPendingMessageSet
- AgentSideEffects > pending message sync > parses queued protocol attachment URI strings before passing them to the agent
- AgentSideEffects > queued message consumption > auto-starts turn from queued message on idle
- AgentSideEffects > queued message consumption > intercepts queued /rename and drains the message queued behind it
- AgentSideEffects > queued message consumption > drains a peer chat queued message to the owning session with the chat arg
- ClaudeAgent > getProtectedResources returns the GitHub resource
- ClaudeAgent > createSession before authenticate throws ProtocolError(AHP_AUTH_REQUIRED) with protected resources
- ClaudeAgent > authenticate populates models filtered to Claude family
- ClaudeAgent > authenticate populates full pricing metadata from billing tokenPrices
- ClaudeAgent > authenticate surfaces the CAPI chat-default model first; ties preserve insertion order
- ClaudeAgent > authenticate sources configSchema enum from each model's reasoning_effort list (Phase 6.1 / Cycle D3 / I5)
- ClaudeAgent > authenticate rejects non-GitHub resources without disturbing state
- ClaudeAgent > authenticate with the same token does not restart the proxy
- ClaudeAgent > authenticate with a different token restarts the proxy and disposes the old handle
- ClaudeAgent > authenticate retries proxy startup after a transient failure
- ClaudeAgent > model filter excludes non-Claude entries
- ClaudeAgent > dispose disposes the proxy handle and is idempotent
- ClaudeAgent > stale model writes from an old token are dropped
- ClaudeAgent > first sendMessage on a provisional session materializes it (single startup, single materialize event)
- ClaudeAgent > proxy credit reports are summed and attached to the turn ChatUsage as copilotUsage
- ClaudeAgent > dispose releases the proxy handle even with no materialized sessions
- ChatModeService > should return builtin modes

## valid-layers-check (cap 15 min)

| Tree | Finished | Exit | Wall |
|---|---|---|---|
| master | yes | 0 | 193 s |
| branch | yes | 0 | 193 s |

Both ran concurrently with load average about 47, one run each (the plan asked for 3 idle runs and per-step times: not done here). It is green on the integration commit, which closes the earlier "never finished" ledger note.

## Other durations (branch, load average 38 to 47)

| Item | Result | Wall |
|---|---|---|
| accounts-sync `npm ci` | 19 packages | 14 s |
| accounts-sync `npm test` | 354 tests, 39 suites, 333 pass, 0 fail, 21 skipped | 55.6 s |
| accounts-sync `npm run eval` | scan-gate 12/12 recall, 0/12 FP; templates 20/20 recall, 0/5 FP; gates passed | 13.9 s |
| `check-okf.py` | 64 concepts, 21 units, 0 problems | 0.2 s |

Not measured: `verify-repo-invariants.sh`, desktop marketplace-only unit files.

## Live-verification gaps checklist

- [ ] Native confirmation dialog for executable skills: needs macOS Accessibility permission for the terminal/Orca app (Task 16).
- [ ] Revoke through real Hermes: admin dev token, throwaway Hermes home, reconcile command (Task 16).
- [ ] Signed-in gate with `requireSetup: true`: second profile; real OAuth stays manual (Task 16).
- [ ] Acceptance flows 6, 7, 8 in the real window, including the lockfile-tamper restart (Task 16).
- [ ] Task 8 IPC/dialog wiring never run in a window (needs Accessibility).
- [ ] Seed-skill install live (native dialog, needs Accessibility).
- [x] valid-layers-check green on integration: closed above.
