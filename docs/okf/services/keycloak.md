---
type: Service
title: "Keycloak (identity service)"
description: "Keycloak 26 as the identity service for the desktop app, the admin console and Google/SSO sign-in; its realm is configuration in the repo."
resource: services/keycloak/
toolchain: "Keycloak 26.4 container, realm imported from JSON"
build: "none (image quay.io/keycloak/keycloak:26.4.0)"
test: "node tests/tools/keycloak-check.mjs against a running Keycloak (open a tunnel to the host, set KC and KC_API_SECRET): sign-in with PKCE to a loopback address, ID token claims, service-account reads"
run: "cd services/keycloak/deploy && docker compose up -d (own compose project ao-keycloak, own database in the shared Postgres; needs .env from .env.example)"
owns_data: "its own database `keycloak` (users, credentials, sessions, login events) in the shared Postgres"
depends_on: [services/api]
status: "active"
tags: [auth, oauth, keycloak, sso]
timestamp: 2026-10-21T00:00:00Z
---

Keycloak is where people sign in. The realm `agentic-office` (services/keycloak/realm/agentic-office-realm.json) defines: the public client `agentic-office-desktop` (authorization code + PKCE S256, loopback redirect `http://127.0.0.1/*`, no password grant), the confidential client `ao-admin-console` for the admin console's login, the service-account client `ao-api` that lets the API read users, sessions and login events (view-users, manage-users, view-events, view-realm; refused on the master realm), a Google identity provider with `trustEmail`, brute-force protection, a 10-character password policy, and the roles `ao-admin`, `ao-superadmin`, `ao-engineer`, `ao-support`, `ao-finance`, `ao-analyst`.

The API (accounts-sync) accepts Keycloak's ID token at `POST /v1/auth/exchange` when `KEYCLOAK_ISSUER` is set, and maps it to the existing person: by the stored Keycloak identity, else by one VERIFIED email (linked once, keeping the id and data), else a new account. An unverified email never joins an existing account. Details: [accounts-sync](/services/api.md), [identity](/architecture/identity.md).

Keycloak's sign-in endpoints (`/realms/agentic-office/*`) are public in production, because the app's users reach them from the internet. Keycloak's own administration (the master realm and its admin console) is never public: reachable only over the tailnet. Plan and status: `docs/plans/2026-10-21-keycloak.md`.
