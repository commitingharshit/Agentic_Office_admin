#!/usr/bin/env bash
# Ship accounts-sync + control-plane to the test host and run control-plane's tests against a THROWAWAY, fully migrated Postgres
# (own container and network, test-only passwords), never the live database.
#   Usage: remote-control-plane-tests.sh [test-glob]   (default test/*.test.ts).   BUILD=1 builds first (web tests need it); INSTALL=1 reinstalls deps.
# Same host requirements as remote-accounts-sync-tests.sh. Mutation checks: SERVICES_DIR=<a modified copy of services/>.   TAIL=<lines>.
set -euo pipefail
cd "${SERVICES_DIR:-$(git rev-parse --show-toplevel)/services}"
GLOB="${1:-test/*.test.ts}"
# Each checkout tests in its own directory on the host (~/ao-tests/<checkout name>), never in ~/ao-control-plane: that one is what a live deploy
# migrates from, and a test run from another branch must not leave its migrations or code there. node_modules are copied in once.
WT="${AO_TEST_NAME:-$(basename "$(git rev-parse --show-toplevel)")}"
DIR="\$HOME/ao-tests/$WT"
tar --exclude=node_modules --exclude=.next --exclude=.DS_Store --no-xattrs -czf - accounts-sync/db accounts-sync/src accounts-sync/package.json control-plane \
  | ssh -o BatchMode=yes ateam-tanmay-hp "mkdir -p $DIR && cd $DIR && tar xzf - 2>/dev/null; for m in accounts-sync control-plane; do [ -d ~/ao-control-plane/\$m/node_modules ] && [ ! -d $DIR/\$m/node_modules ] && [ -d $DIR/\$m ] && cp -a ~/ao-control-plane/\$m/node_modules $DIR/\$m/ || true; done; find $DIR -name '._*' -delete 2>/dev/null || true"
ssh -o BatchMode=yes ateam-tanmay-hp "bash -s" <<REMOTE | grep -vE '^npm notice' | tail -${TAIL:-60}
set -euo pipefail
cd $DIR
NET=ao-test; docker network inspect \$NET >/dev/null 2>&1 || docker network create \$NET >/dev/null
PGC=ao-test-pg-\$\$
docker run -d --rm --name \$PGC --network \$NET --network-alias postgres -e POSTGRES_USER=ao_owner -e POSTGRES_PASSWORD=owner-test -e POSTGRES_DB=agentic_office pgvector/pgvector:pg17 >/dev/null
trap 'docker stop \$PGC >/dev/null 2>&1 || true' EXIT
for i in \$(seq 1 60); do docker exec \$PGC psql -U ao_owner -d agentic_office -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done; sleep 2
T="postgres://ao_owner:owner-test@postgres:5432/agentic_office"
if [ -n "${INSTALL:-}" ]; then docker run --rm -v "\$PWD/control-plane":/w -w /w node:24.15.0-alpine sh -c 'npm install --no-audit --no-fund 2>&1 | grep -v notice | tail -3'; fi
docker run --rm --network \$NET -v "\$PWD":/w -w /w/accounts-sync -e DATABASE_URL="\$T" -e AO_APP_PASSWORD=app-test -e AO_READONLY_PASSWORD=ro-test -e AO_ADMIN_PASSWORD=admin-test -e AO_AUTH_PASSWORD=auth-test -e AO_BILLING_PASSWORD=billing-test node:24.15.0-alpine node db/migrate.ts >/dev/null
docker run --rm --network \$NET -v "\$PWD":/w -w /w/control-plane -e AUTH_TEST_PG="\$T" -e AO_AUTH_PASSWORD=auth-test -e AO_BILLING_PASSWORD=billing-test -e AO_APP_PASSWORD=app-test -e AO_READONLY_PASSWORD=ro-test -e AO_ADMIN_PASSWORD=admin-test \
  -e AUTH_BASE_URL=http://127.0.0.1:1 -e AUTH_SECRET=test-secret-0123456789abcdef0123456789abcdef -e AUTH_DATABASE_URL="\$T" node:24.15.0-alpine sh -c "${BUILD:+npx next build > /tmp/build.log 2>&1 || (tail -30 /tmp/build.log; exit 1); }node --import tsx --test $GLOB 2>&1"
REMOTE
