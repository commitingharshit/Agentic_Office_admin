---
type: Service
title: "Accounts and sync server"
description: "Users, devices, encrypted device sync and the admin API behind Clerk sign-in; the only service with versioned SQL migrations."
resource: services/accounts-sync/
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test (AO_TEST_PG and AO_TEST_MINIO point it at a local stack; otherwise most tests skip)"
run: "node src/api/main.ts (port 8787), or services/deploy/stack.sh accounts-sync up -d"
owns_data: "Postgres (db/migrations/*.sql, RLS roles), a MinIO bucket for sync blobs, WAL archive and base backups"
depends_on: []
status: "active"
tags: [accounts, sync, postgres]
timestamp: 2026-10-17T00:00:00Z
---

Users, devices, encrypted device sync and the admin API behind Clerk sign-in; the only service with versioned SQL migrations.

Code is `src/api/` (sync, admin, S3) and `src/auth/` (the Clerk session verifier). Every user table and token: [identity](/architecture/identity.md).

README: [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)

# Citations

- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
- [`services/accounts-sync/deploy/README.md`](/../services/accounts-sync/deploy/README.md)
