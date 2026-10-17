#!/usr/bin/env bash
# Run one server-side stack with its own compose file and project name (what production uses).
#
#   services/deploy/stack.sh <stack> <docker compose args…>
#   services/deploy/stack.sh accounts-sync up -d
#   services/deploy/stack.sh collab logs -f collab
#   services/deploy/stack.sh list
#
# Stacks: accounts-sync, collab, research-search, observability. For a local copy of all of
# them at once, see compose.yaml next to this script.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
services="$(dirname "$here")"
stack="${1:-list}"; shift || true
case "$stack" in
	accounts-sync)   file="$services/accounts-sync/deploy/docker-compose.yml" ;;
	collab)          file="$services/collab/deploy/docker-compose.yml" ;;
	research-search) file="$services/research/searxng/docker-compose.yml" ;;
	observability)   file="$services/dag-runtime/deploy/observability/docker-compose.yml" ;;
	list) echo "accounts-sync collab research-search observability"; exit 0 ;;
	*) echo "unknown stack: $stack (try: list)" >&2; exit 2 ;;
esac
# --project-directory stays the stack's own folder, so the project name (and so every volume
# name) is what it was when the stack was deployed from there.
exec docker compose -f "$file" --project-directory "$(dirname "$file")" "$@"
