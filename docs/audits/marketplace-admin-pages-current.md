# Marketplace admin console: verification views (Plan 4 Task 14)

STATUS: the overlay patches (`marketplace-admin-pages*.patch`) are gone. Plan 2 committed the pages straight into
`services/control-plane`, and the verification views below were ported onto those pages by hand (integration/followups).
NOT ported: the Plan 3 Task 12 advanced-type pages (Advanced Types, Type Policy, review summary page, by-type analytics,
risk filters) that the removed patch also carried; they are recoverable from commit 78634fcd3
(`git show 78634fcd3:docs/audits/marketplace-admin-pages-current.patch`) and from `marketplace-admin-pages-advanced.md`.
Ported pieces: Verification section and Run button on the version page, typed acknowledgement approve for an `incomplete`
verdict, Verification column in the Catalog, "Failed or incomplete verification" in Security Reports, the evidence proxy route,
`adminBytes`. The "Suspicious install bursts" section was not ported. Tests: `test/marketplace-verification.test.ts`.

## What Plan 4 Task 14 adds

| Where | What |
|---|---|
| Version page and Review detail | a **Verification** section: heading (`Pass` / `Partly` / `Failed` / `None`, pipeline, date, short artifact hash, "checked with an older pipeline"), one row per stage with a word and a glyph (never colour alone), reason, evidence behind a native `<details>` (keyboard accessible; an image loads only when opened), the latest job, a **Run verification** button (`marketplace.review`, confirmation dialog) |
| Approve of an `incomplete` verdict | the plain Approve button is replaced by a form that needs a typed sentence (20 to 500 characters), sent as `acknowledgeIncomplete`; the API stores it in `admin_audit` (`approve_incomplete`). A manual-review type also carries its summary acknowledgement in the same form |
| Catalog | a **Verification** column: Pass / Partly / None / Failed |
| Security Reports | two new sections: **Failed or incomplete verification** (current artifact only; stage ids and reasons) and **Suspicious install bursts** (Plan 4 Task 10 data) |
| `GET /admin/marketplace/evidence/[id]?sha=` (console route) | the proxy for evidence images: forwards the service token, so the browser never holds a blob URL; PNG only; `nosniff` and a sandbox CSP |

Server side, in `services/accounts-sync` on this branch (tested by `test/marketplace-verify-admin.test.ts`, real Postgres): catalog
rows carry `verification` (latest verdict for the latest version's CURRENT artifact; a result for another sha never counts);
`GET /admin/marketplace/versions/:id/evidence?sha=` (only a blob a verification row of THAT version references; uniform 404);
`GET /admin/marketplace/security/verification`.

## Verified in the scratch copy

- `npx tsc --noEmit`: clean. `npm run build` (Next 16): builds. `npm test`: 20 pass, 3 fail; the three failing files
  (`console-keycloak`, `oauth-flow`, `web`) fail identically on the untouched base tree, so they are not caused by the patch.
- `node --import tsx --test test/marketplace.test.ts`: the pure helpers (words, acknowledgement sentence, evidence path,
  stage rows, hostile `<img onerror>` text kept as a string) pass; they were red before the helpers existed.

## Not verified

- The pages were not rendered live (forged session cookie against a running admin API), as Plan 1 did. The build and the
  helper tests are the evidence; the screenshot pass (Plan 4 Task 17) was not run.
- The console shows a nav item only if `/admin/me` lists its permission. The `marketplace.*` permissions
  (`read|write|review|moderate|policy`) must be in the control-plane's role map; that is not part of this patch.
- The three pre-existing failing control-plane test files were not investigated.
