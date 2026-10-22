#!/usr/bin/env bash
# One way to run each compose stack with the project names production uses (so volume and network names never change).
#   deploy/stack.sh api up -d --build        data plane + API + gate + verifier + prober + media worker   (project ao-live)
#   deploy/stack.sh console up -d --build    admin console + sign-in pages                                (project ao-control-plane-web)
#   deploy/stack.sh keycloak up -d           Keycloak and its public gate                                 (project ao-keycloak)
#   deploy/stack.sh list
# Each stack reads the .env next to its compose file (copy .env.example; mode 600; never committed).
# Start `api` first: the other two join its network (ao-live_default).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-list}" in
  api)      P=ao-live;               D="$ROOT/deploy/compose/api";      EXTRA=() ;;
  console)  P=ao-control-plane-web;  D="$ROOT/deploy/compose/console";  EXTRA=() ;;
  keycloak) P=ao-keycloak;           D="$ROOT/deploy/compose/keycloak"; EXTRA=() ;;
  list|*)   echo "stacks: api (ao-live), console (ao-control-plane-web), keycloak (ao-keycloak)"; exit 0 ;;
esac
shift
[[ -f "$D/.env" ]] || { echo "missing $D/.env (copy .env.example and fill it in)"; exit 2; }
cd "$D"
export DATA_NETWORK="${DATA_NETWORK:-ao-live_default}"
exec docker compose -p "$P" "${EXTRA[@]}" "$@"
