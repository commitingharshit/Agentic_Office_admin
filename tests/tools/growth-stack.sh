#!/usr/bin/env bash
# The growth stack on THIS machine (Docker Desktop), for building and testing promotions: Postgres, MinIO, the API, the ffmpeg media worker,
# the migrations and a dev seed. Throwaway test passwords live in $AO_GROWTH_DIR/env (mode 600), never in the repo; nothing leaves this machine.
#   tests/tools/growth-stack.sh up      start, migrate and seed; prints the API address and the dev tokens
#   tests/tools/growth-stack.sh smoke   check the seeded promotions through the real HTTP API (all three placements, ad-free, opt-out)
#   tests/tools/growth-stack.sh reset   forget what the seed people were shown, so promotions appear for them again
#   tests/tools/growth-stack.sh down    stop it and delete its data (only this project, only local Docker)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/deploy/compose/api"
DIR=${AO_GROWTH_DIR:-/tmp/ao-growth}; ENVF=$DIR/env; PROJ=aogrowthstack
API_PORT=${AO_GROWTH_API_PORT:-18787}
dc() { docker compose -p "$PROJ" --env-file "$ENVF" -f docker-compose.yml -f docker-compose.growth.yml --profile growth "$@"; }
case "$(docker context show)" in desktop-linux|default|orbstack|colima) ;; *) echo "refusing: docker context '$(docker context show)' is not a local one" >&2; exit 1;; esac
rnd() { openssl rand -hex 12; }
case "${1:-}" in
  up)
    mkdir -p "$DIR"; chmod 700 "$DIR"
    if [ ! -f "$ENVF" ]; then
      ( umask 077; cat > "$ENVF" <<ENV
BIND_IP=127.0.0.1
PG_PORT=${AO_GROWTH_PG_PORT:-57432}
MINIO_PORT=${AO_GROWTH_MINIO_PORT:-59100}
MINIO_CONSOLE_PORT=${AO_GROWTH_MINIO_CONSOLE_PORT:-59101}
API_PORT=$API_PORT
PG_OWNER_PASSWORD=$(rnd)
AO_APP_PASSWORD=$(rnd)
AO_READONLY_PASSWORD=$(rnd)
AO_ADMIN_PASSWORD=$(rnd)
AO_AUTH_PASSWORD=$(rnd)
AO_BILLING_PASSWORD=$(rnd)
MINIO_ROOT_USER=aogrowth
MINIO_ROOT_PASSWORD=$(rnd)$(rnd)
AO_ADMIN_TOKENS=console:$(rnd)$(rnd)
AO_MEDIA_SIGNING_KEY=$(rnd)$(rnd)
# The sync API only starts when some sign-in is configured. This one points nowhere on purpose: the local stack signs people in with the dev tokens
# the seed creates, and a real sign-in attempt just fails.
AUTH_ISSUER=http://127.0.0.1:1
PGADMIN_EMAIL=dev@example.test
PGADMIN_PASSWORD=$(rnd)
ENV
      )
    fi
    dc up -d postgres minio minio-init
    # Postgres restarts once while it initialises, so the first connection can be refused: try again a few times.
    for i in 1 2 3 4 5 6; do dc run --rm migrate >/dev/null 2>&1 && break; [ "$i" = 6 ] && { dc run --rm migrate; exit 1; }; sleep 4; done
    dc run --rm growth-seed
    dc up -d api media-worker
    echo "API: http://127.0.0.1:$API_PORT   (dev tokens: aod_seed_free_dev_token, aod_seed_adfree_dev_token, aod_seed_optout_dev_token)"
    ;;
  smoke)
    node "$(git rev-parse --show-toplevel)/tests/tools/growth-smoke.mjs" "http://127.0.0.1:$API_PORT"
    ;;
  reset)
    # Forget what the seed people were shown or dismissed, so a promotion can be shown to them again (local data only).
    dc exec -T postgres psql -U ao_owner -d agentic_office -v ON_ERROR_STOP=1 -c "DELETE FROM promo_exposure WHERE user_id LIKE 'usr_seed_%'; DELETE FROM promo_events WHERE user_id LIKE 'usr_seed_%' OR event_id LIKE 'smoke%'; UPDATE user_promo_prefs SET in_app = (user_id <> 'usr_seed_optout') WHERE user_id LIKE 'usr_seed_%';"
    ;;
  down)
    dc down -v --remove-orphans
    ;;
  *) echo "usage: $0 up|smoke|reset|down" >&2; exit 2;;
esac
