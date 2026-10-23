# Agentic Office platform

The server side of Agentic Office: sign-in (Keycloak), the accounts and sync API, billing and credits, the admin console, the marketplace,
growth (promotions, releases, campaign email), the package verifier, service status, and the admin help assistant. The desktop app lives in
a separate repository and talks to this one only through the API in `packages/contracts`.

```
apps/
  console/            Next.js admin console and its sign-in pages
  status/             the public status page (static; served by the API gate at /status)
services/
  api/                the API (Node 24, TypeScript run directly): /v1 for the app, /admin for the console, /v1/status
  verifier/           Hermes skill scanner and agent compiler behind HTTP (internal only)
  prober/             probes public addresses and services, records up / degraded / down
  worker-verify/      marketplace verification worker (queue mode)
  keycloak/           realm, login theme
  gateway/            the nginx allow-lists that are the only public doors (API gate, Keycloak gate)
database/             migrations, the migrator, seeds: the only owner of the schema (SCHEMA.md is the generated data dictionary: every table, column, key, index and grant)
packages/
  contracts/          the wire shapes the desktop app depends on, and mirrors of desktop files this repo's tests compare against
  promo-card/         single source of the promotion card renderer
deploy/               compose stacks (api, console, keycloak), stack.sh, deploy and key-setup scripts
docs/admin-guide/     what the admin console does and how to use it (also the help assistant's knowledge)
docs/okf, plans, audits/   engineering notes carried over from the monorepo (design history; may be stale)
tests/                gate checks, browser and end-to-end checks, marketplace gates, fixtures
```

Dependency rule: apps depend on the API and `packages/`; services never import from `apps/`; only `database/` defines the schema.

## Run the tests
```
tests/tools/test-api.sh                 # the API suite against a throwaway pgvector container (needs Docker, Node 24)
cd apps/console && npm ci && npx tsc --noEmit && npm test
tests/tools/api-gate-check.sh <url>     # what the public may and may not reach on the API gate
tests/tools/keycloak-gate-check.sh <url>
```
Tests that need the desktop monorepo's files read mirrors under `packages/contracts/mirrors`; set `AO_MONOREPO_DIR` to check the
paths listed in `monorepo-owned-paths.json` against a real checkout.

## Deploy
`deploy/scripts/deploy.sh` (run by a person): dump the database, ship the committed code, copy env files once, build the verifier image,
migrate, build and start (gate first), console, Keycloak, checks. See the header of that script for the rollback. Nothing in it sets
payment credentials or a help-assistant key.

- Payments: `deploy/scripts/enable-payments-youpi.sh` (experimental provider; sandbox credentials first).
- Help assistant: `deploy/scripts/set-help-keys.sh` on the host (keys are typed hidden, stored mode 600, never printed), then
  `node services/api/evals/run-help-eval.ts` to measure retrieval and pick `AO_HELP_MIN_SCORE`.
- Public doors: `sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8183` (API gate, also serves `/status`), Keycloak gate on 10000,
  console on 443. Details in `docs/plans/2026-10-21-keycloak.md`.

## Rules that hold everywhere
No secret is printed, logged or committed. A webhook is an observation, never proof of payment. Admins never see document content, prompts,
file names, memories or API-key secrets (`session_events.payload` is never selected). Marketplace uploads are never accepted unverified:
while the verifier is unreachable they answer 503.

## License

Apache License 2.0, see [LICENSE](LICENSE).
