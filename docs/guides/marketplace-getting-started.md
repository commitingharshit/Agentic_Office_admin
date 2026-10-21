# Marketplace: getting started (local, today)

What was verified on 2026-10-21 is marked as such; the rest says what it is. Details per type: [truth table](../audits/marketplace-truth-table.md). Run record: [acceptance](../audits/2026-10-21-marketplace-acceptance.md).

## Run it locally in one command (macOS)

    scripts/dev/marketplace-demo.sh          # server + fake bridge/API + a SEPARATE app window (CDP 9361)
    scripts/dev/marketplace-demo.sh --no-window   # server and fakes only
    scripts/dev/marketplace-demo-stop.sh     # stops only what the demo started (pids in /tmp/ao-mkt-demo/pids)

It uses `/tmp/ao-mkt-demo` for everything (own user-data-dir, throwaway Hermes home, marketplace home), never your real profile and never your running
window (it refuses port 9351 and any busy port). It prints the server URL, the dev bearer token (`dev-token`, honoured only with `AGENTICOFFICE_DEV_MODE=1`
on loopback) and next steps. Seeded: 2 templates, 2 skills (one with a script, one without) and one example each of routine, memory, declarative hook,
bridge (pointing at a local fake HTTPS MCP server), connector (local fake API, key `demo-key`) and workflow (only if the DAG runtime python works; the
script reports a skipped seed). Every seed goes through the real validator of its type and the real admin review flow (submitted by one admin,
approved with the permission-summary hash by another, published). Dev-seed titles say "(dev seed)"; the code lives in `services/accounts-sync/scripts/dev-seed/`, never in `src/`.

Needs: Node 24 (`apps/desktop/.nvmrc`), `npm ci` in `services/accounts-sync`, openssl, the Hermes venv python (`AO_E2E_PYTHON`, or `vendor/hermes-agent/venv`),
`officecli` on PATH for template previews (a shipped thumbnail is used otherwise), and for the window: the fork build (`apps/desktop/.build/electron`) and
`npm run transpile-client` in `apps/desktop`. Verified: server up in about 20 s, window attached, items listed.

## What a user can do in the app today

- **Browse** Discover (search, trust and installed filters), open a detail page (overview, permissions, versions, reviews), favorite, review, report.
- **Templates and skills: install, use, uninstall.** Verified through the real window (12/12 flow): a template installs, appears under "From the Marketplace" in the Templates gallery and "Use" creates an editable file identical to the package; a skill installs into Hermes and uninstalls cleanly.
- **Advanced types** (routine, memory, hook, bridge, connector, workflow) are listed, their categories are available, and the installer can install them (an elevated or executable one asks for a native confirmation). Verified end to end through the installer, adapters and a real Hermes by the six flows, **not** by clicking through the window. What needs configuration or a grant (a routine's schedule, a memory provider's key, a connector's credentials, granting a bridge/connector to an agent) has no screen yet; that Configure/Grant UI is a separate step in progress. Until then an installed bridge or connector is installed but not exposed to any agent, by design.
- **Not available** (shown as "Not available yet"): Agents, Bundles, Surfaces; hook scripts; OAuth connectors.
- **Create your own**: My Creations and Team Library work for skills over the creator and team APIs.

## How admin publishing works

Public items are published by an admin through the API `/admin/marketplace/*` (token-driven): submit the zip, a different admin approves (with the
permission summary hash for manual-review types: routine, memory, hook, bridge, connector, workflow, surface), then publish. The demo server's seeding
code (`scripts/marketplace-dev-server.ts`, `--advanced`) is a working example of the whole sequence. The admin web pages are in `services/control-plane` (see `docs/audits/marketplace-admin-pages.md`).
Pass `--admin` to the demo script to also serve the admin API for that console, as one dev admin.

## Evals and acceptance

    cd services/accounts-sync
    npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped|todo)"     # full server suite (about 6 minutes; some tests are load sensitive: rerun a failing one alone)
    npm run eval                                                    # scan gate + template validator gates
    node --test test/marketplace-enablement.test.ts                 # a type is operational only with passing evidence
    HERMES_PYTHON=<venv python> node ../../scripts/dev/marketplace-zip-differential.mjs
    # the six type flows, one at a time (AO_E2E_PYTHON = Hermes venv python; workflow also AO_DAG_RUNTIME_PYTHON):
    node scripts/e2e/plan/marketplace-{hook,memory,routine,bridge,workflow,connector}-flow.mjs   # bridge/connector take --evidence <file> to rewrite their record
    node scripts/e2e/plan/marketplace-flow.mjs                      # real window, templates and skills (port 9361; needs the pptx extension built)
    cd apps/desktop && npm run transpile-client && npm run test-node -- --run <one test file>; npm run typecheck-client

## Troubleshooting

- **Port in use**: the demo needs 8793, 9443, 9444 and 9361 free (`--server-port`, `--cdp-port` change two). `lsof -nP -iTCP:8793 -sTCP:LISTEN`. A leftover demo: run the stop script.
- **"Could not install ...: fetch failed" in the window**: the dev server's certificate is self-signed; the demo window gets `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only). A window started some other way will fail like this.
- **No Hermes python**: set `AO_E2E_PYTHON`. Bridge/connector fakes and every Hermes-backed flow need it.
- **Workflow seed skipped / workflow tests skipped**: set `DAG_RUNTIME_PYTHON` (the demo script sets it to the Hermes venv python, which worked here).
- **Template seeds slow or timing out**: `OFFICECLI_TIMEOUT_MS=150000` is set by the demo; `officecli` must be on PATH.
- **Node**: Node 24 for the server and fork build; never `npm install` in Bun or pnpm trees (see CLAUDE.md).
- **Window will not start**: it needs `apps/desktop/out` and `.build/electron`; use `--no-window` to run only the server.

## Known limitations

- No Linux sandbox for the verifier worker (macOS `sandbox-exec` only; Linux documented, untested); hook scripts and surfaces stay off until an OS sandbox exists.
- OAuth connectors need a token broker that does not exist. Connector modes `none` and `bearer` have unit coverage only; end to end was run with `api_key`.
- Agents and bundles: server side exists; desktop install is not wired (adapter not registered, bundle transaction not built), so capabilities report them unsupported.
- No Configure/Grant UI for advanced types yet; the Discover chips and search placeholder still mention only templates and skills.
- Legacy Postgres-only tests need `AO_TEST_PG`; the Rust-kernel template test needs `cargo build --release` in `kernels/`.
- Revocation of an item inside an already running process is evidenced for bridge, connector, hook and workflow; memory and routine are revoked through reconcile without a running-process check.
- Admin web pages are a patch, not applied to a committed control-plane tree.
