#!/usr/bin/env bash
# Settings the realm file cannot apply once the realm exists (Keycloak imports it only the first time). Safe to run again; run it on the host
# where Keycloak listens on 127.0.0.1:8180, with this folder's .env present. It never prints a secret.
#   - the user profile may keep `picture`, `ao_plan` and `ao_role` (the plan and role are written by our API and never editable by the person)
#   - Google's picture is copied to the person's `picture` on every Google sign-in
#   - the ID token carries `picture`, `ao_plan` and `ao_role`. These are for other apps' convenience only: our own server decides access from its database.
set -euo pipefail
cd "$(dirname "$0")"
A=$(grep '^KC_ADMIN_PASSWORD=' .env | cut -d= -f2-); U=$(grep '^KC_ADMIN_USER=' .env | cut -d= -f2-)
T=$(curl -s -X POST http://127.0.0.1:8180/realms/master/protocol/openid-connect/token -d grant_type=password -d client_id=admin-cli -d "username=$U" --data-urlencode "password=$A" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
R=http://127.0.0.1:8180/admin/realms/agentic-office; H="Authorization: Bearer $T"
curl -s -H "$H" $R/users/profile > /tmp/ao-up.json
python3 - <<'PY'
import json
p = json.load(open('/tmp/ao-up.json'))
have = {a['name'] for a in p['attributes']}
for name, label in (('picture', 'Picture'), ('ao_plan', 'Plan'), ('ao_role', 'Role')):
    if name not in have:
        p['attributes'].append({"name": name, "displayName": label, "permissions": {"view": ["admin", "user"], "edit": ["admin"]}, "multivalued": False})
json.dump(p, open('/tmp/ao-up2.json', 'w'))
PY
curl -s -o /dev/null -w "user profile -> %{http_code}\n" -X PUT -H "$H" -H 'content-type: application/json' $R/users/profile -d @/tmp/ao-up2.json
rm -f /tmp/ao-up.json /tmp/ao-up2.json
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
if curl -s -H "$H" $R/identity-provider/instances/google/mappers | python3 -c "import sys,json; sys.exit(0 if any(m['name']=='picture' for m in json.load(sys.stdin)) else 1)"; then echo "google picture mapper -> already there"
else echo "google picture mapper -> $(code -X POST -H "$H" -H 'content-type: application/json' $R/identity-provider/instances/google/mappers -d '{"name":"picture","identityProviderAlias":"google","identityProviderMapper":"oidc-user-attribute-idp-mapper","config":{"syncMode":"FORCE","claim":"picture","user.attribute":"picture"}}') (201 = made)"; fi
SID=$(curl -s -H "$H" $R/client-scopes | python3 -c "import sys,json; print([s['id'] for s in json.load(sys.stdin) if s['name']=='profile'][0])")
for pair in "picture:picture" "ao_plan:ao_plan" "ao_role:ao_role"; do
  attr=${pair%%:*}; claim=${pair##*:}
  echo "token claim $claim -> $(code -X POST -H "$H" -H 'content-type: application/json' $R/client-scopes/$SID/protocol-mappers/models -d "{\"name\":\"$claim\",\"protocol\":\"openid-connect\",\"protocolMapper\":\"oidc-usermodel-attribute-mapper\",\"config\":{\"user.attribute\":\"$attr\",\"claim.name\":\"$claim\",\"jsonType.label\":\"String\",\"id.token.claim\":\"true\",\"access.token.claim\":\"false\",\"userinfo.token.claim\":\"true\"}}") (201 made, 409 already there)"
done
# The admin console's sign-in return address: the realm file sets it from AO_PUBLIC_URL only on the first import, so a new public name
# (e.g. moving to Cloudflare Tunnel) is added here. Old addresses are kept, so switching back still works. The client is piped, never saved.
P=$(grep '^AO_PUBLIC_URL=' .env | cut -d= -f2- | sed 's#/*$##')
if [ -n "$P" ]; then
  CID=$(curl -s -H "$H" "$R/clients?clientId=ao-admin-console" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
  echo "admin console return address $P -> $(curl -s -H "$H" $R/clients/$CID | P="$P" python3 -c '
import sys, json, os
c = json.load(sys.stdin); p = os.environ["P"]
c["redirectUris"] = sorted(set(c.get("redirectUris", [])) | {p + "/admin/callback"})
a = c.setdefault("attributes", {}); old = [u for u in a.get("post.logout.redirect.uris", "").split("##") if u]
a["post.logout.redirect.uris"] = "##".join(sorted(set(old) | {p + "/*"}))
print(json.dumps(c))' | curl -s -o /dev/null -w "%{http_code}" -X PUT -H "$H" -H 'content-type: application/json' $R/clients/$CID -d @-) (204 = set)"
fi
