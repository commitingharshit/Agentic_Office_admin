# prober

Probes the platform's public addresses and internal services every 30 s and records `up` / `degraded` / `down` in `service_status`
(history in `status_checks`, 90 days). The API serves the result at `GET /v1/status`; the public status page and the console's
Infrastructure page read it.

- One failed check is `degraded`; `down` needs two in a row; a success slower than 2 s is `degraded`.
- A reading older than 3 minutes is shown as `down` (the prober itself may be what is down).
- The API also runs its own checks (database, verifier, Keycloak keys). This container adds the outside view.
- It shares the probe code with the API: `services/api/src/status/probe.ts`.

Honest limit: it runs on the same host as the platform, so it cannot see the host or the Cloudflare tunnel being gone. Point a free
external monitor at `https://api.agenticoffice.work/v1/status` for that case.

Example `AO_STATUS_PROBES` (set as `PROBER_PROBES` in the API stack's `.env`):
```json
[
 {"id":"console","label":"Admin console","url":"http://control-plane:8791/api/health"},
 {"id":"api-public","label":"App sign-in API","url":"https://api.agenticoffice.work/healthz"},
 {"id":"signin","label":"Sign-in (Keycloak)","url":"https://auth.agenticoffice.work/realms/agentic-office/.well-known/openid-configuration"}
]
```
