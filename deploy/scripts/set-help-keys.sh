#!/usr/bin/env bash
# Stores the help assistant's provider settings in the API's .env without ever echoing or logging a key. Run it on the HOST where the stack runs,
# as the user that owns the .env:   deploy/scripts/set-help-keys.sh [path/to/.env]
# It asks for the base URL, the models and the keys (typed or pasted; nothing is shown), writes them mode 600, and tells you how many keys it stored.
set -euo pipefail
ENVF="${1:-$(cd "$(dirname "$0")/../compose/api" && pwd)/.env}"
[[ -f "$ENVF" ]] || { echo "no such file: $ENVF"; exit 2; }
read -r -p "Provider base URL (ends with /v1, e.g. https://api.openai.com/v1): " BASE
[[ "$BASE" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || { echo "the base URL must start with https:// and contain no spaces or quotes"; exit 2; }
read -r -p "Chat model [gpt-4o-mini]: " CHAT; CHAT=${CHAT:-gpt-4o-mini}
read -r -p "Embedding model [text-embedding-3-small]: " EMB; EMB=${EMB:-text-embedding-3-small}
for v in "$CHAT" "$EMB"; do [[ "$v" =~ ^[A-Za-z0-9._:/-]+$ ]] || { echo "model names may only contain letters, digits and . _ : / -"; exit 2; }; done
KEYS=""
echo "Paste each API key and press Enter (nothing is shown). Empty line to finish."
while true; do
  read -r -s -p "key: " K; echo
  [[ -z "$K" ]] && break
  [[ "$K" =~ ^[A-Za-z0-9._~+/=-]{16,}$ ]] || { echo "  that does not look like a key (16+ characters, no spaces or commas); skipped"; continue; }
  KEYS="${KEYS:+$KEYS,}$K"
done
[[ -n "$KEYS" ]] || { echo "no keys entered; nothing changed"; exit 1; }
cp -n "$ENVF" "$ENVF.pre-help.bak"; chmod 600 "$ENVF.pre-help.bak"
TMP="$(mktemp)"; chmod 600 "$TMP"
grep -vE '^(AO_HELP_BASE_URL|AO_HELP_API_KEYS|AO_HELP_CHAT_MODEL|AO_HELP_EMBED_MODEL)=' "$ENVF" > "$TMP" || true
{ printf 'AO_HELP_BASE_URL=%s\nAO_HELP_API_KEYS=%s\nAO_HELP_CHAT_MODEL=%s\nAO_HELP_EMBED_MODEL=%s\n' "$BASE" "$KEYS" "$CHAT" "$EMB"; } >> "$TMP"
mv "$TMP" "$ENVF"; chmod 600 "$ENVF"
echo "stored $(awk -F, '{print NF}' <<<"$KEYS") key(s) in $ENVF (backup: $ENVF.pre-help.bak)."
echo "Apply with:  deploy/stack.sh api up -d --no-deps api      (the assistant indexes the docs on start)"
