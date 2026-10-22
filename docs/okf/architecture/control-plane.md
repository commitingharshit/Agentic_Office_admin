---
type: Architecture
title: Control plane
description: The planned central backend (Better Auth identity, admin console, credits and coupons, managed inference) beside the local-first desktop, the schema mapping that keeps existing user ids, and the API contract.
resource: services/api/
tags: [control-plane, auth, better-auth, admin, credits, coupons, accounts]
timestamp: 2026-10-20T00:00:00Z
---

Status: **planned** (Phase 0 of the control-plane plan). Nothing below the "Desktop" section exists
in code yet; the desktop signed-out behaviour shipped first. Check the code before trusting any
"will" here.

## Rule

The desktop never requires an account to open or edit local documents. Signing in unlocks
account-dependent features (sync, managed compute, credits). Agentic Office login and Hermes
model-provider login are separate identities: BYOK and Hermes provider login stay local and are
never routed through our server.

## Desktop

- Signed out is a normal state. `agenticOffice.account.requireSetup` defaults to `false`; the
  title-bar avatar opens a "Not signed in" card with the sign-in buttons
  (`apps/desktop/.../agenticOffice/browser/account.contribution.ts`).
- Startup restores the session silently from SecretStorage; it never opens a browser by itself.
- Sign-in uses the system browser, Authorization Code + PKCE (S256) and a `127.0.0.1` loopback
  redirect (RFC 8252), as `account/account.ts` `browserSignIn` already does.

## Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Who is this person (Google, Microsoft, email, later phone) | Better Auth (`apps/console`, Next.js) | replaces Clerk behind `AUTH_PROVIDER=clerk\|better-auth` until cutover |
| Credential the desktop presents to `/v1/*` | accounts-sync `aod_` device token (`device_tokens`) | unchanged: hashed, per device, revocable, sliding 90 days |
| Entitlements, credits, coupons | accounts-sync Postgres | append-only ledger |
| Local documents, agent state | desktop SQLite and files | never reachable from admin APIs |

Why the device token stays the credential: Better Auth's JWT access tokens cannot be revoked
server-side (only expire), and per-device revocation plus the RLS code in `src/api/sync.ts` already
exist. After the browser PKCE sign-in, the desktop exchanges the Better Auth result at
`POST /v1/auth/exchange` for an `aod_` token, exactly as it exchanges a Clerk JWT today. The
`oauthProvider` plugin (`@better-auth/oauth-provider`, public native client, `token_endpoint_auth_method: none`)
is used for the loopback authorization-code step.

## Schema mapping

Only the user table is remapped, so `usr_<ulid>` ids survive. Everything else Better Auth needs gets
new `auth_*` tables; `oauth_accounts` stays as it is, because its `purpose='connector'` rows belong
to memory sources.

| Better Auth model | Table | Mapping |
|---|---|---|
| `user` | existing `users` | `modelName: "users"`; `name`->`display_name`, `image`->`avatar_url`, `createdAt`->`created_at`; `generateId` for the user model returns `usr_<ulid>`; `role` and `status` as `additionalFields` with `input: false`; new columns `email_verified`, `updated_at` |
| `account` | new `auth_accounts` | provider subject, provider tokens only if a connector needs them |
| `session` | new `auth_sessions` | browser sessions of the web admin and sign-in pages, not desktop sessions |
| `verification` | new `auth_verifications` | email links, later phone OTP |
| oauth-provider tables | created by the plugin | prefixed `oauth_*` by the plugin; review for name clashes with `oauth_accounts` |

Linking existing people: the first Better Auth sign-in with Google or Microsoft links to the
existing `users` row by verified email (`account.accountLinking.trustedProviders`), so a person
keeps one `usr_` id and their synced data. This needs one live `users` row per email, so
migration 0006 adds a partial unique index on `lower(email)` where `status <> 'deleted'` **only
after** the duplicate audit below returns zero rows.

### Audit queries (run as `ao_readonly`, e.g. admin `POST /admin/sql`)

