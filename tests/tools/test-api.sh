#!/usr/bin/env bash
# Runs the API tests (including the ones that need a real Postgres) against a throwaway pgvector container: nothing persists, nothing is shared.
# Usage: tests/tools/test-api.sh [test files...]   (default: all of services/api/test/*.test.ts)
# Needs Docker and Node 24. Passwords are test-only values.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="ao-test-pg-$$"
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:5432" -e POSTGRES_USER=ao_owner -e POSTGRES_PASSWORD=owner-test -e POSTGRES_DB=agentic_office pgvector/pgvector:pg17 >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do docker exec "$NAME" psql -U ao_owner -d agentic_office -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done; sleep 2
export AO_TEST_PG="postgres://ao_owner:owner-test@127.0.0.1:$PORT/agentic_office" DATABASE_URL="postgres://ao_owner:owner-test@127.0.0.1:$PORT/agentic_office"
export AO_APP_PASSWORD=app-test AO_READONLY_PASSWORD=ro-test AO_ADMIN_PASSWORD=admin-test AO_AUTH_PASSWORD=auth-test AO_BILLING_PASSWORD=billing-test
cd "$ROOT/database" && npm ci --no-audit --no-fund >/dev/null && node migrate.ts
cd "$ROOT/services/api" && npm ci --no-audit --no-fund >/dev/null
if [ "$#" -gt 0 ]; then node --test "$@"; else node --test test/*.test.ts; fi
