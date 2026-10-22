#!/usr/bin/env bash
# Turn the EXPERIMENTAL YouPI payment provider on for the live API. Run by the owner, in a terminal:  deploy/scripts/enable-payments-youpi.sh
# Use sandbox/test credentials first. The three values are typed here without echo, travel over ssh on stdin (never as arguments, never
# printed or logged), and land in the API's env file on the host, mode 600. A webhook is only an observation: a plan activates only when an
# administrator settles the order on the Payments page. Undo: restore .env.pre-youpi.bak next to the .env and recreate the API.
set -euo pipefail
HOST=${AO_HOST:-ateam-tanmay-hp}; AO_HOME=${AO_HOME:-ao-platform}
[[ "$AO_HOME" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "AO_HOME may only contain letters, digits and . _ / -" >&2; exit 1; }
read -r  -p "YouPI API address (https://...): " URL
read -r  -p "YouPI merchant id: " MID
read -rs -p "YouPI webhook secret (hidden): " SEC; echo
[[ "$URL" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || { echo "The API address must start with https:// and contain only URL characters." >&2; exit 1; }
[[ "$MID" =~ ^[A-Za-z0-9._-]+$ && -n "$SEC" && "$SEC" != *$'\n'* ]] || { echo "Merchant id (letters, digits . _ -) and webhook secret are required." >&2; exit 1; }
# The remote script is an ARGUMENT (it holds no secret); the three values travel on ssh's stdin, one per line, and the script's `read` calls take them.
# Nothing secret is ever an argument or an environment variable.
REMOTE='set -euo pipefail
cd ~/"$1"/deploy/compose/api
IFS= read -r URL; IFS= read -r MID; IFS= read -r SEC
cp -n .env .env.pre-youpi.bak && chmod 600 .env.pre-youpi.bak
for k in AO_PAYMENTS YOUPI_API_URL YOUPI_MERCHANT_ID YOUPI_WEBHOOK_SECRET; do grep -v "^${k}=" .env > .env.tmp || true; mv .env.tmp .env; done
printf "AO_PAYMENTS=youpi-experimental\nYOUPI_API_URL=%s\nYOUPI_MERCHANT_ID=%s\nYOUPI_WEBHOOK_SECRET=%s\n" "$URL" "$MID" "$SEC" >> .env
chmod 600 .env
docker compose -p ao-live up -d --no-deps api >/dev/null && sleep 5 && docker logs --tail 5 ao-live-api-1 2>&1 | grep -ci "payments" || true'
printf '%s\n%s\n%s\n' "$URL" "$MID" "$SEC" | ssh -o BatchMode=yes "$HOST" "bash -c $(printf '%q' "$REMOTE") remote $AO_HOME"
echo "Done. Open the Payments page: the yellow 'no provider' notice should be gone and say the provider is experimental."
