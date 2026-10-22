---
type: Service
title: "Control plane (sign-in and admin console)"
description: "Better Auth as the OAuth 2.1 provider the desktop signs in through, plus the private admin console for users, plans, credits and coupons."
resource: apps/console/
toolchain: "Node 24, npm, Next.js 16 (App Router), Better Auth"
build: "cd apps/console && npm ci && npm run build"
test: "cd apps/console && npm test (AUTH_TEST_PG, AO_AUTH_PASSWORD and the other role passwords; web.test.ts needs a build; skips without AUTH_TEST_PG)"
run: "npm start (port 8791), or apps/console/deploy/docker-compose.yml beside the accounts-sync stack"
owns_data: "nothing of its own: its sign-in tables (auth_*, oauth*, jwks) live in the accounts-sync database and migrations"
depends_on: [services/api]
status: "active"
tags: [auth, oauth, admin, better-auth, nextjs]
timestamp: 2026-10-20T00:00:00Z
---

Sign-in and the admin console, as one Next.js service. It is the OAuth 2.1 / OIDC provider the desktop app signs in through (authorization code + PKCE, loopback redirect) and the private web console.

Code is `src/lib/auth.ts` (configuration and the mapping onto `users` and the `auth_*` tables), `src/app/sign-in`, and `src/app/admin` (overview, users, coupons, audit; actions go through accounts-sync's admin API naming the signed-in admin). It runs as the least-privilege `ao_auth` database role.

The design, schema mapping and API contract: [Control plane](/architecture/control-plane.md). Token types: [identity](/architecture/identity.md).

README: [`apps/console/README.md`](/../apps/console/README.md)

# Citations

- [`apps/console/README.md`](/../apps/console/README.md)
- [`database/migrations/0009_auth_service.sql`](/../database/migrations/0009_auth_service.sql)

With `KEYCLOAK_ISSUER` set the console signs admins in through Keycloak instead of its own sign-in (`src/lib/keycloak.ts`, `/admin/login`, `/admin/callback`, `/admin/logout`; code + PKCE, signed cookies, every request re-asks the admin API who the person is). See [Keycloak](/services/keycloak.md).
