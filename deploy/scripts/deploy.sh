#!/usr/bin/env bash
# Deploy migration 0018 (plans, prices, limits, payment tables) and the matching API + console to the live host.
# Payments stay OFF: no provider credentials are set, AO_PAYMENTS is left empty. Run by a person, from the repo root:  scripts/dev/deploy-pricing-payments.sh
# Order: dump -> backup env -> add the billing role password -> ship code -> migrate -> restart API -> rebuild console -> check.
# Rollback: restore the dump printed in step 1 (pg_restore), put .env.pre-0018.bak back, restart the API and the console.
set -euo pipefail
HOST=${AO_HOST:-ateam-tanmay-hp}
cd "$(git rev-parse --show-toplevel)/services"

echo "1/6 dump the live database"
DUMP=$(ssh -o BatchMode=yes "$HOST" 'mkdir -p ~/ao-backups-manual; f=~/ao-backups-manual/pre-0018-$(date -u +%Y%m%dT%H%M%SZ).dump; docker exec ao-live-postgres-1 sh -c "pg_dump -U ao_owner -Fc agentic_office" > $f; echo $f')
echo "   $DUMP"

echo "2/6 env backup and billing role password (generated on the host, never printed)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && cp -n .env .env.pre-0018.bak && chmod 600 .env.pre-0018.bak && (grep -q "^AO_BILLING_PASSWORD=." .env || printf "\n# Payments (off until AO_PAYMENTS is set)\nAO_BILLING_PASSWORD=%s\n" "$(openssl rand -hex 24)" >> .env); grep -c "^AO_BILLING_PASSWORD=.\{20,\}" .env'

echo "2b/6 retire Better Auth on the API: it stops accepting its sign-in tokens (the env backup above is the way back)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && sed -i "s/^AUTH_ISSUER=.*/AUTH_ISSUER=/; s/^AUTH_JWKS_URL=.*/AUTH_JWKS_URL=/" .env && grep -c "^AUTH_ISSUER=$" .env'

echo "3/6 ship the code"
COPYFILE_DISABLE=1 tar --exclude=node_modules --exclude=.next --exclude=.DS_Store --no-xattrs -czf - \
  accounts-sync/db accounts-sync/src accounts-sync/deploy/docker-compose.yml accounts-sync/deploy/.env.example accounts-sync/package.json \
  control-plane/src control-plane/public control-plane/package.json control-plane/Dockerfile \
  | ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane && tar xzf - 2>/dev/null; find . -name "._*" -not -path "*/node_modules/*" -delete'

echo "3b/6 the sign-in page look (Keycloak theme, with the app logo)"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - keycloak/theme | ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane && tar xzf - 2>/dev/null; find keycloak -name "._*" -delete; docker restart ao-keycloak-keycloak-1 >/dev/null && echo keycloak-restarted'

echo "4/6 migrate"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync && (set -a; . deploy/.env; set +a; docker run --rm --network ao-live_default -v "$PWD":/w -w /w -e DATABASE_URL="postgres://ao_owner:${PG_OWNER_PASSWORD}@postgres:5432/agentic_office" -e AO_APP_PASSWORD -e AO_READONLY_PASSWORD -e AO_ADMIN_PASSWORD -e AO_AUTH_PASSWORD -e AO_BILLING_PASSWORD node:24.15.0-alpine node db/migrate.ts)'

echo "5/6 restart the API (compose restart silently does nothing for a changed env; recreate it)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && docker compose -p ao-live up -d --no-deps api && sleep 5 && docker logs --tail 8 ao-live-api-1'

echo "6/6 rebuild and restart the console"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/control-plane/deploy && docker compose -p ao-control-plane-web up -d --build'
echo "done. Payments are off. Check: https://tanmay-hp-linux-server.tail41864f.ts.net/admin (Billing & Plans, Payments, Notifications)"
