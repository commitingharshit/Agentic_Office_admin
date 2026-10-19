#!/usr/bin/env bash
# Run the real migrations and API/RLS tests against an isolated, disposable local Postgres.
# Requires PostgreSQL with pgvector installed for the same major version; MinIO tests remain
# optional (set AO_TEST_MINIO and its credentials to exercise those too).
set -euo pipefail

if [[ -n "${PG_BIN_DIR:-}" ]]; then
  pg_bin_dir="$PG_BIN_DIR"
else
  initdb_path="$(command -v initdb || true)"
  if [[ -z "$initdb_path" ]]; then
    echo "PostgreSQL initdb is not on PATH (set PG_BIN_DIR to its bin directory)" >&2
    exit 2
  fi
  pg_bin_dir="$(dirname "$initdb_path")"
fi
for binary in initdb pg_ctl pg_config createdb; do
  if [[ ! -x "$pg_bin_dir/$binary" ]]; then
    echo "Missing $pg_bin_dir/$binary (set PG_BIN_DIR to a PostgreSQL bin directory)" >&2
    exit 2
  fi
done
pg_sharedir="$("$pg_bin_dir/pg_config" --sharedir)"
if [[ ! -f "$pg_sharedir/extension/vector.control" ]]; then
  echo "pgvector is missing for this PostgreSQL installation: $pg_sharedir" >&2
  exit 2
fi

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/ao-accounts-sync-test.XXXXXX")"
cleanup() {
  "$pg_bin_dir/pg_ctl" -D "$test_dir/data" -m immediate stop >/dev/null 2>&1 || true
  if [[ "$test_dir" == *ao-accounts-sync-test.* ]]; then
    rm -rf -- "$test_dir"
  fi
}
trap cleanup EXIT

test_port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
"$pg_bin_dir/initdb" -D "$test_dir/data" -U ao_owner --auth-local=trust --auth-host=trust --no-instructions >"$test_dir/init.log"
"$pg_bin_dir/pg_ctl" -D "$test_dir/data" -l "$test_dir/postgres.log" \
  -o "-h 127.0.0.1 -p $test_port -k $test_dir" start >/dev/null
"$pg_bin_dir/createdb" -h 127.0.0.1 -p "$test_port" -U ao_owner agentic_office

export AO_TEST_PG="postgres://ao_owner@127.0.0.1:$test_port/agentic_office"
export DATABASE_URL="$AO_TEST_PG"
export AO_APP_PASSWORD="${AO_APP_PASSWORD:-ao-app-local-test}"
export AO_READONLY_PASSWORD="${AO_READONLY_PASSWORD:-ao-readonly-local-test}"
export AO_ADMIN_PASSWORD="${AO_ADMIN_PASSWORD:-ao-admin-local-test}"

cd "$(dirname "$0")/.."
node db/migrate.ts
npm test
