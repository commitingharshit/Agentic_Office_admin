#!/usr/bin/env bash
# One-command local run of the Extension Marketplace (DEV ONLY, macOS).
#
#   tests/marketplace/demo.sh [--no-window] [--server-port 8793] [--cdp-port 9361] [--no-advanced] [--admin]
#
# Starts, all on loopback and all under /tmp/ao-mkt-demo (never your real profile or your running Agentic Office window):
#   1. fake HTTPS servers for the bridge and connector examples (ONLY because this script sets AGENTICOFFICE_DEV_MODE=1);
#   2. the dev marketplace server (services/api/scripts/marketplace-dev-server.ts: embedded Postgres, seeded real packages:
#      2 templates, 2 skills, and one example of each operational advanced type, each through the real validator of its type);
#   3. unless --no-window: a SEPARATE Agentic Office window (own user-data-dir, CDP port 9361, throwaway HERMES_HOME) pointed at it.
# Everything it starts is recorded in /tmp/ao-mkt-demo/pids; tests/marketplace/demo-stop.sh kills only those.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$(cd /tmp && pwd -P)/ao-mkt-demo"
SERVER_PORT=8793; CDP_PORT=9361; BRIDGE_PORT=9443; API_PORT=9444
WINDOW=1; ADVANCED=1; ADMIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-window) WINDOW=0 ;;
    --no-advanced) ADVANCED=0 ;;
    --admin) ADMIN=1 ;;
    --server-port) SERVER_PORT="$2"; shift ;;
    --cdp-port) CDP_PORT="$2"; shift ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
[ "$CDP_PORT" != "9351" ] || { echo "port 9351 is your own window; refusing" >&2; exit 2; }
[ "$(uname)" = "Darwin" ] || echo "note: only tested on macOS" >&2

die() { echo "marketplace-demo: $*" >&2; exit 1; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

command -v node >/dev/null || die "node is required (Node 24, see apps/desktop/.nvmrc)"
command -v openssl >/dev/null || die "openssl is required"
[ -d "$REPO/services/api/node_modules" ] || die "run 'npm ci' in services/api first"
PY="${AO_E2E_PYTHON:-}"
[ -n "$PY" ] || for c in "$REPO/vendor/hermes-agent/venv/bin/python" "/Users/$USER/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python"; do [ -x "$c" ] && PY="$c" && break; done
[ -x "$PY" ] || die "no Hermes python: set AO_E2E_PYTHON to the python of vendor/hermes-agent's venv"
for p in "$SERVER_PORT" "$BRIDGE_PORT" "$API_PORT"; do port_busy "$p" && die "port $p is already in use (stop what uses it, or pass --server-port)"; done
if [ "$WINDOW" = 1 ]; then
  port_busy "$CDP_PORT" && die "CDP port $CDP_PORT is already in use; this script never takes over a running window"
  APP="$REPO/apps/desktop/.build/electron/Agentic Office.app/Contents/MacOS/AgenticOffice"
  [ -x "$APP" ] || die "no fork build at $APP (use --no-window, or build the fork: see BUILD_MACOS.md)"
  [ -d "$REPO/apps/desktop/out" ] || die "apps/desktop/out is missing: run 'npm run transpile-client' in apps/desktop (or use --no-window)"
fi
if [ -e "$BASE/pids" ]; then die "a previous demo is recorded in $BASE/pids: run tests/marketplace/demo-stop.sh first"; fi

rm -rf "$BASE"; mkdir -p "$BASE"/{bin,ws,mkt,hermes-root,hermes-home,ud,logs}
: > "$BASE/pids"
record() { echo "$1 $2" >> "$BASE/pids"; }   # kind pid

# Hermes of THIS checkout, in a throwaway home (never ~/.hermes)
cat > "$BASE/bin/hermes" <<EOS
#!/usr/bin/env bash
unset PYTHONPATH PYTHONHOME
exec "$PY" "$REPO/vendor/hermes-agent/hermes" "\$@"
EOS
chmod +x "$BASE/bin/hermes"

DEV_ENV=(AGENTICOFFICE_DEV_MODE=1)
BRIDGE_ARGS=(); 
if [ "$ADVANCED" = 1 ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$BASE/fake-k.pem" -out "$BASE/fake-c.pem" -days 2 -subj /CN=localhost \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
  FAKE_MCP_TOKEN=demo-token FAKE_MCP_LOG="$BASE/logs/fake-mcp-calls.jsonl" nohup "$PY" "$REPO/scripts/e2e/plan/marketplace_fake_mcp.py" \
    --port "$BRIDGE_PORT" --cert "$BASE/fake-c.pem" --key "$BASE/fake-k.pem" > "$BASE/logs/fake-mcp.log" 2>&1 &
  record fake-mcp $!
  FAKE_API_KEY=demo-key FAKE_API_LOG="$BASE/logs/fake-api-calls.jsonl" nohup "$PY" "$REPO/scripts/e2e/plan/marketplace_fake_connector_api.py" \
    --port "$API_PORT" --cert "$BASE/fake-c.pem" --key "$BASE/fake-k.pem" > "$BASE/logs/fake-api.log" 2>&1 &
  record fake-api $!
  BRIDGE_ARGS=(--advanced --bridge-url "https://127.0.0.1:$BRIDGE_PORT/mcp" --connector-url "https://127.0.0.1:$API_PORT/mcp")
fi

echo "starting the dev marketplace server on 127.0.0.1:$SERVER_PORT (embedded Postgres + validators: 30-120 s)..."
ADMIN_ARGS=(); [ "$ADMIN" = 1 ] && ADMIN_ARGS=(--admin)
( cd "$REPO/services/api" && exec env "${DEV_ENV[@]}" NODE_ENV=development OFFICECLI_TIMEOUT_MS=150000 DAG_RUNTIME_PYTHON="$PY" \
  node scripts/marketplace-dev-server.ts --port "$SERVER_PORT" --state "$BASE/server.json" ${BRIDGE_ARGS[@]+"${BRIDGE_ARGS[@]}"} ${ADMIN_ARGS[@]+"${ADMIN_ARGS[@]}"} \
  ) > "$BASE/logs/server.log" 2>&1 &
echo $! > "$BASE/server.pid"   # the subshell execs into node, so this is node's pid
record server "$(cat "$BASE/server.pid")"
for _ in $(seq 1 360); do
  [ -f "$BASE/server.json" ] && break
  kill -0 "$(cat "$BASE/server.pid")" 2>/dev/null || { tail -20 "$BASE/logs/server.log" >&2; die "the dev server exited; log: $BASE/logs/server.log"; }
  sleep 1
done
[ -f "$BASE/server.json" ] || die "the dev server did not come up in 6 minutes; log: $BASE/logs/server.log"
URL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).url)' "$BASE/server.json")"
CA="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ca||"")' "$BASE/server.json")"
[ -z "$CA" ] || cp "$CA" "$BASE/dev-ca.pem"

