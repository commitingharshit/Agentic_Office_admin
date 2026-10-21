# Four plans, database-backed entitlements and payments (YouPI-PG as an experimental adapter)

Requested 2026-10-21 by the owner (a long brief, summarised here). Identity stays with Keycloak (the identity authority); billing lives in our PostgreSQL; the payment provider is replaceable behind an adapter.

## What exists already (reused, not rebuilt)
Plans, one subscription per person, an append-only credit ledger with SQL functions that reserve, settle and expire credits, coupons, usage metering for managed inference, an admin console with roles, Keycloak sign-in with sign-in history, and the plan/role mirrored into Keycloak and its tokens.

## Decisions
- **Four plans:** Free, Pro, Max 5x, Max 20x (plus the existing early-access Beta). Pro, Max 5x and Max 20x are DRAFTS: inactive, no price, no included credits until the owner approves them. Nothing here invents a price or a compute budget.
- **Prices** are rows in `plan_prices` (plan, currency, interval, amount in minor units, integers only). INR first; another currency is another row. A plan cannot be switched on without a price. The checkout reads the price from the database; the app can only name a plan.
- **Entitlements** on each plan, enforced by the server: included credits per period, concurrent cloud requests, requests per minute, model access (allow-list), top-up eligibility, maximum job duration. A plan allowance is a promotional-pool grant that expires at the end of the period (ledger `source = 'plan_period'`); purchased credits stay in the paid pool.
- **Payments:** `payment_orders` → `payment_attempts` → `payment_events` (idempotent by delivery id) → settlement. A provider's SUCCESS is only an OBSERVATION. Settlement is a separate, audited step (`ao_activate_order`, a SQL function that locks the order and does everything or nothing: period, subscription, invoice, credit allowance, plan-change event). By default only an administrator with `payments.write` who has checked the bank record can settle. A late or contradictory notification goes to review. A browser success callback never activates anything.
- **YouPI-PG:** contract read from its source (`POST /api/v1/payments`, `GET /api/v1/payments/{id}`, HMAC-SHA256 webhook over the raw body with `X-Gateway-Signature: sha256=…`, `X-Gateway-Delivery-Id`, `X-Gateway-Timestamp`; events SUCCESS, FAILED, EXPIRED, CANCELLED; INR only; one-time UPI payments, no recurring mandates). It runs as an isolated, experimental adapter, OFF unless `AO_PAYMENTS=youpi-experimental`, with its own SQLite untouched. Monthly renewal is a fresh payment each period.
- **Separate database role** `ao_billing` for payment records (no access to people's data beyond what an order needs); settlement is only reachable through the admin role.

## Phases and status
1. Inspect OAuth and billing (done above; see `docs/reference/oauth-test-matrix.md` for what is covered).
2. OAuth regression matrix: map each required case to a test, fill the gaps.
3. Four plans and entitlements in the database (migration 0018).
4. Entitlement enforcement and metering in the gateway.
5. Payment-provider interface, orders, webhook, reconciliation, settlement (migration 0018, `src/api/payments/`).
6. YouPI-PG adapter and a faithful mock of its API for tests.
7. Desktop: profile with plan and balance, pricing view, checkout states.
8. Admin console: plans, payments and reconciliation.
9. End to end checks, security review, visual checks.
