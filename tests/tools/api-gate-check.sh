#!/usr/bin/env bash
# What the public may and may not reach on the Agentic Office API. Usage: api-gate-check.sh <base-url>   (the public URL, or http://127.0.0.1:8183 on the host)
# Exits non-zero if the sign-in path is closed, or anything that must stay private is open. Sends no credentials and changes nothing.
set -uo pipefail
BASE="${1:?usage: api-gate-check.sh <base-url>}"; BASE="${BASE%/}"; fail=0
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
want() { local exp="$1" got; shift; got=$(code "$@"); if [[ "$got" =~ ^($exp)$ ]]; then echo "PASS $got $*"; else echo "FAIL $got (wanted $exp) $*"; fail=1; fi; }
# open: what the app needs to sign a person in and keep them signed in
want 200 "$BASE/healthz"
want 200 "$BASE/v1/auth/config"
want 200 "$BASE/v1/status"
want 200 "$BASE/status"
want '400|401' -X POST -H 'content-type: application/json' --data '{}' "$BASE/v1/auth/exchange"
want 401 "$BASE/v1/me"
# closed: the admin API, and the webhooks nobody has switched on
for p in / /admin /admin/users /admin/health /admin/growth/campaigns /admin/marketplace /v1/webhooks/resend /v1/payments/webhooks/youpi-experimental /.git/config /metrics; do want 404 "$BASE$p"; done
want 404 -X POST --data '{}' "$BASE/v1/webhooks/resend"
exit $fail