if [ "$WINDOW" = 1 ]; then
  mkdir -p "$BASE/ud/user/User"
  cat > "$BASE/ud/user/User/settings.json" <<EOS
{ "agentic-office.maintainer.notifications": false, "security.workspace.trust.enabled": false, "workbench.tips.enabled": false,
  "agenticOffice.account.requireSetup": false, "window.dialogStyle": "custom", "window.titleBarStyle": "custom",
  "agenticOffice.marketplace.url": "$URL" }
EOS
  # NODE_TLS_REJECT_UNAUTHORIZED=0 is DEV ONLY: the dev server's certificate is self-signed and the install service runs in the main process
  ( cd "$REPO/apps/desktop" && exec env AGENTICOFFICE_WORKSPACE_ROOT="$REPO" NODE_ENV=development VSCODE_DEV=1 VSCODE_CLI=1 VSCODE_SKIP_PRELAUNCH=1 \
      AGENTICOFFICE_DEV_MODE=1 AGENTICOFFICE_MARKETPLACE_CA_FILE="$BASE/dev-ca.pem" AGENTICOFFICE_MARKETPLACE_DEV_TOKEN=dev-token \
      AGENTICOFFICE_MARKETPLACE_HOME="$BASE/mkt" AGENTICOFFICE_HERMES_BIN="$BASE/bin/hermes" AGENTICOFFICE_HERMES_HOME="$BASE/hermes-root" \
      HERMES_HOME="$BASE/hermes-home" SSL_CERT_FILE="$BASE/fake-c.pem" \
      NODE_TLS_REJECT_UNAUTHORIZED=0 \
      "$APP" . "$BASE/ws" --user-data-dir="$BASE/ud/user" --extensions-dir="$BASE/ud/ext" --disable-extension=vscode.vscode-api-tests \
      --remote-debugging-port="$CDP_PORT" --no-sandbox --ignore-certificate-errors ) > "$BASE/logs/window.log" 2>&1 &
  echo $! > "$BASE/window.pid"
  record window "$(cat "$BASE/window.pid")"
  for _ in $(seq 1 120); do curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break; sleep 1; done
  curl -s "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || echo "warning: the window has not opened its debug port yet (see $BASE/logs/window.log)" >&2
fi

SEEDED="$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).advancedSeeded||[]).join(", ")||"none")' "$BASE/server.json")"
cat <<EOM

Marketplace demo is running.
  server        $URL   (dev bearer token: dev-token = user usr_dev, device dev-device)
  advanced seeds $SEEDED
  fake bridge   https://127.0.0.1:$BRIDGE_PORT/mcp   (token demo-token; calls logged to $BASE/logs/fake-mcp-calls.jsonl)
  fake API      https://127.0.0.1:$API_PORT/mcp      (API key demo-key; workspace name: anything like "acme")
  logs, state   $BASE
$( [ "$WINDOW" = 1 ] && echo "  window        separate Agentic Office window, CDP http://127.0.0.1:$CDP_PORT, profile $BASE/ud (your own window is untouched)" )
Next steps
  - In the window: activity bar -> Marketplace -> Discover. Install a template or a skill; look at Installed.
  - Advanced types (routine, memory, hook, bridge, connector, workflow) show in Discover; installing one asks for a native confirmation.
    Configure / Grant screens for them are a separate UI step; see docs/guides/marketplace-getting-started.md for what works today.
  - API:  curl -s -H 'authorization: Bearer dev-token' $URL/v1/marketplace/listings | head -c 600     (https: add -k)
  - Stop everything this script started:  tests/marketplace/demo-stop.sh
EOM
