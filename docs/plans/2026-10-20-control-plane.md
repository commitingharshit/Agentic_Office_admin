# Control plane: sign-in, admin console, credits and coupons

Started 2026-10-20. Design and API contract: [`okf/architecture/control-plane.md`](../../okf/architecture/control-plane.md). Services:
[`services/api`](../../services/api/README.md) (data plane, billing, managed inference) and
[`apps/console`](../../apps/console/README.md) (Better Auth + admin console).

## Why

Sign-in was half-wired: the first prompt opened an OAuth window even when signed out, the server address defaulted to empty, Clerk's
production domain rules blocked a public release, two account systems disagreed, and there was no admin console, no credits, no coupons,
no managed compute. Principle: **the desktop never needs an account to open and edit local documents.** Signing in unlocks account features
(sync, managed compute, credits). Agentic Office login and Hermes provider login are separate; BYOK never goes through our server.

## Decisions (made with the owner)

- Replace Clerk with **Better Auth** (self-hosted OAuth 2.1 provider, PKCE, loopback redirect). Clerk stays behind a flag until cutover.
- The desktop keeps its **`aod_` device token** as the credential (hashed, per device, revocable). Better Auth's JWTs cannot be revoked, so the ID
  token is only exchanged once at `POST /v1/auth/exchange`, bound to the device's nonce.
- Only `users` is shared with Better Auth (so every `usr_` id survives); its other tables are `auth_*` (0006) and `oauth*`/`jwks` (0009).
- Milestone 1 = sign-in UX + auth + admin users/devices + coupons/credits. Deferred: phone OTP, announcements, signed updater.
- Host: `tanmay-hp-linux-server` (beta), tailnet only. Public HTTPS tunnel later. DB passwords are filler values until real use.

## Status

