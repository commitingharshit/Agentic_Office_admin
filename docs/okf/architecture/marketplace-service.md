---
type: Reference
title: "Marketplace catalog service"
description: "Marketplace catalog, artifact, validation and admin routes inside accounts-sync; planned, no code yet."
toolchain: "Node 24 (TypeScript by type stripping), npm"
build: "cd services/accounts-sync && npm ci"
test: "cd services/accounts-sync && npm test -- marketplace"
run: "part of accounts-sync (node src/api/main.ts, port 8787)"
owns_data: "marketplace_* tables (listings, versions, artifacts, installs, reviews, scans) from migration 0013; artifacts in the MinIO bucket by sha256"
depends_on: []
status: "planned"
tags: [marketplace, accounts, postgres]
timestamp: 2026-10-21T00:00:00Z
---

Planned, not yet in the tree. The marketplace server code will live in a `marketplace` source folder (types,
manifest, store, search, artifacts, per-type validators, scan) with routes in `src/api/marketplace.ts`
and `src/api/marketplace-admin.ts`, inside [accounts-sync](/services/accounts-sync.md). Admin pages
are in the control-plane console. Model, states and reuse: [marketplace architecture](/architecture/marketplace.md).

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`services/accounts-sync/README.md`](/../services/accounts-sync/README.md)
