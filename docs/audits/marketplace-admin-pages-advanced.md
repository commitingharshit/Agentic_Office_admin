# Marketplace admin console pages for the advanced types (incremental overlay patch)

Plan 3 Task 12. Apply AFTER `marketplace-admin-pages.patch` (it edits files that patch creates). Paths are relative to
`services/control-plane`, which is still not committed on this branch.

    git apply --check --directory=services/control-plane docs/audits/marketplace-admin-pages.patch
    git apply         --directory=services/control-plane docs/audits/marketplace-admin-pages.patch
    git apply --check --directory=services/control-plane docs/audits/marketplace-admin-pages-advanced.patch
    git apply         --directory=services/control-plane docs/audits/marketplace-admin-pages-advanced.patch

## What it adds (14 files)

| Page | Route | API |
|---|---|---|
| Catalog | `/catalog` | adds the 11 real types, Risk tier and Manual review filters, Risk column |
| Review Queue | `/review` | Risk column, high-risk preview; a manual-review version gets a "Review summary" button instead of Approve |
| Review detail (new) | `/review/[id]` | `GET submissions/:id`: the server-built summary per type, high-risk list, automated checks, policy, and the acknowledgement step (required "I reviewed this summary" box; the page posts the hash that was rendered; refused by the API if the version changed) |
| Advanced Types (new) | `/advanced` | `GET security/advanced`, `POST types/:type/halt` (dialog: type the type name, reason) |
| Type Policy (new) | `/policy` | `GET type-policy`, `PUT type-policy/:type` (superadmin only; only raises) |
| Usage Analytics | `/analytics` | "By type" section from `GET analytics/advanced` (coverage and not-collected notes shown as the API states them) |

Supporting: `src/lib/marketplace.ts` (pure helpers: `ackState`, `approvalRequest`, `haltRequest`, `policyChange`, `riskPreview`,
`typeRows`; the type list is now the API's 11 types, the old list was wrong), `AckForm.tsx`, `HaltForm.tsx`, `actions.ts`
(`approveWithAck`, `haltTypeAction`, `saveTypePolicy`), `nav.ts` (two items), `admin-api.ts` (PUT), `test/marketplace-advanced.test.ts`.

## Verified (scratch repo: copy of the earlier admin-pages scratch, BASE + pages patch + this change)

- `npx tsc --noEmit` and `npm run build`: pass; routes `/advanced`, `/policy`, `/review/[id]` built.
- `node --import tsx --test test/marketplace-advanced.test.ts test/marketplace.test.ts`: 16 pass.
- `git apply --check` and apply of both patches, in order, into a fresh clone of the base commit laid out as
  `services/control-plane`: succeed; result identical to the scratch tree (`src` and `test`).
- Live render: dev API (`scripts/marketplace-dev-server.ts --http --admin --advanced`, port 8795) plus the built console with a
  locally signed session cookie (Keycloak mode, `AUTH_SECRET` signed, no code bypass; the Chrome run went through a header-injecting
  proxy). Catalog (executable filter), Review detail (bridge and connector), Advanced Types, Usage Analytics and Review Queue answered 200 and
  were looked at. The first render showed the artifact hash "withheld" by the credential scan; fixed in `summary.ts` and re-checked.

## Not verified

- Clicking the Approve (acknowledgement), Halt and Save-policy buttons in a browser (the dev admin is the submitter, so approval is refused
  by separation of duties anyway; those paths are covered by the API tests and the helper unit tests).
- A real Keycloak/Better Auth sign-in; non-superadmin views (the dev server runs as superadmin); mobile layout.
- `marketplace-admin-pages.patch` no longer applies to the current umibozu control-plane working tree (`src/lib/admin-api.ts` changed
  there since it was made); both patches apply to the recorded base. Rebase the first patch before applying either to that tree.

## Required API configuration

Same as the first patch (`AO_MARKETPLACE_ROLES`, `marketplace.*` in the console's rbac). The policy page needs `marketplace.policy`
(superadmin), halting needs `marketplace.moderate`.
