---
type: Reference
title: "Marketplace catalog service"
description: "Marketplace catalog, search, artifact download, favorites, reviews, install sync and reports: public routes inside accounts-sync."
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test (marketplace-api, -creator, -rls, -artifacts, -manifest, -schema; embedded Postgres, no setup needed)"
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

## Creating, forking and sharing

Signed-in users can make skills and templates of their own (`src/marketplace/creator.ts`, `diff.ts`;
routes in `src/api/marketplace.ts`). The handler takes an optional second pool, `admin` (`ao_admin`),
used only for what `ao_app` cannot do: registering the artifact row, creating a publisher or team,
setting a version's final state, and recording the release. The owner's own rows (listing, draft
version, dependencies) are still inserted as `ao_app` under row-level security.

- `POST listings?visibility=private|team[&team=]` (body: a zip, `application/zip`, 64 MiB at most)
  and `POST listings/:id/versions`: the zip is unpacked with the hardened reader and validated with
  the registry's validator (the injected skill scanner, if configured) before anything is stored.
  A bad archive is a 400 and stores nothing. The manifest id's publisher must be one the caller owns
  or their own `u-<user id>`, which is created on first use (403 `publisher_not_owned`). A new
  version must be strictly greater than every existing one (409 `version_not_greater`).
- The visibility ceiling is `private`/`team`: `public` and `org`, and trust levels, stay with admin
  review (403 `public_requires_review`, also for new versions of a public listing). A verified, ok
  version is auto-published to its private audience by the server; a failed required check stores
  it `rejected` with the report in `marketplace_security_scans`; with no scanner it stays
  `submitted`. Only `published` versions are installable (`installs/sync` and the artifact route
  refuse the rest; the owner can still diff them).
- `PUT listings/:id/visibility`, `POST listings/:id/fork`, `GET listings/:id/compare`,
  `GET me/listings`, `GET me/teams`, `POST teams`, `GET teams/:id`, `POST teams/:id/members`,
  `DELETE teams/:id/members/:userId`, and `GET listings?scope=mine|team&team=`. Team management is
  owner-only; a team the caller is not in is a 404; the last owner cannot leave.
- A fork is a new private listing `<caller publisher>/<slug>` with `forked_from`,
  `forked_from_version` and `forked_base_sha256` (migration 0015). The upstream package is
  re-validated as stored (a tampered or newly failing upstream is a 422 with the report), the copy is
  rebuilt by `rewriteManifest` (new id, version `<base>-fork.1`, file hashes recomputed, deterministic
  stored-only zip, no runtime dependency on fflate) and validated again. Upstream rows are never
  written. `GET listings/:id` of a fork carries `upstream: {listingId, latestVersion,
  newerThanBase}`, computed from upstream versions the caller can see; `compare` defaults a fork to
  base = the recorded upstream version, head = its latest, and returns per-file status, hashes and a
  unified diff for text files up to 256 KB (20 KB cap per file).

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
