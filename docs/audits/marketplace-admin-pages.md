# Marketplace admin console pages

Task 13 of the extension-marketplace plan, applied into `services/control-plane` by the Plan 2 follow-up (T14). The pages are
committed code now; the overlay patch `marketplace-admin-pages.patch` was applied (two hunks, in `nav.ts` and `admin-api.ts`,
were merged by hand against the newer files) and then deleted rather than kept.

## What the pages are

Paths are relative to `services/control-plane`. The **Marketplace** nav group and these pages under `src/app/admin/marketplace/`:

| Page | Route | Data source |
|---|---|---|
| Overview | `/admin/marketplace` | `GET analytics`, `submissions`, `catalog?state=quarantined|revoked` |
| Catalog | `/catalog` | `GET catalog` (filters q/type/publisher/visibility/state, keyset pagination) |
| Publish New | `/publish` | `POST submissions` (type step, ZIP upload, existing publishers only, visibility); shows the server's per-check report; `verified:false` is shown as "unverified", never as success |
| Submissions / Review Queue | `/submissions`, `/review` | `GET submissions`; per-row lifecycle buttons |
| Version detail | `/versions/[id]` | `GET versions/:id`: manifest, permissions (sensitive ones highlighted), scan report, release events, action buttons (claim/approve/reject/publish/deprecate/quarantine/revoke/rescan, offered only when the state machine AND the viewer's permissions allow; reason required for reject/quarantine/revoke) |
| Installations | `/installations` | `GET installations` |
| Usage Analytics | `/analytics` | `GET analytics` only; shows `telemetryCoverage` and the `notCollected` list |
| Ratings & Reviews | `/reviews` | `GET reviews`, `DELETE reviews/:id` (confirm) |
| Publishers | `/publishers` | `GET|POST publishers` (create/verify shown to superadmin only) |
| Security Reports | `/security` | `GET reports`, `POST reports/:id/resolve`, catalog filtered to quarantined/revoked |
| Versions & Releases | `/releases` | `GET catalog` + links to each version's events (the API has no cross-listing event feed, and the page says so) |
| Collections & Bundles | `/collections` | none: honest "not available in this release" (Plan 2) |
| Settings | `/settings` | read-only: your role and permissions from `/admin/me`; says plainly that the roles source, scanner and OfficeCLI status are not exposed by the API |
| User page, "Marketplace" tab | `/admin/users/[id]?tab=marketplace` | `GET users/:id/installs`: installs (version, state, enabled, scan verdict, installedAt, lastError, scope, device), teams, favorites, reviews, failed installs |

Supporting changes: `src/lib/marketplace.ts` (pure helpers: `allowedActions(state, permissions)`, `canRescan`,
`summarizeValidation`, `listQuery`, `withParams`, pack/unpack of a validation report across a redirect),
`src/components/admin/{marketplace.tsx,ReasonForm.tsx}`, `src/app/admin/marketplace/actions.ts` (server actions),
`test/marketplace.test.ts`. Edited existing files (small): `nav.ts` (the group), `Shell.tsx` (the Marketplace
Overview item matches its own path exactly, so it is not highlighted on every sub-page), `admin-api.ts`
(`bytes` option for a binary POST, `AdminApiError.body`), `next.config.ts` (`serverActions.bodySizeLimit: '64mb'`
for package uploads), `users/[id]/page.tsx` (the tab).

## Required configuration

- On the API (accounts-sync): `AO_MARKETPLACE_ROLES=adminName:role,...`. Without it every admin is an analyst and
  the console's write buttons are refused by the API (403).
- Permissions: the console no longer needs `marketplace.*` in accounts-sync `rbac.ts`. `adminContext()` (`src/lib/session.ts`) also
  asks `GET /admin/marketplace/me` (added in the Plan 2 follow-up) and merges exactly the marketplace permissions the marketplace API
  itself enforces for that admin (`withMarketplacePermissions`, unit-tested). If that endpoint does not answer, the admin has no
  marketplace permissions (fail closed) and the nav group is hidden. `marketplaceAdminHandler` is mounted in accounts-sync `main.ts`
  when object storage is configured.
- The console's usual: `AO_ADMIN_API_URL`, `AO_ADMIN_API_TOKEN`, `ADMIN_HOSTS`.

## Verified

- `npx tsc --noEmit` and `npm run build` (Next 16.4.2) pass in the scratch copy, all 13 new routes built.
- Unit tests for the pure helpers: `node --import tsx --test test/marketplace.test.ts`, 8 pass.
- Patch: `git apply --check` and apply into a fresh clone of the base commit (laid out as
  `services/control-plane`), result byte-identical to the scratch tree; `--check` also passes against the live
  umibozu working tree at the time (copied, not modified).
- Live render: the dev server (`services/accounts-sync/scripts/marketplace-dev-server.ts --admin --http`, a new
  dev-only flag that mounts the real `marketplaceAdminHandler` with embedded Postgres and the real validators, plus
  stand-ins for `/admin/me`, `/healthz`, `/admin/users/:id`) and the console in Keycloak mode with a
  locally signed session cookie (the console's Better Auth/Keycloak gate was bypassed by signing the session cookie
  with the test `AUTH_SECRET`, not by changing code). All 15 pages answered 200 and rendered in headless Chrome
  (screenshots read for catalog, overview, version detail and user tab). Through the real forms: uploaded two skill
  packages (16 checks, verified, incl. security-scan), saw them queue, claimed and approved one, rejected one with a
  required reason, and saw the rejected listing in the catalog.

## Not verified

- A real Better Auth or Keycloak sign-in (the session was forged), the console's own AUTH_TEST_PG tests (they import
  `../../accounts-sync`, absent in the scratch layout; 3 existing tests fail to load there for that reason only).