```sql
-- must return 0 rows before the unique index
SELECT lower(email), count(*) FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- users with no email cannot be linked by email
SELECT count(*) FROM users WHERE email IS NULL OR email = '';
-- identities by provider, to see what Clerk really carried
SELECT provider, purpose, count(*) FROM oauth_accounts WHERE revoked_at IS NULL GROUP BY 1, 2;
-- tokens that must keep working through cutover
SELECT count(*) FROM device_tokens WHERE revoked_at IS NULL AND expires_at > now();
```

Migrations are forward-only SQL run by `db/migrate.ts`; each 0006+ file adds columns or tables and
drops nothing, so a rollback is "stop using the new tables".

## Deployment

One Next.js service (public auth/API routes and the admin console) beside the existing accounts-sync
stack. A Cloudflare Tunnel exposes only the public hostname; the admin console binds to the
Tailscale address and is refused when the request arrives on the public hostname. Clients always
call a stable public domain so the backend can move later.

## API contract (clients depend on this, not on tables)

```
GET    /v1/me                    user, plan, entitlements
GET    /v1/me/devices
DELETE /v1/me/devices/{id}
POST   /v1/auth/exchange         Better Auth result -> aod_ device token
POST   /v1/auth/signout
GET    /v1/credits/balance
POST   /v1/coupons/redeem
GET    /v1/usage
POST   /v1/inference/responses   managed inference only
```

Existing `/v1/*` sync routes keep working unchanged.

## Credits and coupons

An append-only `credit_ledger` (grant, reserve, settle, expire, refund; promotional and paid kept
apart). A coupon redemption is one transaction: lock the coupon row, enforce its limit and a unique
`(coupon_id, user_id)`, insert the redemption and a ledger grant. A coupon is never a credential.
Managed inference reserves the maximum cost, runs, then settles actual usage; a reservation that
would take the balance negative is refused.

## Administrator MFA (implemented 2026-10-20)

The console requires Better Auth TOTP enrollment and verification on the current browser session.
Migration 0010 adds `users.twoFactorEnabled`, the plugin's `twoFactor` table, and the server-only
`auth_sessions.adminMfaVerified` field, with `ao_auth` grants. Successful TOTP verification records
proof on the session issued by verification (including enrollment's session rotation). Password-only
sessions, including other sessions for an enrolled admin, are redirected to `/mfa` by the same
`requireAdmin` gate used by pages and actions. Normal desktop users do not need MFA.

The real `next start` tests submit rendered form action fields for credits, plan, role, account disable
and coupon create/disable, checking persisted business state and acting-admin audit rows. Non-admin,
password-only admin and wrong-host POSTs leave both unchanged. The full control-plane suite passed
27 tests; accounts-sync passed 96 with one MinIO-dependent skip. Three isolated streaming mutations
were each caught (25 pass / 1 fail); real billing API code passed 26/0. Migration 0010 has only been
verified in scratch databases; these checks do not establish a live deployment or visual browser QA.

# Citations

- [Identity](identity.md), the current Clerk-based sign-in and token types
- [`database/migrations/`](/../database/migrations/)
- [`services/api/src/api/sync.ts`](/../services/api/src/api/sync.ts), [`admin.ts`](/../services/api/src/api/admin.ts)
- [`apps/editors/docx/extension/src/account/account.ts`](/../apps/editors/docx/extension/src/account/account.ts)
- [`apps/desktop/src/vs/workbench/contrib/agenticOffice/browser/account.contribution.ts`](/../apps/desktop/src/vs/workbench/contrib/agenticOffice/browser/account.contribution.ts)
- Better Auth docs: database customisation (`modelName`, `fields`, `generateId`, `additionalFields`) and the OAuth provider plugin (native public client, PKCE, loopback redirects)

- [Admin MFA configuration](/../apps/console/src/lib/auth.ts), [admin gate](/../apps/console/src/lib/session.ts), [migration 0010](/../database/migrations/0010_admin_mfa.sql)
- [Real web and form tests](/../apps/console/test/web.test.ts), [verification record](/../docs/plans/2026-10-20-control-plane.md)
