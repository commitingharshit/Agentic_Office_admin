# verifier

The Hermes **skill scanner** (`tools/skills_scan_cli.py`) and **agent blueprint compiler** (`agent.office.blueprint.cli`) as a
small internal HTTP service, so the API needs neither Python nor a Hermes checkout. Marketplace skill, routine, workflow, agent
and bundle uploads answer `503` while the API cannot reach it (`VERIFIER_URL`); nothing is ever accepted unverified.

| Endpoint | Body | Reply |
|---|---|---|
| `POST /scan` | `{name, files: {path: base64}}` | `{code, stdout, stderr, timedOut, overflow}` of the scanner |
| `POST /compile` | `{op: "check"\|"dryrun", stdin}` | the same shape, for the compiler |
| `GET /healthz` | | `200 {ok, hermes}` once Hermes imports; `503` otherwise |

No authentication: it is on the internal network only and must never be published (the gateway does not route to it).

## Build
`deploy/scripts/build-verifier.sh /path/to/monorepo` copies `agent/ tools/ hermes_cli/ plugins/ providers/` and the three top-level
modules from `vendor/hermes-agent` into `services/verifier/hermes/` (ignored by git), records the monorepo commit in `HERMES_REF`,
and builds the image `ao-verifier`. The compiler pulls in about sixty Hermes files (config, models, profiles, provider plugins), so
the pin is the whole tree rather than a hand-picked file list; re-run the script to move to a newer Hermes.

## Run locally without Docker
`HERMES_DIR=/path/to/vendor/hermes-agent VERIFIER_PYTHON=/path/to/its/venv/bin/python python3 server.py`
