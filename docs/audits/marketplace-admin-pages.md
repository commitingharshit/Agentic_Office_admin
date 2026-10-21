# Marketplace admin console pages (overlay patch)

Task 13 of the extension-marketplace plan. The control-plane console (`services/control-plane`, Next.js) is not
committed on this branch, so the pages are delivered as a patch against that tree instead of files here.

## What the patch contains

`docs/audits/marketplace-admin-pages.patch` (paths relative to `services/control-plane`, 24 files). It adds a
**Marketplace** nav group and these pages under `src/app/admin/marketplace/`:

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

## Apply

From the repo root, once `services/control-plane` exists:

    git apply --check --directory=services/control-plane docs/audits/marketplace-admin-pages.patch
    git apply         --directory=services/control-plane docs/audits/marketplace-admin-pages.patch

The patch was made with `git diff --binary --relative=control-plane <base>..HEAD` in a scratch repo whose base is a
clone of the umibozu control-plane working tree (uncommitted, as of 2026-10-21). Both applications below succeeded.

## Required configuration

- On the API (accounts-sync): `AO_MARKETPLACE_ROLES=adminName:role,...`. Without it every admin is an analyst and
  the console's write buttons are refused by the API (403).
- The console must be told the marketplace permissions: it shows an item only if `/admin/me` lists its `perm`.
  **`services/accounts-sync/src/api/rbac.ts` in the control-plane tree does not list `marketplace.*` today**, so
  until its `permissionsOf` includes `marketplace.read|write|review|moderate` (same grants as
  `src/marketplace/permissions.ts` here), the nav group is hidden. That change is NOT in this patch (it is
  accounts-sync, not control-plane) and the admin handler must also mount `marketplaceAdminHandler` (main.ts).
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
