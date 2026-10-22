#!/usr/bin/env bash
# Deploy the platform from this repo to the server host. Run by a person, from the repo root:  deploy/scripts/deploy.sh
#   AO_HOST   ssh alias of the host            (default ateam-tanmay-hp)
#   AO_HOME   folder on the host, under $HOME  (default ao-platform)
#   AO_MONOREPO  checkout of the desktop monorepo, only to pin Hermes for the verifier image (skip it to keep the verifier image the host already has)
# Order: refuse a dirty tree -> database dump -> ship the committed code -> env files (copied once from the old layout, never overwritten) ->
#        verifier image -> migrate -> build images -> gate first, then API, then the rest -> console -> checks.
# Nothing here sets payment credentials or a help-assistant key; payments stay OFF and the help assistant stays off until keys are set
# (deploy/scripts/set-help-keys.sh, enable-payments-youpi.sh).
# Rollback: the old tree (~/ao-control-plane) is left untouched. To go back:  cd ~/ao-control-plane/accounts-sync/deploy && docker compose -p ao-live up -d
#           (and the same in control-plane/deploy and keycloak/deploy); restore the dump printed in step 1 only if a migration must be undone.
set -euo pipefail
HOST=${AO_HOST:-ateam-tanmay-hp}; AO_HOME=${AO_HOME:-ao-platform}
[[ "$AO_HOME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "AO_HOME may only contain letters, digits and . _ -" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain --untracked-files=no)" && -z "${ALLOW_DIRTY:-}" ]]; then echo "uncommitted changes: commit first (the host gets exactly what is committed), or ALLOW_DIRTY=1" >&2; exit 1; fi
COMMIT=$(git rev-parse --short HEAD); echo "deploying $COMMIT to $HOST:~/$AO_HOME"
ssh_() { ssh -o BatchMode=yes "$HOST" "$@"; }

echo "1/8 dump the live database"
DUMP=$(ssh_ 'mkdir -p ~/ao-backups-manual; f=~/ao-backups-manual/pre-platform-$(date -u +%Y%m%dT%H%M%SZ).dump; docker exec ao-live-postgres-1 sh -c "pg_dump -U ao_owner -Fc agentic_office" > $f; echo $f')
echo "   $DUMP"

echo "2/8 ship the committed code (env files and node_modules are never touched)"
ssh_ "mkdir -p ~/$AO_HOME"
git archive --format=tar HEAD | ssh_ "cd ~/$AO_HOME && tar xf - 2>/dev/null; find . -name '._*' -not -path '*/node_modules/*' -delete"
if [[ -n "${AO_MONOREPO:-}" ]]; then
  deploy/scripts/build-verifier.sh "$AO_MONOREPO" --prepare-only
  COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C services/verifier hermes HERMES_REF | ssh_ "cd ~/$AO_HOME/services/verifier && tar xf - 2>/dev/null"
fi

echo "3/8 env files: copied once from the old layout (mode 600), then left alone"
ssh_ "cd ~/$AO_HOME/deploy/compose && for pair in api:ao-control-plane/accounts-sync/deploy console:ao-control-plane/control-plane/deploy keycloak:ao-control-plane/keycloak/deploy; do n=\${pair%%:*}; o=\$HOME/\${pair#*:}/.env; if [ ! -f \$n/.env ] && [ -f \$o ]; then cp \$o \$n/.env && chmod 600 \$n/.env && echo \"   \$n/.env copied\"; elif [ -f \$n/.env ]; then echo \"   \$n/.env already there\"; else echo \"   \$n/.env MISSING (copy .env.example and fill it in)\"; fi; done; cd api && (grep -q '^AO_BILLING_PASSWORD=.' .env || printf '\nAO_BILLING_PASSWORD=%s\n' \"\$(openssl rand -hex 24)\" >> .env); (grep -q '^AO_MEDIA_SIGNING_KEY=.' .env || printf '\nAO_MEDIA_SIGNING_KEY=%s\n' \"\$(openssl rand -hex 32)\" >> .env); chmod 600 .env"

echo "4/8 verifier image (the Hermes scanner and compiler, pinned)"
ssh_ "cd ~/$AO_HOME/services/verifier && if [ -d hermes ]; then docker build -q -t ao-verifier:latest . >/dev/null && echo '   built ao-verifier:latest'; elif docker image inspect ao-verifier:latest >/dev/null 2>&1; then echo '   keeping the existing ao-verifier:latest'; else echo '   NO verifier image: marketplace uploads stay 503 until you deploy with AO_MONOREPO=<monorepo checkout>'; fi"

echo "5/8 migrate (the migrator records the renamed growth migrations instead of running them twice)"
ssh_ "cd ~/$AO_HOME/database && (set -a; . ../deploy/compose/api/.env; set +a; docker run --rm --network ao-live_default -v \"\$PWD\":/w -w /w -e DATABASE_URL=\"postgres://ao_owner:\${PG_OWNER_PASSWORD}@postgres:5432/agentic_office\" -e AO_APP_PASSWORD -e AO_READONLY_PASSWORD -e AO_ADMIN_PASSWORD -e AO_AUTH_PASSWORD -e AO_BILLING_PASSWORD node:24.15.0-alpine sh -c 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && node migrate.ts')"

echo "6/8 build images, then start: gate first (sign-in stays reachable), then API, verifier, prober, media worker"
ssh_ "cd ~/$AO_HOME && deploy/stack.sh api build api media-worker prober >/dev/null && deploy/stack.sh api up -d --no-deps api-gate && deploy/stack.sh api up -d --no-deps api && (docker image inspect ao-verifier:latest >/dev/null 2>&1 && deploy/stack.sh api up -d --no-deps verifier || true) && deploy/stack.sh api up -d --no-deps prober && deploy/stack.sh api up -d --no-deps minio-init media-worker && sleep 8 && docker logs --tail 12 ao-live-api-1 2>&1 | sed -E 's/(key|secret|token)=[^ ]+/\\1=<hidden>/Ig'"

echo "7/8 console and Keycloak (their compose files moved to this repo; same project names, same volumes)"
ssh_ "cd ~/$AO_HOME && deploy/stack.sh console up -d --build && deploy/stack.sh keycloak up -d"

echo "8/8 checks against the gate on the host"
ssh_ "cd ~/$AO_HOME && tests/tools/api-gate-check.sh http://127.0.0.1:8183 && tests/tools/keycloak-gate-check.sh http://127.0.0.1:8181"
echo "done ($COMMIT). Payments are off; the help assistant is off until keys are set (deploy/scripts/set-help-keys.sh on the host)."
echo "Public side, once (root, on the host):  sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8183   (already set if sign-in worked before)"
echo "Then from any network:  tests/tools/api-gate-check.sh https://tanmay-hp-linux-server.tail41864f.ts.net:8443   and open  .../status"
