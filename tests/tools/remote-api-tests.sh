#!/usr/bin/env bash
# Ship services/accounts-sync to the test host and run its tests against a THROWAWAY Postgres (own container, own network, test-only
# passwords), never the live database.   Usage: remote-accounts-sync-tests.sh [test-file-glob]   (default: every test)
# Needs ssh to the host alias `ateam-tanmay-hp` (Tailscale SSH: approve the link once) and docker there; the pgvector and node images are
# pulled on first use. Mutation checks: SERVICES_DIR=<a modified copy of services/>.   TAIL=<lines of output to keep>.
set -euo pipefail
cd "${SERVICES_DIR:-$(git rev-parse --show-toplevel)/services}"
GLOB="${1:-test/*.test.ts}"
tar --exclude=node_modules --exclude=.DS_Store --no-xattrs -czf - accounts-sync/db accounts-sync/test accounts-sync/src accounts-sync/package.json \
  | ssh -o BatchMode=yes ateam-tanmay-hp 'mkdir -p ~/ao-control-plane && cd ~/ao-control-plane && tar xzf - 2>/dev/null'
ssh -o BatchMode=yes ateam-tanmay-hp "bash -s" <<REMOTE | grep -vE '^npm notice' | tail -${TAIL:-60}
set -euo pipefail
cd ~/ao-control-plane
NET=ao-test; docker network inspect \$NET >/dev/null 2>&1 || docker network create \$NET >/dev/null
PGC=ao-test-pg-\$\$
docker run -d --rm --name \$PGC --network \$NET --network-alias postgres -e POSTGRES_USER=ao_owner -e POSTGRES_PASSWORD=owner-test -e POSTGRES_DB=agentic_office pgvector/pgvector:pg17 >/dev/null
trap 'docker stop \$PGC >/dev/null 2>&1 || true' EXIT
for i in \$(seq 1 60); do docker exec \$PGC psql -U ao_owner -d agentic_office -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done; sleep 2
T="postgres://ao_owner:owner-test@postgres:5432/agentic_office"
docker run --rm --network \$NET -v "\$PWD":/w -w /w/accounts-sync -e DATABASE_URL="\$T" -e AO_TEST_PG="\$T" \
  -e AO_APP_PASSWORD=app-test -e AO_READONLY_PASSWORD=ro-test -e AO_ADMIN_PASSWORD=admin-test -e AO_AUTH_PASSWORD=auth-test -e AO_BILLING_PASSWORD=billing-test \
  node:24.15.0-alpine sh -c "node db/migrate.ts >/dev/null && node --test $GLOB 2>&1"
REMOTE
