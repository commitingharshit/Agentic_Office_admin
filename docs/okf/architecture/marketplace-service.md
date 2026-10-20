---
type: Reference
title: "Marketplace catalog service"
description: "Marketplace catalog, search, artifact download, favorites, reviews, install sync and reports: public routes inside accounts-sync."
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test (marketplace-api, -rls, -artifacts, -manifest, -schema; embedded Postgres, no setup needed)"
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

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
