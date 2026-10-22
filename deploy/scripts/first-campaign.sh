#!/usr/bin/env bash
# Push one test campaign to ONE person on the live host so you can see it appear in that person's app window.
#   deploy/scripts/first-campaign.sh you@example.com          create it (live for that person only, 7 days)
#   deploy/scripts/first-campaign.sh --remove                 take it away again
# Run by a person. It writes to the live database (two small rows and a target); it reads no personal data beyond finding the id for the email.
set -euo pipefail
HOST=${AO_HOST:-ateam-tanmay-hp}; DB=${AO_DB_CONTAINER:-ao-live-postgres-1}; DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--remove" ]; then
  ssh -o BatchMode=yes "$HOST" "docker exec -i $DB psql -U ao_owner -d agentic_office -v ON_ERROR_STOP=1 -At" < "$DIR/first-campaign-remove.sql"; exit
fi
EMAIL="${1:?usage: first-campaign.sh <your-email> | --remove}"
[[ "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "that does not look like an email address"; exit 2; }
ssh -o BatchMode=yes "$HOST" "docker exec -i $DB psql -U ao_owner -d agentic_office -v ON_ERROR_STOP=1 -v email='$EMAIL' -At" < "$DIR/first-campaign.sql"
echo "Now, in the desktop app signed in as $EMAIL: Command Palette -> Developer: Reload Window, then open a new empty chat. The card appears within a few seconds."
echo "Nothing there after a minute? Admin -> Growth -> the campaign -> 'Would this person see it?' -> Explain tells you why not."
