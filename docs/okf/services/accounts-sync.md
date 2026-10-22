---
type: Service
title: "Accounts and sync server"
description: "Users, devices, encrypted device sync, plans, credits, coupons, managed inference and the admin API; verifies Clerk or our own sign-in; the only service with versioned SQL migrations."
resource: services/api/
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/api && npm ci"
test: "cd services/api && npm test (AO_TEST_PG and AO_TEST_MINIO point it at a local stack; otherwise most tests skip). The money rules (coupons, reservations, the ledger) are SQL and are tested by test/billing.test.ts and billing-api.test.ts"
run: "node src/api/main.ts (port 8787), or services/deploy/stack.sh accounts-sync up -d"
owns_data: "Postgres (db/migrations/*.sql, RLS roles), a MinIO bucket for sync blobs, WAL archive and base backups"
depends_on: []
status: "active"
tags: [accounts, sync, postgres]
timestamp: 2026-10-17T00:00:00Z
---

Users, devices, encrypted device sync and the admin API behind Clerk sign-in; the only service with versioned SQL migrations.

Code is `src/api/` (sync, admin, billing, inference, rate limits, S3) and `src/auth/` (the Clerk session verifier and `jwks.ts`, the verifier for our own sign-in's ID tokens). Credits, coupons and reservations move only through SQL functions (migration 0007); the sign-in service's tables and role come from 0006 and 0009. Every user table and token: [identity](/architecture/identity.md).

README: [`services/api/README.md`](/../services/api/README.md)

# Citations

- [`services/api/README.md`](/../services/api/README.md)
- [`deploy/compose/api/README.md`](/../deploy/compose/api/README.md)

Keycloak (identity service): with `KEYCLOAK_ISSUER` set, `POST /v1/auth/exchange` also accepts Keycloak ID tokens (`exchangeKeycloak`: known identity, else one verified email linked once, else a new account; unverified email never links) and `GET /v1/auth/config` sends the app to Keycloak. With `KEYCLOAK_API_SECRET` the admin API reads a person's Keycloak sessions and login events (`GET /admin/users/:id/keycloak`) and mirrors disable/enable/sign-out into Keycloak (`keycloak-admin.ts`, `keycloak-link.ts`). See [Keycloak](/services/keycloak.md).

Plans, limits and payments (migrations 0017/0018): prices live in `plan_prices` (database, not code); a plan carries its limits (`max_concurrent_runs`, `max_job_seconds`, `requests_per_minute`, `allowed_models`, `top_up_eligible`) and managed inference enforces them per request (`sync.ts`): the model list, a per-plan rate, runs in flight counted under the user's lock, and the credit hold lasting `max_job_seconds`. Payments are OFF unless `AO_PAYMENTS=youpi-experimental` plus `YOUPI_*` and `AO_BILLING_PASSWORD` exist. The provider is experimental: a signed webhook is only an observation (`observed`); `ao_activate_order` runs only when an admin settles the order after checking the bank amount, and is idempotent and row-locked. Admin pages: Payments, Notifications (`GET /admin/attention`, role-filtered), Billing & Plans. Desktop: `agenticOffice.account.plans` (`apps/editors/docx/extension/src/account/plans.ts`) opens the server-issued https checkout and follows the order; a plan changes only when the order is `completed`. Plan: `docs/plans/2026-10-21-pricing-payments.md`. Sign-in test matrix: `docs/reference/oauth-test-matrix.md`.

Access requests (migration 0019): a person the console turned away can ask for admin access (`POST /admin/access-requests`, from a short signed cookie set only for them); people with `roles.write` approve with a chosen admin role or decline (`/admin/access`). Approval claims the request first, then uses the same guarded `setRole` as every role change, and is audited with who decided. Pending requests appear in `/admin/attention` and the console bell.

## Growth (promotions, releases, campaign email)

The admin controls what the app shows without a redeploy: campaigns with one creative per placement (`chat_empty` above the assistant's composer, `inbox`, `bottom_strip`), audiences, frequency caps and holdouts, staged releases, and Resend campaign email. The server decides what is eligible (`src/growth/engine.ts`: ad-free plan, the person's own opt-out, kill switch, targeting, holdout, caps, precedence task > release > promo); the desktop only draws it (`apps/desktop/.../agenticOffice/browser/growth/`, rules in `common/promoModel.ts`) after the shared validator (`packages/promo-card`) accepts it. Media goes through the ffmpeg `media-worker`. Local stack and dev seed: `tests/tools/growth-stack.sh up|smoke|reset|down` (`deploy/docker-compose.growth.yml`, `db/seed/growth.sql`, which refuses a database with real people in it). Migrations 0029_growth and 0030_releases_email hold the growth schema (renumbered after the admin-invite and marketplace migrations when the branches met; the migrator applies by filename, once each).
