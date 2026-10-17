# accounts-sync

The account and sync server: users, devices, AES-GCM encrypted device sync and the admin API,
behind Clerk sign-in. The only service with versioned SQL migrations.

- **Toolchain:** Node 24 (TypeScript run directly by type stripping — no build step), npm.
- **Install:** `npm ci`
- **Test:** `npm test` — needs the local stack (Postgres + MinIO) from `deploy/`.
- **Migrate:** `AO_APP_PASSWORD=… AO_READONLY_PASSWORD=… AO_ADMIN_PASSWORD=… npm run migrate [-- --status]`
- **Run:** `node api/main.ts` (port 8787), or the `api` service in `deploy/docker-compose.yml`.
- **Deploy:** `services/deploy/stack.sh accounts-sync up -d`; host quirks, backups and the restore
  drill in [`deploy/README.md`](deploy/README.md).
- **Data:** Postgres (`db/migrations/*.sql`, RLS roles), MinIO bucket for sync blobs, WAL archive
  + base backups.

Layout: `api/` (HTTP: `sync.ts`, `admin.ts`, `clerk.ts`), `db/` (migrations + runner), `test/`.
