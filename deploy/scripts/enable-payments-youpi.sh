#!/usr/bin/env bash
# Turn the EXPERIMENTAL YouPI payment provider on for the live API. Run by the owner, in a terminal:  scripts/dev/enable-payments-youpi.sh
# Use sandbox/test credentials first. The three values are typed here without echo, travel over ssh on stdin (never as arguments, never
# printed or logged), and land in the API's env file on the host, mode 600. A webhook is only an observation: a plan activates only when an
# administrator settles the order on the Payments page. Undo: restore deploy/.env.pre-youpi.bak and recreate the API.
set -euo pipefail
HOST=${AO_HOST:-ateam-tanmay-hp}
read -r  -p "YouPI API address (https://...): " URL
read -r  -p "YouPI merchant id: " MID
read -rs -p "YouPI webhook secret (hidden): " SEC; echo
[[ "$URL" =~ ^https:// ]] || { echo "The API address must start with https://" >&2; exit 1; }
[[ -n "$MID" && -n "$SEC" ]] || { echo "Merchant id and webhook secret are required." >&2; exit 1; }
printf '%s\n%s\n%s\n' "$URL" "$MID" "$SEC" | ssh -o BatchMode=yes "$HOST" 'set -euo pipefail
cd ~/ao-control-plane/accounts-sync/deploy
IFS= read -r URL; IFS= read -r MID; IFS= read -r SEC
cp -n .env .env.pre-youpi.bak && chmod 600 .env.pre-youpi.bak
for k in AO_PAYMENTS YOUPI_API_URL YOUPI_MERCHANT_ID YOUPI_WEBHOOK_SECRET; do sed -i "/^${k}=/d" .env; done
printf "AO_PAYMENTS=youpi-experimental\nYOUPI_API_URL=%s\nYOUPI_MERCHANT_ID=%s\nYOUPI_WEBHOOK_SECRET=%s\n" "$URL" "$MID" "$SEC" >> .env
chmod 600 .env
docker compose -p ao-live up -d --no-deps api >/dev/null && sleep 5 && docker logs --tail 5 ao-live-api-1 2>&1 | grep -ci "payments" || true'
echo "Done. Open the Payments page: the yellow 'no provider' notice should be gone and say the provider is experimental."