- Publish, deprecate, quarantine, revoke, rescan, review delete, report resolve, publisher create/verify buttons were
  not clicked in the browser (they share the same action plumbing as claim/approve/reject, which was).
- Non-superadmin views (the dev server ran as superadmin); `allowedActions` is unit-tested for roles.
- The skipped-check ("not verified") path was exercised only by unit test, not live (the dev machine ran every check).
- Template uploads (needs OfficeCLI render) were not tried; mobile layout not looked at.

## Plan 2 additions (agents and bundles, T14)

| Page / change | What it does | Data source |
|---|---|---|
| Version detail, agent | Blueprint component table (supported / not available yet / unknown), compiler and dry-run result, derived vs declared permissions, dependency list | stored manifest and recorded validation checks; `permissions-subset` now carries `derived: ...; declared: ...` |
| Version detail, bundle | Members and pins (manifest dependencies, `=version`), closure and union checks, manual-review notice | stored manifest and checks |
| Version detail, manual review | The server-built summary and a button that sends back the server's own `summarySha256` (only with `marketplace.review`) | `GET submissions/:id`, `POST versions/:id/approve` with `ack_summary_sha256` |
| `/admin/marketplace/policies` | Organization install policy form (mode, minimum trust, clean scan, rules); disabled and never fetched without `marketplace.policy` | `GET|PUT policies/org` |
| `/admin/marketplace/team-assignments` | Read-only table with pinned version and `blocked` status | `GET team-assignments` |
| `/admin/marketplace/collections` (now "Agents & Bundles") | Agents and bundles with their latest version | `GET catalog?type=agent|bundle` |
| Publish New | Offers `agent` and `bundle` with their package layout | `POST submissions` |

Not shown, because the API does not store it: the dry run's step list (only the outcome and a step count), a bundle's install order
and sha256 pins (they live in `bundle.json`, which the version detail does not return). The pages say so.

Tests: `node --import tsx --test test/marketplace-plan2.test.ts` (pure helpers) and `test/marketplace-pages.test.ts` (a real
`next start` against a stub admin API that records requests; needs `npm run build`).
