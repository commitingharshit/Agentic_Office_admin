#!/usr/bin/env bash
# Prepares (and by default builds) the verifier image from a pinned copy of Hermes.
# Usage: deploy/scripts/build-verifier.sh <monorepo-checkout> [image-tag | --prepare-only]
#   --prepare-only: copy the pinned files into services/verifier/hermes and write HERMES_REF, build nothing (the deploy script ships the folder and builds on the host).
set -euo pipefail
MONO=${1:?usage: build-verifier.sh <monorepo-checkout> [image-tag | --prepare-only]}; TAG=${2:-ao-verifier:latest}
SRC="$MONO/vendor/hermes-agent"; [[ -f "$SRC/tools/skills_scan_cli.py" ]] || { echo "no Hermes at $SRC"; exit 1; }
DEST="$(cd "$(dirname "$0")/../.." && pwd)/services/verifier"
rm -rf "$DEST/hermes"; mkdir -p "$DEST/hermes"
for d in agent tools hermes_cli plugins providers; do
  rsync -a --exclude __pycache__ --exclude '*.pyc' --exclude tests --exclude node_modules "$SRC/$d/" "$DEST/hermes/$d/"
done
cp "$SRC/toolsets.py" "$SRC/utils.py" "$SRC/hermes_constants.py" "$DEST/hermes/"
git -C "$MONO" log -1 --format=%H -- vendor/hermes-agent > "$DEST/HERMES_REF"
echo "pinned Hermes $(cut -c1-12 "$DEST/HERMES_REF"), $(du -sh "$DEST/hermes" | cut -f1)"
[[ "$TAG" == "--prepare-only" ]] || docker build -t "$TAG" "$DEST"
