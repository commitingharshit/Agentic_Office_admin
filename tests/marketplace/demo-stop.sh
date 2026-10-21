#!/usr/bin/env bash
# Stops ONLY what scripts/dev/marketplace-demo.sh started (the pids it recorded, plus any process whose command line carries its own
# user-data-dir). Never touches your own Agentic Office window or any other process.
set -uo pipefail
BASE="$(cd /tmp && pwd -P)/ao-mkt-demo"
[ -f "$BASE/pids" ] || { echo "nothing recorded in $BASE/pids: no demo to stop"; exit 0; }
alive() { kill -0 "$1" 2>/dev/null; }
# the window first (electron has many child processes; they are found by this demo's private user-data-dir)
pkill -f "$BASE/ud/user" 2>/dev/null || true
while read -r kind pid; do
  [ -n "${pid:-}" ] || continue
  alive "$pid" && kill "$pid" 2>/dev/null && echo "stopped $kind ($pid)"
done < "$BASE/pids"
for _ in $(seq 1 40); do
  left=0
  pgrep -f "$BASE/ud/user" >/dev/null 2>&1 && left=1
  while read -r kind pid; do [ -n "${pid:-}" ] && alive "$pid" && left=1; done < "$BASE/pids"
  [ "$left" = 0 ] && break
  sleep 0.5
done
# anything still alive after 20 s gets SIGKILL (same targets only)
pkill -KILL -f "$BASE/ud/user" 2>/dev/null || true
while read -r kind pid; do [ -n "${pid:-}" ] && alive "$pid" && kill -KILL "$pid" 2>/dev/null; done < "$BASE/pids"
# wait until the demo ports are free (the embedded Postgres exits with the server)
for _ in $(seq 1 40); do lsof -nP -iTCP:8793 -iTCP:9443 -iTCP:9444 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
# the embedded Postgres belongs to the dev server's data directory under /tmp; it exits with the server (its postmaster is told to stop)
sleep 1
rm -f "$BASE/pids"
echo "marketplace demo stopped (logs kept in $BASE/logs)"
