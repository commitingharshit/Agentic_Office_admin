# Marketplace performance (Plan 4, Task 15), 2026-10-21

Machine: darwin 25.5.0, 10 cores, 24 GB, node v24.16.0. **Shared with other agents: timings are upper bounds.**
Load average (1/5/15 min) at start: 51.729 / 42.872 / 33.729; at end: 44.864 / 42.688 / 34.156.
`uptime`: 14:32  up 5 days, 13:30, 12 users, load averages: 51.73 42.87 33.73

Run: 15 measured runs after 3 warm-up runs (medians), 120 list requests, 200-item synthetic installed set, noise multiplier x2. Result: **within budget**.
Machine-readable copy: [2026-10-21-marketplace-perf.json](2026-10-21-marketplace-perf.json). Budgets and their justification: `scripts/dev/marketplace-bench/budgets.json`.

| Metric | Kind | Measured | Budget | Effective limit | Result |
|---|---|---|---|---|---|
| `startup.networkCalls` | structural | 0 count | 0 | 0 | PASS |
| `startup.fsCallsAtConstruction` | structural | 0 count | 0 | 0 | PASS |
| `startup.processesSpawned` | structural | 0 count | 0 | 0 | PASS |
| `startup.storeFilesRead` | structural | 0 count | 0 | 0 | PASS |
| `installed.storeFilesRead` | structural | 0 count | 0 | 0 | PASS |
| `reconcileSchedule.initialDelayMs` | structural | 30000 ms | 30000 | 30000 | PASS |
| `lockfile.readsForInstalled` | structural | 1 count | 1 | 1 | PASS |
| `lockfile.parse200.ms` | timing | 0.65 ms | 1.52 | 20 | PASS |
| `lockfile.parse2000.ms` | timing | 4.935 ms | 5.85 | 20 | PASS |
| `installed200.ms` | timing | 0.779 ms | 4.14 | 20 | PASS |
| `reconcile200.offlineSignedIn.ms` | timing | 3.479 ms | 3.68 | 20 | PASS |
| `reconcile200.offlineAnonymous.ms` | timing | 2.162 ms | 3.48 | 20 | PASS |
| `memory.moduleImport.heapMB` | memory | 1.065 MB | 1.58 | 3.16 | PASS |
| `memory.installed200.heapDeltaMB` | memory | 0.247 MB | 0.42 | 0.84 | PASS |
| `server.list24.p50.ms` | timing | 6.994 ms | 31.16 | 62.32 | PASS |
| `server.list24.p95.ms` | timing | 20.704 ms | 27.28 | 54.56 | PASS |
| `server.search.p50.ms` | timing | 4.903 ms | 19.94 | 39.88 | PASS |
| `server.search.p95.ms` | timing | 11.818 ms | 12.18 | 24.36 | PASS |
| `server.detail.p50.ms` | timing | 2.945 ms | 10.25 | 20.5 | PASS |
| `server.detail.p95.ms` | timing | 4.879 ms | 9.91 | 20 | PASS |
| `server.preview.p50.ms` | timing | 2.377 ms | 9.74 | 20 | PASS |
| `server.preview.p95.ms` | timing | 7.686 ms | 13.02 | 26.04 | PASS |
| `server.compare.p50.ms` | timing | 8.891 ms | 73.75 | 147.5 | PASS |
| `server.compare.p95.ms` | timing | 14.752 ms | 53.01 | 106.02 | PASS |

Informational (not budgeted):

- `memory.installed200.rssDeltaMB`: 0.141 MB (RSS is page-granular and noisy: informational, not budgeted)
- `server.list24.coldFirstRequest.ms`: 108.061 ms (first request after server start, includes connection setup)
- `server.rateLimited429`: 0 count (requests answered 429 and retried after Retry-After (the in-process read limiter allows 300/min per client); retried requests are not in the samples)

## What each number is

- `lockfile.parse*`: read `installed.lock.json` + `parseLockfile` + `normaliseItem` on every entry (the real modules).
- `installed200`: `MarketplaceInstaller.installed()` on a throwaway `AGENTICOFFICE_MARKETPLACE_HOME` with 200 items (150 skills with `store/<sha>/SKILL.md`, 50 templates).
- `reconcile200.offline*`: `reconcile()` planning cost with no network (the fetch refuses): recovery pass (journal, store sweep), lockfile read, device lookup, request construction. Server cost is not included.
- `startup.*` and `installed.storeFilesRead`: structural, measured in a fresh child process with `fs.promises`, `fetch` and `child_process` instrumented. Construction uses exactly the options `NativeMarketplaceInstallService` passes (autoRecover with the 60 s deferral).
- `memory.*`: `process.memoryUsage()` deltas in fresh children (median of 5), 200 items minus 0 items.
- `server.*`: wall time of one HTTP request including body read and JSON parse, against `services/accounts-sync/scripts/marketplace-dev-server.ts --http --bulk 30` (embedded Postgres, 34 listings). `list24` is the first catalog page (24 items) and is the closest thing to first paint that can be measured without a window; the DOM first paint is covered by the real-window flow (Task 16).

## Renderer startup (audited, not timed)

Checked by `apps/desktop/src/vs/workbench/contrib/marketplace/test/node/marketplaceLazyLoading.test.ts`: the background reconcile registers in `WorkbenchPhase.Eventually`, its constructor only arms a 30 s timer and focus/online listeners, `MarketplaceService` is a delayed singleton with an empty constructor, nothing statically reachable imports node or main-process modules, and the Templates gallery merge reads only `installed()`. The lockfile is first read when the 30 s timer fires with a configured marketplace (`session()` then `installed()`), or when the Marketplace tab or gallery asks.
