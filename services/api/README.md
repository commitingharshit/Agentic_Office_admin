# accounts-sync

The account and sync server: users, devices, AES-GCM encrypted device sync and the admin API,
behind Clerk sign-in. The only service with versioned SQL migrations.

- **Toolchain:** Node 24 (TypeScript run directly by type stripping — no build step), npm.
- **Install:** `npm ci`
- **Test:** `npm run test:postgres` starts a disposable local Postgres, runs the real migrations,
  and executes the schema/API tests (requires PostgreSQL with pgvector installed for that major
  version; set `PG_BIN_DIR` if multiple versions are installed). `npm test` uses an existing
  migrated database from `AO_TEST_PG`; tests skip when it is unset. MinIO-backed blob tests are
  optional in either mode (`AO_TEST_MINIO` plus MinIO credentials).
- **Migrate:** `AO_APP_PASSWORD=… AO_READONLY_PASSWORD=… AO_ADMIN_PASSWORD=… npm run migrate [-- --status]`
- **Run:** `node src/api/main.ts` (port 8787), or the `api` service in `deploy/docker-compose.yml`.
- **Marketplace dev server:** `node scripts/marketplace-dev-server.ts [--port 8791] [--bulk 30] [--http]` serves the real marketplace
  API over embedded Postgres, seeded with two real templates and one real skill (seed data only in `scripts/dev-seed/`). It accepts only the
  bearer `dev-token` (user `usr_dev`) and refuses `NODE_ENV=production`; https with a throwaway certificate by default (see the script header).
- **Deploy:** `services/deploy/stack.sh accounts-sync up -d`; host quirks, backups and the restore
  drill in [`deploy/README.md`](deploy/README.md).
- **Data:** Postgres (`db/migrations/*.sql`, RLS roles), MinIO bucket for sync blobs, WAL archive
  + base backups.

Layout: `src/api/` (HTTP: `sync.ts`, `admin.ts`, `s3.ts`), `src/auth/` (`clerk.ts`: the Clerk session verifier — server-side sign-in lives here), `db/` (migrations + runner), `test/`. Identity across the repo: `okf/architecture/identity.md`.

- **Marketplace deployment needs:** `python3` and a mounted `vendor/hermes-agent` (the skill scanner runs `tools/skills_scan_cli.py` as a child process; the stock `node:alpine` image has no python3). `deploy/docker-compose.yml` builds `deploy/Dockerfile.marketplace` (node + python3) and mounts the tree at `/srv/vendor/hermes-agent` (`AO_HERMES_AGENT_DIR`); it also passes `AO_MARKETPLACE_BUCKET`, `AO_MARKETPLACE_ROLES` and `OFFICECLI_BIN`. On start the server runs the scanner on a built-in package; if that fails it logs an error and answers skill uploads with 503 `scanner_unavailable` (browsing keeps working). An unset `OFFICECLI_BIN` logs a warning: templates cannot reach `verified`.
- **Marketplace admin API roles:** `AO_MARKETPLACE_ROLES=adminName:role[,...]` (roles: superadmin, engineer, support, finance, analyst). Without it every admin is read-only (analyst) on `/admin/marketplace/*`.
