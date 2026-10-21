# Keycloak

The identity service for Agentic Office: sign-in for the desktop app and the admin console, Google and other providers, SSO.

- `realm/agentic-office-realm.json`: the realm (clients, roles, password and brute-force policy, Google provider, login events), imported on first start. Secrets in it are `${NAME}` placeholders filled from the environment.
- `deploy/docker-compose.yml` and `.env.example`: its own compose project (`ao-keycloak`) with a database in the shared Postgres. Copy `.env.example` to `.env` (mode 600) and fill it in; never commit real values.
- Check it: `KC=… KC_API_SECRET=… node scripts/dev/keycloak-check.mjs` (a real browser and a throwaway person).

The sign-in endpoints are public in production. Keycloak's own administration (the master realm and its admin console) is never public; reach it only over Tailscale. Knowledge and status: `okf/services/keycloak.md`, `docs/plans/2026-10-21-keycloak.md`.
