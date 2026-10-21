---
type: Reference
title: "Marketplace catalog service"
description: "Marketplace catalog, search, artifact download, favorites, reviews, install sync and reports: public routes inside accounts-sync."
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test (marketplace-api, -admin, -rls, -artifacts, -manifest, -schema; embedded Postgres, no setup needed)"
run: "part of accounts-sync (node src/api/main.ts, port 8787); the routes need the sync API and MinIO configured"
owns_data: "marketplace_* tables (listings, versions, artifacts, installs, reviews, reports) from migration 0015; artifact bytes in the MinIO bucket ao-marketplace by sha256"
depends_on: []
status: "active"
tags: [marketplace, accounts, postgres]
timestamp: 2026-10-21T00:00:00Z
---

The catalog read path and the signed-in user actions, inside [accounts-sync](/services/accounts-sync.md).
Code: `src/marketplace/` (`store.ts` SQL, `search.ts` query building, `artifacts.ts`, `manifest.ts`,
`ratelimit.ts`) and the HTTP layer `src/api/marketplace.ts`, registered in `main.ts` ahead of the sync
handler (it reuses sync's `authenticate`: Clerk session or `aod_` device token). Model, states and
reuse: [marketplace architecture](/architecture/marketplace.md).

Routes (`/v1/marketplace`): `GET listings` (full text `q`, `type`, `publisher`, `trust`, `installed`,
`page` cursor, `limit` up to 100), `GET listings/:publisher/:slug`, `.../versions`,
`GET versions/:id/artifact` (the zip bytes, `x-content-sha256`; 410 for a revoked or quarantined
version), `PUT|DELETE .../favorite`, `PUT|DELETE .../review`, `POST installs/sync`, `POST reports`.
Reads need no token; every mutation does and is rate limited per user. Visibility is decided only by
row-level security (the store runs as `ao_app` with `app.user_id` set, empty for anonymous readers),
and an invisible listing is a 404, never a 403. A download is not an install: the device acknowledges
installs, failures and removals through `installs/sync`, which also returns the updates and
revocations the device must act on. Ratings, favorite and install counts are read from
`marketplace_listing_stats`, never stored or invented.

## Admin API

Publishing, review, lifecycle and moderation live under `/admin/marketplace/*`
(`src/api/marketplace-admin.ts`, `marketplaceAdminHandler`, registered in `main.ts` just before the admin
handler; it needs MinIO). Every route authenticates with `admin.ts`'s bearer-token/Clerk path, checks a
permission, does the work as `ao_admin`, and writes `admin_audit` (`marketplace.<verb>`, ids and states only,
never artifact bytes) in the same transaction. A denied request changes nothing and is not audited.

Permissions (`src/marketplace/permissions.ts`, same shape as the control-plane `rbac.ts`, which is not in this
branch): `marketplace.read|write|review|moderate`; superadmin all, engineer read+write+review, analyst read,
support and finance none. `roleOf(adminId)` is the seam: until roles exist every authenticated admin is a
superadmin, as `admin.ts` already treats them. Replace `permissions.ts` with a re-export of `rbac.ts` when it
lands. User emails are never returned; the endpoints expose user ids only.

Routes: `POST submissions` (body the package zip, 64 MiB cap enforced while reading; `visibility`,
`publisher`, `team`) unpacks, validates with the real injected scanner/renderers, stores the artifact, and
inserts the version as `submitted` (or `rejected` at once when a required check failed), with one
`marketplace_security_scans` row per check plus an overall `validation` row (`findings.ok/verified`).
`GET submissions?state` is the review queue; `POST versions/:id/{claim|approve|reject|publish|deprecate|quarantine|revoke}`
body `{reason}`; `GET catalog`, `GET versions/:id`, `GET installations`, `GET users/:id/installs`,
`GET|DELETE reviews`, `GET reports` and `POST reports/:id/resolve`, `GET|POST publishers` (superadmin to
write), `GET analytics`. All state changes go through `transition(from, action)`, the one place the state
machine lives; approve and publish require the latest overall scan to be ok AND verified (409
`scan_failed` / `scan_required`), so an unverified skill (no scanner configured) can never be published.
Each transition also writes a `marketplace_release_events` row naming the actor, which is what
`marketplace_installed_status()` reads to tell installed devices a version was quarantined or revoked.

Analytics are computed from rows only. Metrics this release does not collect (`invocations`,
`workflow_completions`, `first_use_activation`) are listed in `notCollected`, and `telemetryCoverage`
reports devices with install rows against devices known, so partial telemetry is visible as partial.

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
