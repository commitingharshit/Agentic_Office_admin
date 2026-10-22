# control-plane

Sign-in and the admin console for Agentic Office, as one Next.js service. It is the OAuth 2.1 / OIDC provider the
desktop app signs in through (Better Auth), and the private web console for users, plans, credits, coupons and the audit log.
It shares accounts-sync's Postgres and calls accounts-sync's admin API; it owns no business data of its own.

- **Toolchain:** Node 24, npm, Next.js 16 (App Router), Better Auth 1.7.
- **Install / build:** `npm ci && npm run build` (`npm run typecheck`).
- **Test:** `npm test` (`node --import tsx --test test/*.test.ts`) against a database migrated by
  `database/migrate.ts`: set `AUTH_TEST_PG` (owner URL), `AO_AUTH_PASSWORD`, `AO_APP_PASSWORD`,
  `AO_READONLY_PASSWORD`, `AO_ADMIN_PASSWORD`. `test/web.test.ts` needs `npm run build` first. Tests skip when `AUTH_TEST_PG` is unset.
- **Run:** `npm start` (port 8791), or `deploy/docker-compose.yml` (see its header; needs the data stack's network).

Configuration (environment): `AUTH_BASE_URL` (the public https address; it is the OAuth issuer), `AUTH_SECRET`,
`AUTH_DATABASE_URL` (as the `ao_auth` role), `AO_ADMIN_API_URL` + `AO_ADMIN_API_TOKEN`, `ADMIN_HOSTS`, `AUTH_IP_HEADER`,
optional `GOOGLE_CLIENT_ID/SECRET` and `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID`.

Things that are easy to get wrong:

- **The issuer must be https** (RFC 8414; the provider forces it for any host but loopback). Serve the service behind TLS
  (a tunnel, or `tailscale serve`) and set `AUTH_BASE_URL` to that address, and accounts-sync's `AUTH_ISSUER` to the same.
- **The admin console exists only on the hostnames in `ADMIN_HOSTS`.** Any other `Host` gets a 404, even for an admin. Fail closed: unset means loopback only. **Always include `localhost`**: after a form action the server fetches the redirect target through it, so without it every successful action ends on a 404 (found in a real browser; the test server binds 127.0.0.1 and could not show it). A refusal is logged as `[admin] refused host …`.
- **The server's clock must be right.** Authenticator codes are valid for 30 seconds; a host that is a minute slow rejects every correct code. Check `timedatectl show -p NTPSynchronized`.
- **Admins must verify TOTP on their current browser session.** Migration 0010 adds Better Auth’s two-factor tables/fields and the server-only session proof. `/mfa` enrolls and verifies; `/admin` pages and actions stay gated until verification. Ordinary desktop users are not required to enroll. Enrollment alone and proof in another session do not grant console access.
- **`AUTH_IP_HEADER`** is the header the public tunnel sets with the real client address (`cf-connecting-ip`); rate limits key on it. Never name a header the open internet can write.
- **Better Auth's authorize endpoint answers a navigation with a redirect and an API client with JSON.** Tests that follow it use a raw request with `sec-fetch-mode: navigate`; `fetch` overwrites that header.
- **The service runs as `ao_auth`** (migration 0009): sign-in rows and people, nothing else. It cannot delete a user or change a role or status.

Layout: `src/lib/auth.ts` (the Better Auth configuration and its mapping onto accounts-sync's tables), `src/lib/session.ts` (admin gate),
`src/lib/admin-api.ts` (the one door to the data), `src/app/` (sign-in pages, `admin/` console and its server actions), `test/`.
The design, the table mapping and the API contract: `okf/architecture/control-plane.md`.

**Marketplace console, end to end (not in CI):** `node tests/e2e/marketplace-admin/run.mjs [--out <dir>]` starts a throwaway docker `pgvector/pgvector:pg17` (migrations 0001-latest, all five role passwords), the real accounts-sync admin handlers, this console (`next start`, needs a real `node_modules`) and a private headless Chrome, drives review, acknowledgement, halt, type policy, verification and analyst flows with real clicks, screenshots each step and checks `admin_audit`; it tears everything down on exit.
