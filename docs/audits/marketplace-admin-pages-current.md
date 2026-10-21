# Marketplace admin console pages: the current patch (Plan 4 Task 14)

`docs/audits/marketplace-admin-pages-current.patch` replaces BOTH `marketplace-admin-pages.patch` (Plan 1) and
`marketplace-admin-pages-advanced.patch` (Plan 3 Task 12). Neither older patch applies any more: `services/control-plane`
is now committed on master and its `nav.ts` and `admin-api.ts` drifted (Growth group, `adminUpload`, `PUT`). The older files
are left in place for history; do not apply them. This one is one patch against the CURRENT tree: the two older patches
re-applied with the two drifted hunks resolved by hand, plus the verification views below.

## Apply

    git apply --check --directory=services/control-plane docs/audits/marketplace-admin-pages-current.patch
    git apply         --directory=services/control-plane docs/audits/marketplace-admin-pages-current.patch

The `--check` was run against a clean `services/control-plane` of master (0db86d092 plus this branch, which does not touch that
tree). The patch was made by `git diff --cached --binary` in a scratch repo whose base was a copy of that tree.

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
