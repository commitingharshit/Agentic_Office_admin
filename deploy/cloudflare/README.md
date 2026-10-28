# Public doors on agenticoffice.work (Cloudflare Tunnel)

| Name | Goes to on the host | Who |
|---|---|---|
| `api.agenticoffice.work` | API gate `127.0.0.1:8183` (`/v1/*`, `/healthz`, `/status`) | public |
| `auth.agenticoffice.work` | Keycloak gate `127.0.0.1:8181` (`/realms/agentic-office/*`, `/resources/*`) | public |
| `admin.agenticoffice.work` | admin console `127.0.0.1:8791` | admins, through Cloudflare Access |
| `langfuse.agenticoffice.work` | Langfuse web `127.0.0.1:3000` (from `~/ao-langfuse`, not this repo) | team, through Cloudflare Access |

The console is one name only: it builds every sign-in return address from `AUTH_BASE_URL`, so its sign-in pages and the admin pages must
share a host. The desktop app signs in through Keycloak, so nothing public needs the console's own sign-in pages any more.

Done by a person. Cloudflare and Google are the owner's accounts; the host steps need root.

## 1. Cloudflare
1. Add `agenticoffice.work` as a site (free plan) and switch the domain's nameservers at the registrar to the two Cloudflare gives. Wait for "Active".
2. SSL/TLS > Edge Certificates: turn on Always Use HTTPS.

## 2. The tunnel (on the host)
```
cloudflared tunnel login
cloudflared tunnel create agentic-office          # prints the tunnel id and writes ~/.cloudflared/<id>.json
sudo mkdir -p /etc/cloudflared && sudo mv ~/.cloudflared/<id>.json /etc/cloudflared/ && sudo chmod 600 /etc/cloudflared/<id>.json
sudo cp ~/ao-platform/deploy/cloudflare/config.yml /etc/cloudflared/config.yml   # then put the id in place of <TUNNEL_ID> (twice)
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
```

## 3. Cloudflare Access on admin and langfuse (before their DNS records exist)
Zero Trust > Access > Applications > Add > Self-hosted: domain `admin.agenticoffice.work` (whole name, no path), session 24 h.
Policy: Allow, Emails = each admin's address (or a One-time PIN / Google login method limited to those emails). Save it.
The console still asks for its own Keycloak sign-in and checks the admin role behind this; Access only keeps everyone else off the page.

Same again for `langfuse.agenticoffice.work`, Emails = each teammate who reads traces. Langfuse's own login stays behind it. Traces are
not sent through this name (Hermes and the telemetry relay post to Langfuse on the tailnet or 127.0.0.1), so Access only meets browsers;
anything that must post here later needs an Access service token.

## 4. DNS and start
```
cloudflared tunnel route dns agentic-office api.agenticoffice.work
cloudflared tunnel route dns agentic-office auth.agenticoffice.work
cloudflared tunnel route dns agentic-office admin.agenticoffice.work
cloudflared tunnel route dns agentic-office langfuse.agenticoffice.work
sudo cloudflared service install && systemctl status cloudflared
```

## 5. Google
In the OAuth client Keycloak uses, add the authorized redirect URI
`https://auth.agenticoffice.work/realms/agentic-office/broker/google/endpoint`. Keep the old `ts.net` one until step 8.

## 6. Env files (on the host, under `~/ao-platform/deploy/compose`)
Back up first: `for d in api console keycloak; do cp $d/.env $d/.env.pre-cloudflare.bak; done`. Change only these lines:

`keycloak/.env`
```
KC_HOSTNAME=https://auth.agenticoffice.work
AO_PUBLIC_URL=https://admin.agenticoffice.work
```
`console/.env`
```
AUTH_BASE_URL=https://admin.agenticoffice.work
ADMIN_HOSTS=admin.agenticoffice.work,127.0.0.1,localhost
AUTH_IP_HEADER=cf-connecting-ip
KEYCLOAK_ISSUER=https://auth.agenticoffice.work/realms/agentic-office
```
`api/.env` (`KEYCLOAK_JWKS_URL` and `KEYCLOAK_ADMIN_URL` stay on the internal `http://keycloak:8080` addresses)
```
KEYCLOAK_ISSUER=https://auth.agenticoffice.work/realms/agentic-office
AUTH_ISSUER=https://admin.agenticoffice.work
AO_PUBLIC_URL=https://api.agenticoffice.work
PROBER_PROBES=[{"id":"api-public","label":"App sign-in API","url":"https://api.agenticoffice.work/healthz"},{"id":"signin","label":"Sign-in (Keycloak)","url":"https://auth.agenticoffice.work/realms/agentic-office/.well-known/openid-configuration"},{"id":"console","label":"Admin console","url":"http://control-plane:8791/api/health"}]
```
`console/.env` also: `AO_TRACES_URL=https://langfuse.agenticoffice.work/project/<project id>/traces` (the Traces link).

`~/ao-langfuse` (back up `docker-compose.yml` and `.env` first): under `langfuse-web` add the port `"127.0.0.1:3000:3000"` next to the
tailnet one, delete the `cloudflared` service (the old quick tunnel), and in `.env` set `NEXTAUTH_URL=https://langfuse.agenticoffice.work`.
Then `docker compose up -d --remove-orphans langfuse-web langfuse-worker` there.

`AUTH_ISSUER` must equal the console's `AUTH_BASE_URL`; tokens from the old Better Auth sign-in stop working (people sign in again through Keycloak).
The console is probed on its internal address because Access answers the public one with a login page.

Then, from `~/ao-platform`:
```
deploy/stack.sh keycloak up -d && deploy/compose/keycloak/configure.sh     # the last line adds the admin console's new return address
deploy/stack.sh api up -d --no-deps api prober
deploy/stack.sh console up -d
```

## 7. Check
```
tests/tools/api-gate-check.sh https://api.agenticoffice.work
tests/tools/keycloak-gate-check.sh https://auth.agenticoffice.work
```
Open `https://admin.agenticoffice.work/admin`: Access login, then Keycloak sign-in, then the console. From a browser that is not an admin's,
the Access page must be the end of the road. `https://api.agenticoffice.work/status` shows all three probes up.
`https://langfuse.agenticoffice.work`: Access login, then the Langfuse login, and it stays on that address after signing in; the console's
Traces link opens it. From a browser not on the teammate list, the Access page must be the end of the road.

## 8. Retire the Tailscale doors
Desktop builds in people's hands still call `https://tanmay-hp-linux-server.tail41864f.ts.net:8443`; the API there now sends them to
`auth.agenticoffice.work` to sign in, so they keep working. Ship a desktop build whose API address is `https://api.agenticoffice.work`,
wait until old builds are gone, then `sudo tailscale funnel reset` and remove the `ts.net` Google redirect URI.

Rollback: copy each `.env.pre-cloudflare.bak` back, rerun the three `stack.sh` lines, `sudo systemctl stop cloudflared`. For Langfuse,
copy its two backups back and `docker compose up -d` in `~/ao-langfuse` (the quick tunnel returns, with a new address).
