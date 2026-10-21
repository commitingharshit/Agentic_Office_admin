---
type: Reference
title: "Marketplace verifier worker"
description: "The out-of-process worker that claims marketplace verification jobs, runs heavy pipeline stages in a contained child and posts the result to the admin API."
toolchain: "Node 24 (TypeScript by type stripping), npm (part of accounts-sync)"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && node --test test/marketplace-verify-worker.test.ts (sandbox attacks run anywhere; the macOS jail, network and fork tests run on macOS only; the queue tests use embedded Postgres)"
run: "scripts/dev/marketplace-verify-worker (AO_VERIFY_API, AO_VERIFY_TOKEN; the API runs with AO_VERIFY_MODE=queue)"
owns_data: "marketplace_verify_jobs (migration 0027_marketplace_verify_jobs.sql); results go to marketplace_verifications through the admin API"
depends_on: []
status: "active"
tags: [marketplace, verification, sandbox, worker]
timestamp: 2026-10-21T00:00:00Z
---

Verification of a package runs hostile input through parsers, OfficeCLI, kernels and (later) models. That never happens in the
API process. With `AO_VERIFY_MODE=queue`, `POST /admin/marketplace/versions/:id/verify` only enqueues a job (one live job per
version and artifact sha; a second request returns the first). Without it (tests, dev) the pipeline still runs in process.

## Protocol (admin API, permission `marketplace.verify_worker`)

The worker is a `verifier` identity (`AO_MARKETPLACE_ROLES=name:verifier`). It can claim jobs and deliver results and nothing
else: no catalog reads, no approve, no publish, no enqueue. Superadmin also holds the permission.

| Call | Meaning |
|---|---|
| `POST verify-jobs/claim {worker, leaseSec}` | Takes the oldest queued job, or a running one whose lease expired (`FOR UPDATE SKIP LOCKED`, so two workers never get one). Returns a per-claim `leaseToken`. Jobs with no attempts left are dead-lettered first. |
| `GET verify-jobs/:id/artifact`, `POST .../blob`, `POST .../heartbeat`, `POST .../result`, `POST .../fail` | Every call presents `x-lease-token`; a worker whose lease was taken over gets 409 `lease_lost` on all of them. |

Audit (`admin_audit`, written in the same transaction as the change): `claim` -> `marketplace.verify_claim`, `blob` ->
`marketplace.verify_blob` (job, version, sha256, size, mime; never the bytes), `result` -> `marketplace.verification_record`,
`fail` -> `marketplace.verify_fail` (attempt, the `queued`/`dead` transition, the clipped error). `heartbeat` is deliberately NOT
audited: it renews a lease every few seconds per running job, changes no outcome, and would bury the log. A call rejected with
`lease_lost` changes nothing and writes no row. Test: `marketplace-verify-worker.test.ts` ("fail and blob are audited").

State machine (`src/marketplace/verify/jobs.ts`): queued -> running (attempt n of 3) -> done. A failed or abandoned attempt goes
back to queued; the third failure or expired lease makes the job `dead` and records an explicit `incomplete` verification
(`dead-letter:attempts-exhausted`), so a version is never left silently pending and the approval gate sees a real record.
A result is accepted only for the job's artifact sha AND the version's current sha (otherwise 409 `sha_mismatch`, job dead), is
idempotent per job (a retried delivery returns the same verification id), and goes through the same strict `normaliseResult`
as any posted result (no score keys, verdict recomputed, evidence caps).

## Containment (`src/marketplace/verify/worker/sandbox.ts`)

| Measure | macOS | Linux | Status |
|---|---|---|---|
| Wall-clock timeout, group SIGKILL, throwaway cwd deleted | yes | yes | tested |
| stdout cap (killed at the cap), stderr tail only | yes | yes | tested |
| RSS cap (polled group + descendants) | yes | yes | tested |
| CPU (`ulimit -t`) and file size (`ulimit -f`) | yes | yes | tested (CPU); file size set, not attacked |
| Scrubbed environment (PATH, HOME, TMPDIR, LANG + explicit allowlist) | yes | yes | tested |
| Descendants that leave the process group are killed (poll + final sweep) | yes | yes | tested; a process that double-forks and detaches inside one 100 ms poll is missed |
| Network denied (including loopback) | `sandbox-exec (deny network*)` | `unshare -rn` if it works | tested on macOS; Linux documented only |
| Writes only inside the workdir | `sandbox-exec` | not available | tested on macOS; Linux documented only |
| Credential directories unreadable (`~/.ssh`, `~/.aws`, ...) | `sandbox-exec` | not available | tested on macOS |
| Fork denied (`denyFork`) | `sandbox-exec (deny process-fork)` | not available | tested on macOS; off by default because stages run OfficeCLI and kernels |
| Refuse to run without network and write containment (`requireSandbox`, `AO_VERIFY_REQUIRE_SANDBOX=1`) | yes | yes | tested |

macOS has no usable RLIMIT_AS or per-job RLIMIT_NPROC, hence the RSS poll. `sandbox-exec` is deprecated but present. A Linux
deployment should add a container or `bwrap` around the worker; the code reports what it could apply in the stored result's
`env.containment`. The worker's own credential (`AO_VERIFY_TOKEN`) is deleted from its environment after start, sent only in the
Authorization header and redacted from every log line. A package that kills the child (hang, memory, output flood, crash, garbage
output) is recorded as a `fail` stage `sandbox` with bounded evidence; infrastructure errors (cannot spawn, sandbox required but
unavailable, shutdown) hand the job back for a retry instead.

## Wiring

`child.ts` is what runs in the sandbox: it unpacks `package.zip`, imports the modules in `VERIFY_MODULES` (they register
pipelines, e.g. the template and skill pipelines of Tasks 3 and 4), builds tools from `defaultTools` plus an optional
`VERIFY_TOOLS_MODULE`, runs `runPipeline` and prints `{result, blobs}`. The worker uploads the blobs, drops evidence references to
blobs it never uploaded, forces `subjectSha256` and `type` to the job's, and posts the result. `GET /healthz` on
`AO_VERIFY_HEALTH_PORT` reports status, the current job and counters. SIGTERM finishes the current job for up to 15 s, then kills
its child and returns the job to the queue.

# Citations

- [`services/accounts-sync/src/marketplace/verify/worker/sandbox.ts`](/../services/accounts-sync/src/marketplace/verify/worker/sandbox.ts)
- [`services/accounts-sync/src/marketplace/verify/jobs.ts`](/../services/accounts-sync/src/marketplace/verify/jobs.ts)
- [`services/accounts-sync/test/marketplace-verify-worker.test.ts`](/../services/accounts-sync/test/marketplace-verify-worker.test.ts)