| Piece | State | Evidence |
|---|---|---|
| Desktop: no sign-in window on first prompt; "Not signed in" card on the avatar | done, **run in a window 2026-10-21** | built this worktree's fork (clones of the main checkout's `node_modules`, `build/node_modules`, `.build`, extension outputs + `build/next transpile`, ~2 min), launched an isolated instance; over CDP: no sign-in window, icon reads "Not signed in", click opens the card with Google/Microsoft/email, server field prefilled, "Use my own model provider"; docx extension compiles with 0 type errors against real VS Code types |
| Desktop: browser PKCE client (`account/oauth.ts`), used when the server advertises OAuth | done | `bun test src/account/` 25 pass (fake service, hostile cases) |
| Migrations 0006 (auth tables), 0007 (billing), 0008, 0009 (auth role, OAuth tables, desktop client row) | done, applied on host | schema + billing tests |
| Credits, coupons, reservations, ledger (SQL functions, RLS, append-only) | done | `billing.test.ts` 20, concurrency + mutation-checked |
| Billing/devices/API-key/inference HTTP routes, rate limits | done | `billing-api.test.ts`, `inference.test.ts` |
| Managed inference: non-stream, stream, `/chat/completions`, `/models` | done, provider fake only | tests with fake upstream; no real provider configured |
| Admin API: plans, coupons, credits, plan, role (last-admin guard), acting-admin audit | done | `admin-roles.test.ts` (own database) |
| Better Auth service + OAuth provider + `ao_auth` least-privilege role | done | `oauth-flow.test.ts` 11 pass (real flow incl. exchange) |
| Admin console (overview, users, user detail actions, coupons, audit), private-host gate | done | `web.test.ts` (real `next start`) |
| Deployed on the host behind Tailscale Serve (HTTPS, tailnet only) | up | full real sign-in over HTTPS: browser PKCE -> ID token -> exchange -> device token -> credits -> coupon -> sign-out revokes; 13/13 headless browser check over HTTPS with the real clock |
| accounts-sync full suite on host | 96 pass, 0 fail, 1 skipped (needs MinIO) | |
| control-plane suite on host | 27 pass, 0 fail, 0 skipped | real `next start`, least-privilege auth, desktop OAuth, MFA and form POSTs |
| Admin TOTP MFA (**switched off for now at the owner's request 2026-10-21**: `ADMIN_REQUIRE_MFA=false` on the host; on by default, any value but exactly `false` keeps it on; the console shows a warning banner while it is off; re-enable by setting it to `true` and redeploying) | implemented; migration 0010 verified in scratch DBs, not applied to live DB | enrollment + session-bound verification; ordinary desktop sign-in stays unchanged |
| Streaming mutation checks | done, re-run independently 2026-10-21 | each mutant: 25 pass / 1 fail (the matching streaming test); unchanged code: 26 pass / 0 fail |
| Admin console form actions | done | six real multipart form POST tests assert DB + audit; user, password-only admin and wrong-host POSTs do nothing |

## Blocked on a human

- ~~**HTTPS issuer.**~~ Done 2026-10-21: `tailscale serve` on `tanmay-hp-linux-server` publishes the sign-in service at `https://tanmay-hp-linux-server.tail41864f.ts.net` (:443) and the API at `...:8443` (tailnet only, real certificate). The containers are bound to 127.0.0.1 so Serve is the only way in; `AUTH_BASE_URL` / `AUTH_ISSUER` are the https name; `ADMIN_HOSTS` lists it plus `localhost`; the desktop default `agenticOffice.account.serverUrl` is the :8443 address. (Cause of the earlier failure: the OAuth provider forces an `https` issuer for any non-loopback host, RFC 8414.) A public address (tunnel) is still a later step.
- ~~**Host clock.**~~ Fixed: `NTPSynchronized=yes`, host and Mac agree to the second.
- Google / Microsoft sign-in: needs OAuth client credentials (`GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_*`); email+password works now.
- A real model provider for managed inference (`AO_PRICING`, `AO_UPSTREAM_URL`, `AO_UPSTREAM_KEY`).

- **Host clock.** `tanmay-hp-linux-server` reports `NTPSynchronized=no` and ran ~60 s slow, so a correct authenticator code is rejected (30 s window) and token expiry is skewed. Fix needs root on the host: `sudo timedatectl set-ntp true`. Until then enrolling a phone authenticator will fail; the browser check works around it by computing codes from the server's own `Date` header.

- **Live data copy: DONE 2026-10-21.** Source: Windows `ao-data` (left running, untouched): 2 real users (`onmailharshit@gmail.com`, `codingharshit1408@gmail.com`, Google via Clerk), 1 device, 9 device tokens (all expired/revoked, none live), 1 workspace, 14 audit rows, ~9 MB, no sync events or blobs. Copy: compose project `ao-live` on `tanmay-hp-linux-server` (fresh volumes; the old test project `ao-control-plane` is stopped, its volumes kept), strong random secrets in the host's mode-600 `.env` files (the filler files are `*.test-filler.bak`), Clerk keys copied across, migrations 0001-0011 applied to an empty DB, then a data-only restore of a dump whose sha256 `e0536ca4...ac02d` was verified in the source container, on Windows, on the Mac and on the host. Verified: per-table content fingerprints (md5 of ordered rows for users, oauth_accounts, devices, device_tokens, workspaces, admin_audit) are IDENTICAL on source and copy; duplicate-email audit 0, missing emails 0, so migration 0011 (unique live email) is applied; both real users are admins on their original `usr_` ids with a password sign-in attached (they sign in through the real form and see themselves in the admin panel); pgAdmin ('the workbench') is at `http://100.95.14.113:5050` (tailnet only) with admin and read-only connections whose roles were tested against the live DB (read-only cannot write or read payloads); `GET /v1/auth/config` advertises both our OAuth issuer and the Clerk key, and the API reports `sign-in Clerk+ours`. Test runners (`scripts/dev/remote-*-tests.sh`) now use their own throwaway Postgres container, never the live DB. "Retire" = stop using Clerk later (needs Google Cloud setup first); not now. Windows stack stays until the owner decides. Desktop clients that should use the copy: point `agenticOffice.account.serverUrl` at `https://tanmay-hp-linux-server.tail41864f.ts.net:8443` (already the default).

## Remaining (not started unless noted)

2. Desktop: the title-bar avatar gets a push from the extension (`workbench.action.agenticOffice.accountChanged`; the poll is only the 20-30 s net), verified in a window with the signed-out card (see Status). Still open: (a) clicking a provider against the beta host fails at the issuer check until HTTPS is on (Blocked); (b) the stock Accounts menu is the *collab* account (`setAccount`), a separate system, merging it is the documented identity phase 2; (c) ~~the signed-out flow as a committed e2e script~~ done: `scripts/e2e/assistant/signed-out-flow.mjs --port <debug port> --out <dir>` (passes against the live test window).
4. ~~Visual check of the admin console and MFA page in a browser~~ done 2026-10-21 with headless Chromium (`tests/tools/control-plane-browser-check.mjs`, 13/13 on the live host: sign-in, held at `/mfa`, TOTP enrolment, wrong code refused, console, coupon create/disable, credit grant, audit, no console errors; screenshots reviewed). It found two things the suites could not: the host's clock was ~60 s slow (see Blocked) and a deployed `ADMIN_HOSTS` without `localhost` turned every successful form action into a 404 (fixed in the host `.env`, now documented and logged). (Migration 0010 and the MFA build were then applied and deployed on the host on 2026-10-21; checked live: a password-only admin is redirected to `/mfa` on `/admin`, `/admin/users` and `/admin/coupons`. Enrolling a TOTP in a real browser has not been done.)
5. Retire Clerk after cutover; duplicate-email audit then the unique-email index (next available migration; 0010 is admin MFA); the Windows box (`harshit-windows-coding`) was offline, so the audit queries in `okf/architecture/control-plane.md` have not been run on real data.
6. ~~Update `okf/architecture/identity.md`~~ done.
7. Updater/release channels, phone OTP, announcements (deferred, milestone 2).

## Completed verification (2026-10-20 continuation)

- Streaming mutations used isolated copies of `services/api` through `SERVICES_DIR`, one change per run:
  removing the response-close abort failed “the provider call was cancelled”; removing the `stream_options` strip
  failed the caller-options assertion; replacing the usage estimate with zero failed “charged 0, expected 211”.
  **Each: 25 pass, 1 fail, 0 skipped.** Real source restored on the host by the next runner invocation:
  **26 pass, 0 fail, 0 skipped**. Existing tests caught all three; no strengthening was necessary.
- Admin MFA uses Better Auth `twoFactor` TOTP plus a server-only `auth_sessions.adminMfaVerified` flag.
  `/admin` pages/actions require both verified enrollment and proof on that session, otherwise `/mfa`.
  The flag follows the session rotated during enrollment verification; other existing password sessions stay gated.
  Migration **0010_admin_mfa.sql** was generated using `npx auth generate --config auth.cli.ts` against a
  migrated 0001–0009 scratch database on the host; `ao_auth` grants were added explicitly, following 0009.
- Final full accounts-sync run after migration 0010: **96 pass, 0 fail, 1 skipped** (MinIO unavailable).
- Final full control-plane run: **27 pass, 0 fail, 0 skipped** (`test/*.test.ts`): OAuth **11/0** and web **16/0**.
  TOTP codes are computed independently in the test; wrong six-digit codes, unverified enrollment,
  another password session and a fresh sign-in challenge cannot reach admin pages. Normal desktop sign-in
  and the complete PKCE → tokens → device exchange still pass.
- Six form tests submit the rendered Next `$ACTION_*` fields as multipart browser requests, exercising grant credits,
  set plan, set role, disable user, create coupon and disable coupon. Each checks persisted state and the acting-admin
  audit row, and repeats the POST as a non-admin, a password-only admin and through a wrong hostname,
  asserting that neither business data nor audit rows change.
- Development failures were fixed before the final run: the first web run was **5 pass / 5 fail** because proof
  was written against the pre-rotation session; the first form run was **15 pass / 1 fail** because a test
  incorrectly expected disabling an account to delete its sessions. The final test checks disabled status and
  refused subsequent sign-in instead. No live deployment or visual browser verification is claimed.

## How to test

```
scripts/dev/remote-accounts-sync-tests.sh [test/file.test.ts]         # throwaway DB on the host
BUILD=1 scripts/dev/remote-control-plane-tests.sh [test/file.test.ts] # control-plane, builds first
GENERATE_AUTH=1 scripts/dev/remote-control-plane-tests.sh            # generate schema against a migrated scratch DB, print SQL; no tests
cd apps/editors/docx/extension && bun test src/account/               # desktop client (Bun workspace: never npm install there)
python3 scripts/dev/check-okf.py && python3 scripts/dev/check-repo-layout.py
```

Never commit `.env` files; the host's are mode 600 in `~/ao-control-plane/**/deploy/.env`. A mutation check is "change the code in a copy, set
`SERVICES_DIR` to the copy, the named test must fail": three done for credits/coupon locks, device revocation, API-key scope, plan gate, nonce binding, disabled-account hook.

## Admin console redesign (2026-10-21)

Slice B0/B1 of the console plan is built, deployed to the host and checked in a real headless browser at 1440 and 900 px (0 console errors, every route 200, screenshots reviewed).

- **Backend:** migration `0012_admin_roles` (RBAC: superadmin, engineer, support, finance, analyst; the API enforces a permission per route and audits refusals), new read APIs (overview series, activity, sessions, auth sessions, usage summary, subscriptions, runs, admins) and actions (revoke a device or browser session, plans, admin role). Privacy rules are tested: workspace names, session titles and event payloads never leave the API. accounts-sync suite 111 tests; control-plane 28/28.
- **Front end:** design tokens from the desktop app, the real logo, a component set (shell, command palette, tables with URL-driven sort and paging, tabs, confirm dialogs), and pages for Overview, Users, User 360, Sessions, Agent Runs, Billing & Plans, Compute & Credits, Coupons, Security & Audit and Settings. Modules without a data source (Communications, Product Analytics, Reliability, Support, Feature Flags, Infrastructure) say so and show no numbers.
- **Live host:** migration 0012 applied to the live database after a manual dump (`~/ao-backups-manual/pre-0012-*.dump` on the host); api restarted; web image rebuilt.
- **B2, opt-in run telemetry (done, 2026-10-21):** migration `0013_run_telemetry` (usage_consent, run steps, verification results; row-level security), `POST /v1/telemetry/runs` (allow-listed ids/enums/counts/timings only, unknown or free-text fields refuse the whole batch, refused while sharing is off, idempotent by run id, another person's run id cannot be overwritten), `GET/PUT /v1/me/usage-consent` (withdrawing can erase). Desktop setting `agenticOffice.account.shareUsage` (default off) pushed to the server at start, sign-in and change. Hermes `SyncClient.push_runs` + `sanitize_run` (free text cannot leave; pytest). Console: Reliability and Product Analytics, always shown against "N of M users share usage", empty rather than zero.
- **B3, operations (done):** migration `0014_operations` and `src/api/ops.ts`. Feature flags evaluated on the server (plan + stable percentage rollout) with `GET /v1/config/client`; `killswitch.managed_inference` is enforced before any model call. Announcements (in-app, read receipts, plan targeting, expiry; email and WhatsApp report "not configured"). Support tickets people open themselves (row-level security; admin reply/close). Infrastructure page from the real health data; Settings shows which integrations are connected.
- **Verification:** accounts-sync 124 tests (123 pass, 1 skipped for MinIO; three consecutive full runs green after making two test races robust), control-plane 30/30, desktop client `bun test src/account/` 52 pass, Hermes `tests/kernel/test_run_telemetry.py` 6 pass. Mutation checks each fail the matching test: consent gate, field allow-list, success-rate denominator, kill switch. Migrations 0012-0014 are applied on the live host (a dump taken before each in `~/ao-backups-manual/` on the host).
- **Wired end to end (later the same day):** `TurnRecorder` builds a metadata-only record per finished turn (`run_record`: ids, state, timings, tool-call count and tool NAMES; never text, arguments, results or the failure reason), the memory plugin sends the queue after each event push through `DeviceSync.push_runs`, which sends only when the desktop bridge reports `shareUsage === true` (the app exposes the setting through `Account.forAgent()`). A fixture generated by the Python sanitizer is posted to the real server in `telemetry.test.ts`, so the two allow-lists cannot drift apart. Hermes pytest 8 pass; `tests/kernel` 55 pass.
- **WAL archiving "4 failures":** one burst at 21:35 on 2026-10-20 (`test ! -f` found segment 1 already archived while the live data was being restored); archiving has continued since (last segment archived after the failure). The console now judges WAL by "archived since the last failure", not the lifetime count.
- **Live write actions exercised in a real browser against the host:** saved and deleted a flag (confirmed in the database), published an announcement and switched it off through the confirmation dialog, opened the command palette with Ctrl+K; 0 console errors. The inactive announcement titled "Verification ..." remains as the audit trail. Coupons and credit grants were not run on real data (they create ledger rows that cannot be removed).
- **Email delivery is built (migration 0015, `src/api/mailer.ts`, `ops.emailAnnouncement`):** a Resend adapter that is off unless `RESEND_API_KEY` and `AO_MAIL_FROM` are both set; an admin presses Email (type SEND to confirm) and each active person with an address who has not had it yet gets one message; each result is recorded only from the provider's own answer (`sent` with its message id, or `failed` with its error), a failure does not stop the rest, and re-sending retries only failures. Tested against a fake provider (refusal with no provider, request shape, once per person, failure recorded and retried, switched-off announcement refused; adapter unit tests); mutation check (removing the already-sent filter) fails the test. Live on the host. Verified with a real provider on 2026-10-21: with a Resend key and the test sender `onboarding@resend.dev`, one announcement went to the two real accounts: codingharshit1408@gmail.com was `sent` (provider id recorded) and onmailharshit@gmail.com was `failed` with Resend's own 403 (the test sender may only mail the Resend account owner's address), both recorded from the provider's answers. Sending to everyone needs a verified domain sender.
- **Still outside this repo's control:** a verified sending domain so email can reach people other than the Resend account owner; Google/Microsoft sign-in needs OAuth clients from the owner; Clerk stays until then. Failure reporting is now two honest signals rather than none: a turn that started but never finished before the next one began is reported as `cancelled` (`user_cancelled`), and a turn whose final reply was empty as `failed` (`model_error`); anything finer needs Hermes to classify errors, which it does not do yet. Tests: abandoned turn, empty reply, normal turn.
- **Coupon on real data:** created a one-credit, one-use coupon in the live console and disabled it through the dialog (a disabled `VERIFY-...` coupon remains). A credit grant was then run on real data with the owner's approval: +1 and a -1 reversal on the owner's own account through the live console form (ledger shows both rows, named, balance back to 0, both reasons marked as console verification).

## Google sign-in (2026-10-21)

The owner created a Web OAuth client in Google Cloud project `agentic-512304` (redirect `https://tanmay-hp-linux-server.tail41864f.ts.net/api/auth/callback/google`, consent screen in Testing with both owner accounts as test users). Its Client ID and secret are in the host's `~/ao-control-plane/control-plane/deploy/.env` (mode 600, backup `.env.pre-google.bak`) and the web service was recreated. Checked in a headless browser: the sign-in page shows "Continue with Google", and pressing it reaches Google's own sign-in page with the right client id and redirect address (no redirect-mismatch error). **Not yet done:** the final click-through with a real Google login (it needs the owner's Google password/2FA, which only the owner can enter), and confirming it lands on the existing account instead of making a duplicate. Microsoft is not configured.
