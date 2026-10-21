#!/usr/bin/env bash
# Deploy the pricing/payments, admin-invite, CORS and Growth (promotions, releases, campaign email) work: migrations 0018-0030 (growth is 0029/0030), the API, the media worker and the console.
# Growth: campaign email stays off (no Resend key) and the public Resend webhook is not opened by this script.
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
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && cp -n .env .env.pre-0018.bak && chmod 600 .env.pre-0018.bak && (grep -q "^AO_BILLING_PASSWORD=." .env || printf "\n# Payments (off until AO_PAYMENTS is set)\nAO_BILLING_PASSWORD=%s\n" "$(openssl rand -hex 24)" >> .env); (grep -q "^AO_MEDIA_SIGNING_KEY=." .env || printf "\n# Growth: signs the app links to promotion media\nAO_MEDIA_SIGNING_KEY=%s\n" "$(openssl rand -hex 32)" >> .env); grep -c "^AO_BILLING_PASSWORD=.\{20,\}" .env; grep -c "^AO_MEDIA_SIGNING_KEY=.\{32,\}" .env'

echo "2b/6 retire Better Auth on the API: it stops accepting its sign-in tokens (the env backup above is the way back)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && sed -i "s/^AUTH_ISSUER=.*/AUTH_ISSUER=/; s/^AUTH_JWKS_URL=.*/AUTH_JWKS_URL=/" .env && grep -c "^AUTH_ISSUER=$" .env'

echo "3/6 ship the code (first remove growth files that earlier test runs left on the host: the old 0020/0021 and 0021/0022 migration names and src/growth)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync && rm -f db/migrations/0020_growth.sql db/migrations/0021_releases_email.sql db/migrations/0021_growth.sql db/migrations/0022_releases_email.sql test/growth-*.test.ts && rm -rf src/growth'
COPYFILE_DISABLE=1 tar --exclude=node_modules --exclude=.next --exclude=.DS_Store --no-xattrs -czf - \
  accounts-sync/db accounts-sync/src accounts-sync/deploy/docker-compose.yml accounts-sync/deploy/media-worker.Dockerfile accounts-sync/deploy/Dockerfile.marketplace accounts-sync/deploy/api-gate.conf accounts-sync/deploy/.env.example accounts-sync/package.json accounts-sync/package-lock.json \
  control-plane/src control-plane/public control-plane/package.json control-plane/Dockerfile \
  | ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane && tar xzf - 2>/dev/null; find . -name "._*" -not -path "*/node_modules/*" -delete'

echo "3b/6 the sign-in page look (Keycloak theme, with the app logo)"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - keycloak/theme | ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane && tar xzf - 2>/dev/null; find keycloak -name "._*" -delete; docker restart ao-keycloak-keycloak-1 >/dev/null && echo keycloak-restarted'

echo "3c/6 runtime packages on the host (the API mounts accounts-sync/node_modules; new code can import a package the host does not have yet, and then the API cannot start)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync && docker run --rm -v "$PWD":/w -w /w node:24.15.0-alpine npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && ls node_modules | tr "\n" " " && echo'

echo "4/6 migrate"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync && (set -a; . deploy/.env; set +a; docker run --rm --network ao-live_default -v "$PWD":/w -w /w -e DATABASE_URL="postgres://ao_owner:${PG_OWNER_PASSWORD}@postgres:5432/agentic_office" -e AO_APP_PASSWORD -e AO_READONLY_PASSWORD -e AO_ADMIN_PASSWORD -e AO_AUTH_PASSWORD -e AO_BILLING_PASSWORD node:24.15.0-alpine node db/migrate.ts)'

echo "5/6 restart the API (compose restart silently does nothing for a changed env; recreate it)"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/accounts-sync/deploy && docker compose -p ao-live up -d --no-deps api-gate && docker compose -p ao-live up -d --no-deps api && docker compose -p ao-live up -d --build minio-init media-worker && sleep 5 && docker logs --tail 8 ao-live-api-1; docker logs --tail 4 ao-live-media-worker-1 2>&1'

echo "6/6 rebuild and restart the console"
ssh -o BatchMode=yes "$HOST" 'cd ~/ao-control-plane/control-plane/deploy && docker compose -p ao-control-plane-web up -d --build'
echo "done. Payments are off. Check: https://tanmay-hp-linux-server.tail41864f.ts.net/admin (Billing & Plans, Payments, Notifications)"
echo "App sign-in from outside the tailnet needs the API gate published (a root command on the host, run once):"
echo "  sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8183     (undo: sudo tailscale serve --bg --https=8443 http://127.0.0.1:8790)"
echo "then from any network: scripts/dev/api-gate-check.sh https://tanmay-hp-linux-server.tail41864f.ts.net:8443"
