#!/usr/bin/env bash
# What the public may and may not reach on Keycloak. Usage: keycloak-gate-check.sh <base-url>   (e.g. the public URL, or http://127.0.0.1:8181 on the host)
# Exits non-zero if anything that must be open is closed, or anything that must be closed is open.
set -uo pipefail
BASE="${1:?usage: keycloak-gate-check.sh <base-url>}"; BASE="${BASE%/}"; fail=0
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
want() { local exp="$1" path="$2" got; got=$(code "$BASE$path"); if [[ "$got" =~ ^($exp)$ ]]; then echo "PASS $got $path"; else echo "FAIL $got (wanted $exp) $path"; fail=1; fi; }
# open: the sign-in a person and the desktop app use
want 200 /realms/agentic-office/.well-known/openid-configuration
want 200 /realms/agentic-office/protocol/openid-connect/certs
want '200|302' '/realms/agentic-office/protocol/openid-connect/auth?client_id=agentic-office-desktop&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&scope=openid&code_challenge=x&code_challenge_method=S256'
# closed: Keycloak's administration and everything else
for p in / /admin/ /admin/master/console/ /admin/realms /admin/realms/agentic-office/users /realms/master /realms/master/.well-known/openid-configuration \
         /realms/master/protocol/openid-connect/auth /metrics /health /health/ready /realms/agentic-office/clients-registrations/default /js/ /.git/config; do want '404' "$p"; done
exit $fail
