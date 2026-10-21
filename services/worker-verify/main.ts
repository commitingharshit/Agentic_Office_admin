// Entry point of the marketplace verifier worker (Plan 4 Task 5). Run: scripts/dev/marketplace-verify-worker
//   AO_VERIFY_API        base URL of accounts-sync (required), e.g. http://127.0.0.1:8787
//   AO_VERIFY_TOKEN      service credential: an admin token whose AO_MARKETPLACE_ROLES entry is `verifier` (required; never logged)
//   AO_VERIFY_WORKER_ID  display name (default host-pid)
//   AO_VERIFY_HEALTH_PORT  serve GET 127.0.0.1:<port>/healthz (optional)
//   AO_VERIFY_TIMEOUT_MS / AO_VERIFY_MAX_RSS_MB / AO_VERIFY_LEASE_SEC / AO_VERIFY_POLL_MS   limits
//   AO_VERIFY_REQUIRE_SANDBOX=1   refuse jobs when network/write containment cannot be applied (macOS with sandbox-exec, Linux with unshare)
//   VERIFY_MODULES / VERIFY_TOOLS_MODULE / SKILLS_GUARD / OFFICECLI_BIN   forwarded to the sandboxed child
import { hostname } from 'node:os';
import { VerifyWorker } from '../src/marketplace/verify/worker/worker.ts';

const env = process.env;
const apiBase = env.AO_VERIFY_API, token = env.AO_VERIFY_TOKEN;
if (!apiBase || !token) { console.error('AO_VERIFY_API and AO_VERIFY_TOKEN are required'); process.exit(2); }
delete env.AO_VERIFY_TOKEN;   // nothing it spawns can inherit it
const num = (v: string | undefined) => (v && Number.isFinite(+v) ? +v : undefined);
const worker = new VerifyWorker({
  apiBase, token, workerId: env.AO_VERIFY_WORKER_ID ?? `${hostname().replace(/[^A-Za-z0-9_.-]/g, '-')}-${process.pid}`,
  pollMs: num(env.AO_VERIFY_POLL_MS), leaseSec: num(env.AO_VERIFY_LEASE_SEC), healthPort: num(env.AO_VERIFY_HEALTH_PORT),
  sandbox: { timeoutMs: num(env.AO_VERIFY_TIMEOUT_MS), maxRssBytes: num(env.AO_VERIFY_MAX_RSS_MB) ? num(env.AO_VERIFY_MAX_RSS_MB)! * 1024 * 1024 : undefined, requireSandbox: env.AO_VERIFY_REQUIRE_SANDBOX === '1' },
  log: (l) => console.log(`${new Date().toISOString()} verify-worker ${l}`),
});
await worker.start();
console.log(`verify-worker ${worker.opts.workerId} started against ${apiBase}`);
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, async () => {
  if (stopping) return; stopping = true;
  console.log(`verify-worker ${sig}: finishing the current job (up to 15 s)`);
  await worker.stop(15_000); process.exit(0);
});
