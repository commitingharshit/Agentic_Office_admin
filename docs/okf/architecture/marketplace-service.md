---
type: Reference
title: "Marketplace catalog service"
description: "Marketplace catalog, search, artifact download, favorites, reviews, install sync and reports: public routes inside accounts-sync."
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test (marketplace-api, -admin, -creator, -rls, -artifacts, -manifest, -schema; embedded Postgres, no setup needed)"
run: "part of accounts-sync (node src/api/main.ts, port 8787); the routes need the sync API and MinIO configured"
owns_data: "marketplace_* tables (listings, versions, artifacts, installs, reviews, reports) from migration 0016; artifact bytes in the MinIO bucket ao-marketplace by sha256"
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

Migration number: the schema is `db/migrations/0016_marketplace.sql` (renumbered from 0015 when another branch took
0015_email_deliveries). Re-check that the number is still free at merge time and renumber again (the schema and RLS
tests, the test helper and this page name it) if another migration landed first.

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
  `submitted`. Only `published` and `deprecated` versions are installable (`installs/sync` and the artifact route
  refuse the rest; the owner can still diff them).
- `PUT listings/:id/visibility`, `POST listings/:id/fork`, `GET listings/:id/compare`,
  `GET me/listings`, `GET me/teams`, `POST teams`, `GET teams/:id`, `POST teams/:id/members`,
  `DELETE teams/:id/members/:userId`, and `GET listings?scope=mine|team&team=`. Team management is
  owner-only; a team the caller is not in is a 404; the last owner cannot leave.
- A fork is a new private listing `<caller publisher>/<slug>` with `forked_from`,
  `forked_from_version` and `forked_base_sha256` (migration 0016). The upstream package is
  re-validated as stored (a tampered or newly failing upstream is a 422 with the report), the copy is
  rebuilt by `rewriteManifest` (new id, version `<base>-fork.1`, file hashes recomputed, deterministic
  stored-only zip, no runtime dependency on fflate) and validated again. Upstream rows are never
  written. `GET listings/:id` of a fork carries `upstream: {listingId, latestVersion,
  newerThanBase}`, computed from upstream versions the caller can see; `compare` defaults a fork to
  base = the recorded upstream version, head = its latest, and returns per-file status, hashes and a
  unified diff for text files up to 64 KB, each diff cut at 20 000 characters.

Fix-wave additions (2026-10-21 review): `POST versions/status` (anonymous, states only, 200 ids);
`DELETE listings/:id` and `DELETE listings/:id/versions/:versionId` (owner delete / withdraw; 409 `has_installs`);
compare needs a signed-in user; process-wide gates (4 concurrent, 16 queued, else 429 `busy` + `Retry-After`) around
compare, artifact downloads and preview/doc cache misses, and a 256 MiB in-flight upload budget reserved from
`Content-Length` before the body is buffered. `lastError` in `installs/sync` is stored as a code
(`download_failed`, `hash_mismatch`, `blocked_by_scan`, `unsupported_type`, `hermes_failed`, `permission_denied`,
`disk_error`, `other`) plus a sanitized detail of at most 120 characters (paths and tokens stripped).
Visibility is changed only by the server as `ao_admin` (the `ao_app` role has no UPDATE on it, and a trigger
refuses public/org from that role). The skill validator fails `no-hidden-executables` when any
executable-looking file lacks a matching `exec.script` scope, and `no-remote-images` for remote images.
On start `main.ts` runs the scanner on a built-in package (`selfcheck.ts`); if it fails, skill uploads (creator and
admin) answer 503 `scanner_unavailable` while browsing keeps working. The scanner needs `python3` and a
`vendor/hermes-agent` tree at `/srv/vendor/hermes-agent`: `deploy/Dockerfile.marketplace` adds python3 and
`deploy/docker-compose.yml` mounts the tree and passes `AO_MARKETPLACE_BUCKET`, `AO_MARKETPLACE_ROLES` and
`OFFICECLI_BIN` (unset: templates cannot reach `verified`). `POST /admin/marketplace/versions/:id/rescan`
(`marketplace.write`) re-validates the stored bytes and writes a fresh `validation` scan row, which is how a
creator version left `submitted` is approved. Creator and admin ingest write the same `validation` scan shape.

Limits (`src/marketplace/limits.ts`, env `AO_MKT_*` or handler `limits`): 100 listings per user, 50
versions per listing, 1 GiB of stored versions per user (409 `quota_exceeded` with `quota`), and an
ingest gate of 2 concurrent validations with 8 queued (429 `busy`, `Retry-After`). A comparison does
at most 50 text diffs, 8M LCS cells and nothing over 64 KB (`diff: null`, `reason`, `budgetLimited`),
and refuses packages over 32 MiB unpacked (413). Removing a member, or a member leaving, demotes the
team listings they own to private; a team listing only takes new versions from a current member.
Members can leave; the owner transfers with `POST teams/:id/owner` first.

## Admin API

Publishing, review, lifecycle and moderation live under `/admin/marketplace/*`
(`src/api/marketplace-admin.ts`, `marketplaceAdminHandler`, registered in `main.ts` just before the admin
handler; it needs MinIO). Every route authenticates with `admin.ts`'s bearer-token/Clerk path, checks a
permission, does the work as `ao_admin`, and writes `admin_audit` (`marketplace.<verb>`, ids and states only,
never artifact bytes) in the same transaction. A denied request changes nothing and is not audited.

Permissions (`src/marketplace/permissions.ts`, same shape as the control-plane `rbac.ts`, which is not in this
branch): `marketplace.read|write|review|moderate`; superadmin all, engineer read+write+review, analyst read,
support and finance none. Roles fail closed: `roleOf(adminId)` comes from `AO_MARKETPLACE_ROLES`
(`adminName:role,...`; unknown role is a startup error; Clerk admins map by email or user id), and an admin not
listed is an analyst, so **without `AO_MARKETPLACE_ROLES` the marketplace admin API is read-only**. Separation of
duties: only a superadmin creates publishers (an unknown publisher is 400 `unknown_publisher`; a failed package never
creates one), and a non-superadmin cannot approve or publish a version they submitted (409 `self_review`). A DB
trigger additionally refuses to move a version to approved/published unless its scan verdict is clean or warnings. Replace `permissions.ts` with a re-export of `rbac.ts` when it
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

### Admin console pages

The Marketplace section of the Next.js control-plane console (Overview, Catalog, Publish New, Submissions, Review
Queue, Installations, Usage Analytics, Ratings & Reviews, Publishers, Versions & Releases, Security Reports,
Settings, a Marketplace tab on the user page; Collections & Bundles is an honest placeholder until Plan 2) is
delivered as an **overlay patch**, not as files in this tree, because `services/control-plane` is not committed on
this branch: apply [`docs/audits/marketplace-admin-pages.patch`](/../docs/audits/marketplace-admin-pages.patch)
once the control-plane code is merged (command, env and what was verified are in
[`docs/audits/marketplace-admin-pages.md`](/../docs/audits/marketplace-admin-pages.md)). The pages call only the
routes above; the console shows nav items by `marketplace.*` permission and the API enforces them again.

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`docs/audits/marketplace-admin-pages.md`](/../docs/audits/marketplace-admin-pages.md)
- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
