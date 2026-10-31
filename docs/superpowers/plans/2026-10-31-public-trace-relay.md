# Public Trace Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Request traces from the packaged desktop app (Windows and macOS, off Tailscale) reach the team Langfuse, only for signed-in people who share usage.

**Architecture:** The existing write-only telemetry relay (`100.95.14.113:8790`, tailnet only) gets a public path on the API gate: `https://api.agenticoffice.work/relay/*`. The gate lets a trace through only when the API says the bearer device token is valid and its person shares usage (nginx `auth_request` to a new `GET /v1/me/telemetry-allowed`). Hermes' OpenTelemetry exporter sends that device token, the relay default URL moves to the public address, and the packaged runtime ships the tracing libraries with the `otel` plugin switched on.

**Tech Stack:** nginx 1.27 (API gate), Node/TypeScript API (`services/api`), Python 3.12 stdlib relay, Hermes (Python, OpenTelemetry SDK 1.39.1), Cloudflare Tunnel (already routes `api.` to the gate).

**Spec:** No separate spec. This plan argues from the 2026-10-31 investigation:
- Langfuse's newest trace is 2026-10-29 14:27 UTC; the one Windows user (app 1.127.0, sharing on, active 2026-10-31) has 0 traces.
- Blocker 1: `DEFAULT_RELAY_URL = "http://100.95.14.113:8790"` in `vendor/hermes-agent/gateway/team_telemetry.py` (desktop repo) is a tailnet address; `apply_relay_defaults` probes `/health`, fails off the tailnet, and turns tracing off.
- Blocker 2: the packaged runtime installs Hermes with `uv export --extra mcp` only (`scripts/package/macos/build-dmg.sh:104`), so `opentelemetry` is missing and the `otel` plugin logs "OpenTelemetry observer disabled".
- Blocker 3: only `scripts/hermes/wire-context-layer.py` (dev and bootstrap) adds `otel` to `plugins.enabled`; the packaged first run (`scripts/package/macos/hermes` → `setup-root.sh`) never does.
- The relay has no auth (it relied on the tailnet) and rate-limits per client address, which would be the gate's address once behind a proxy.

Two repos: **admin** = `~/Projects/Agentic_Office_admin` (API, gates, deploy); **desktop** = `~/Projects/Agentic_Office_ultra` (relay, Hermes, packaging).

## Global Constraints

- Public paths: exactly `GET /relay/health` and `POST /relay/v1/traces` on `api.agenticoffice.work`. `/relay/laya/predict` and every other `/relay/*` path answer 404.
- A trace is accepted only with `Authorization: Bearer <device token>` whose person has `usage_consent.shared = true`. Invalid or missing token: 401. Valid token, not sharing: 403.
- Body cap on `/relay/v1/traces`: 4 MiB (the relay's `MAX_TRACE_BYTES = 4 * 1024 * 1024`).
- The relay keeps binding to the tailnet address `100.95.14.113:8790`; it is never given its own public hostname or port.
- No new dependencies. The relay stays stdlib only. The OpenTelemetry versions are the ones already pinned: `opentelemetry-sdk==1.39.1`, `opentelemetry-exporter-otlp-proto-http==1.39.1` (Hermes `pyproject.toml` extra `observability`).
- Tracing must never slow down or break a chat turn: export failures are swallowed by the exporter (existing `export_timeout_millis=1000`).
- Request bodies are never logged (gate: no body logging; relay: existing `log_message` no-op).

## Review Focus

1. **Signed out or token expired mid-session:** spans are dropped (401), and the turn is unaffected. The test goes in Task 4 (`test_no_account_sends_no_authorization`).
2. **Sharing turned off while the app is open:** the next export is refused at once (403), with no client restart. The test goes in Task 1 (`telemetry-allowed answers 403 after sharing is turned off`).
3. **Caller sends its own `X-Forwarded-For` to dodge the per-client budget:** the relay trusts the header only from a configured proxy. The test goes in Task 3 (`test_forwarded_for_ignored_from_untrusted_peer`).
4. **Relay or Langfuse down:** the gate answers 502 and the exporter drops the batch. Task 6 Step 4 checks this by hand.
5. **A token-holder writes traces carrying another person's `user.id`:** this is a known limit, not fixed here. The gate proves who is sending, not what the spans claim. Marked with a `ponytail:` comment in Task 2. The upgrade path is for the relay to stamp the verified user id from an `X-AO-User` header set by the API.

---

### Task 1: API answers whether this token may send traces (admin repo)

**Files:**
- Modify: `services/api/src/api/telemetry.ts` (next to `getConsent`, line 49)
- Modify: `services/api/src/api/sync.ts:399` (route table, beside the `usage-consent` GET)
- Test: `services/api/test/telemetry.test.ts`

**Interfaces:**
- Produces: `GET /v1/me/telemetry-allowed` → `204` (no body) when the signed-in person shares usage, `403 {"error":"usage sharing is off"}` when not, `401` from the existing auth when the token is bad. Task 2's gate calls it.
- Produces: `export async function tracesAllowed(c: pg.PoolClient): Promise<boolean>` in `telemetry.ts`, which returns `(await getConsent(c)).shared`.

- [ ] **Step 1: Write the failing tests** in `telemetry.test.ts`, using the file's existing signed-in request helper:
  - `telemetry-allowed answers 204 while sharing`: PUT `/v1/me/usage-consent` `{shared: true}`, then GET `/v1/me/telemetry-allowed` → status 204, empty body.
  - `telemetry-allowed answers 403 after sharing is turned off`: PUT `{shared: true}`, PUT `{shared: false}`, GET → 403, body `{"error":"usage sharing is off"}`.
  - `telemetry-allowed answers 403 with no consent row`: a fresh user → 403.
  - `telemetry-allowed answers 401 without a token`: GET with no `Authorization` → 401.
- [ ] **Step 2: Run them and confirm they fail**
  Run: `cd services/api && LC_ALL=en_US.UTF-8 TMPDIR=/tmp PG_BIN_DIR=/opt/homebrew/opt/postgresql@17/bin npm run test:postgres -- --test-name-pattern telemetry-allowed`
  Expected: FAIL (404 instead of 204/403).
- [ ] **Step 3: Implement** `tracesAllowed` in `telemetry.ts`, plus one route line in `sync.ts` right after line 399: `a === 'me' && b === 'telemetry-allowed' && m === 'GET'` → `204` if allowed, else `403` with the error above. Use the file's existing `send` and error helpers. Do not add it to the `telemetryCalls` budget: the gate's `limit_req` already bounds it.
- [ ] **Step 4: Run the tests and confirm they pass**
  Run: the same command as Step 2. Expected: 4 passing. Then run the whole `telemetry.test.ts` and confirm it is green. (The WebP test failing locally is known and unrelated.)
- [ ] **Step 5: Commit**
  `git add services/api/src/api/telemetry.ts services/api/src/api/sync.ts services/api/test/telemetry.test.ts && git commit -m "api: GET /v1/me/telemetry-allowed tells the gate who may send traces"`

### Task 2: API gate publishes the relay behind the consent check (admin repo)

**Files:**
- Modify: `services/gateway/api-gate.conf` (new locations before `location ^~ /v1/` at line 49)
- Modify: `tests/tools/api-gate-check.sh`

**Interfaces:**
- Consumes: Task 1's `GET /v1/me/telemetry-allowed`.
- Produces: the public `GET /relay/health` (no auth, passes to relay `/health`) and `POST /relay/v1/traces` (auth, passes to relay `/v1/traces`). Task 4 builds its URLs on these.

- [ ] **Step 1: Write the failing checks** in `api-gate-check.sh`, using its `want` helper:
  - `want 200 "$BASE/relay/health"`
  - `want 401 -X POST --data x "$BASE/relay/v1/traces"` (no token)
  - `want 401 -X POST -H "Authorization: Bearer not-a-token" --data x "$BASE/relay/v1/traces"`
  - `want 404 -X POST --data '{}' "$BASE/relay/laya/predict"`
  - `want 404 "$BASE/relay/"`
  - `want 413 -X POST -H "Authorization: Bearer not-a-token" --data-binary @<(head -c 5000000 /dev/zero) "$BASE/relay/v1/traces"`: the body cap applies before auth.
- [ ] **Step 2: Run against the host gate and confirm the new checks fail**
  Run: `ssh tanmay@tanmay-hp-linux-server 'cd ~/ao-platform && tests/tools/api-gate-check.sh http://127.0.0.1:8183'` (after copying the script there, or run it from the Mac against `https://api.agenticoffice.work`).
  Expected: the new checks FAIL with 404. The old 17 checks still PASS.
- [ ] **Step 3: Add the locations** to `api-gate.conf`:
  - `set $relay http://100.95.14.113:8790;` beside `set $api`, with a comment that this is the tailnet relay (`services/telemetry-relay` in the desktop repo).
  - `location = /relay/health`: `limit_req zone=api_all burst=20 nodelay;` and `proxy_pass $relay/health;`
  - `location = /relay/v1/traces`: `client_max_body_size 4m;`, `limit_req zone=api_all burst=60 nodelay;`, `auth_request /_relay_allowed;`, `proxy_pass $relay/v1/traces;`, `proxy_set_header X-Forwarded-For $remote_addr;`, and `proxy_set_header Authorization "";` so the device token never reaches the relay or Langfuse.
  - `location = /_relay_allowed`: `internal;`, `proxy_method GET;`, `proxy_pass_request_body off;`, `proxy_set_header Content-Length "";`, `proxy_pass $api/v1/me/telemetry-allowed;`, `proxy_set_header X-Forwarded-For $remote_addr;`. The `Authorization` header passes through by default.
  - `location ^~ /relay/ { return 404; }`
  - A `# ponytail:` comment on `/relay/v1/traces`: the API is asked on every export (about one a second per active person). Add `proxy_cache` keyed on the token hash if the API shows the load. Spans are not checked against the token's user (Review Focus 5).
- [ ] **Step 4: Check that the gate container reaches the relay**
  Run: `ssh tanmay@tanmay-hp-linux-server 'docker exec ao-live-api-gate-1 wget -qO- http://100.95.14.113:8790/health'`
  Expected: `{"ok": true}`. If this fails, stop: the gate's network cannot reach the tailnet address. Report it rather than binding the relay to `0.0.0.0`.
- [ ] **Step 5: Validate the config**, then commit
  Run: `docker run --rm -v "$PWD/services/gateway/api-gate.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t`
  Expected: `syntax is ok`. (The `resolver`/upstream names only resolve on the host; a "host not found" warning for `api` is fine here.)
  `git add services/gateway/api-gate.conf tests/tools/api-gate-check.sh && git commit -m "gate: /relay/v1/traces on the public API address, for people who share usage"`

### Task 3: Relay keeps its per-person budget behind the gate (desktop repo)

**Files:**
- Modify: `services/telemetry-relay/relay.py` (`settings_from_env`, `do_POST`'s `budget.take` call)
- Modify: `services/telemetry-relay/README.md` (settings list)
- Test: `services/telemetry-relay/test_relay.py`

**Interfaces:**
- Produces: setting `AO_RELAY_TRUSTED_PROXIES`, a comma-separated list of CIDRs (default empty). When the TCP peer is inside one, the budget key is the last address in `X-Forwarded-For`; otherwise it is the peer address, as today. Task 6 sets it to `172.16.0.0/12` on the host.
- Produces: `def client_key(peer: str, forwarded_for: str | None, trusted: list[ipaddress.IPv4Network | ipaddress.IPv6Network]) -> str` in `relay.py`.

- [ ] **Step 1: Write the failing tests** in `test_relay.py`:
  - `test_forwarded_for_used_from_trusted_peer`: `client_key("172.18.0.5", "203.0.113.7", [ip_network("172.16.0.0/12")]) == "203.0.113.7"`
  - `test_forwarded_for_ignored_from_untrusted_peer`: `client_key("198.51.100.1", "203.0.113.7", [ip_network("172.16.0.0/12")]) == "198.51.100.1"`
  - `test_forwarded_for_takes_last_hop`: `client_key("172.18.0.5", "10.9.9.9, 203.0.113.7", [...]) == "203.0.113.7"`
  - `test_budget_is_per_forwarded_client`: start the relay with settings `trusted_proxies=[ip_network("127.0.0.0/8")]` and patch `relay.PER_MINUTE["/v1/traces"]` to 2 (restore it in `tearDown`). Two posts with `X-Forwarded-For: 203.0.113.7` → 200, the third → 429, then one with `X-Forwarded-For: 203.0.113.8` → 200.
- [ ] **Step 2: Run them and confirm they fail**
  Run: `cd services/telemetry-relay && python3 -m unittest -q test_relay`
  Expected: FAIL (`client_key` not defined).
- [ ] **Step 3: Implement** `client_key` with `ipaddress` (stdlib). `settings_from_env` parses `AO_RELAY_TRUSTED_PROXIES` into `settings["trusted_proxies"]`. `do_POST` passes `client_key(self.client_address[0], self.headers.get("X-Forwarded-For"), trusted)` to `budget.take`. A malformed `X-Forwarded-For` falls back to the peer address. Add the setting to the module docstring and the README list.
- [ ] **Step 4: Run all relay tests and confirm they pass**
  Run: `python3 -m unittest -q test_relay`. Expected: OK, with the 5 old tests and 4 new.
- [ ] **Step 5: Commit**
  `git add services/telemetry-relay && git commit -m "telemetry-relay: per-person budget behind the API gate (AO_RELAY_TRUSTED_PROXIES)"`

### Task 4: Hermes sends traces to the public relay with the device token (desktop repo)

**Files:**
- Modify: `vendor/hermes-agent/gateway/team_telemetry.py:25` (`DEFAULT_RELAY_URL`)
- Modify: `vendor/hermes-agent/plugins/observability/otel/__init__.py:58` (the `OTLPSpanExporter(...)` call)
- Modify: `services/telemetry-relay/README.md` (the last paragraph says the address changes "once the domain exists": now it has)
- Test: `vendor/hermes-agent/tests/plugins/test_otel_plugin.py` (the `_RelayAuth` tests) and `vendor/hermes-agent/tests/gateway/test_team_telemetry.py` (`test_default_relay_is_public`)

**Interfaces:**
- Consumes: Task 2's `https://api.agenticoffice.work/relay/health` and `/relay/v1/traces`; `agent.kernel.state.device_sync.bridge_account(timeout: float) -> dict | None` with keys `server` and `token` (already used in `gateway/platforms/api_server.py:2006`).
- Produces: `DEFAULT_RELAY_URL = "https://api.agenticoffice.work/relay"`. Traces then go to `{url}/v1/traces`, and the health probe to `{url}/health`, with no other change to `apply_relay_defaults`.
- Produces: `class _RelayAuth(requests.auth.AuthBase)` in the otel plugin. `__call__(r)` sets `Authorization: Bearer <token>` from `bridge_account(timeout=0.5)`, caches the account for 60 s, and adds no header when there is none. It is used only when `HERMES_OTEL_VIA_RELAY == "1"`, via `OTLPSpanExporter(..., session=s)` with `s = requests.Session(); s.auth = _RelayAuth()`.

- [ ] **Step 1: Write the failing tests**
  - `test_default_relay_is_public`: `team_telemetry.DEFAULT_RELAY_URL == "https://api.agenticoffice.work/relay"`.
  - `test_relay_auth_adds_bearer`: monkeypatch `bridge_account` to return `{"server": "x", "token": "tok"}`; apply `_RelayAuth()` to a `requests.Request("POST", "http://h").prepare()` → `headers["Authorization"] == "Bearer tok"`.
  - `test_no_account_sends_no_authorization`: `bridge_account` returns `None` → no `Authorization` header, and nothing is raised.
  - `test_bridge_error_sends_no_authorization`: `bridge_account` raises → no header, and nothing is raised.
  - `test_account_cached_60s`: two calls within 60 s → `bridge_account` is called once (monkeypatch `time.monotonic`).
  - `test_no_auth_when_not_via_relay`: with `HERMES_OTEL_VIA_RELAY` unset, the exporter is built without the `session` argument (assert on a stubbed `OTLPSpanExporter`).
- [ ] **Step 2: Run them and confirm they fail**
  Run: `cd vendor/hermes-agent && venv/bin/python -m pytest tests/plugins/test_otel_plugin.py tests/gateway/test_team_telemetry.py -q` (with the `observability` extra installed: `venv/bin/pip install -e ".[observability]"`).
  Expected: FAIL.
- [ ] **Step 3: Implement** the URL change and `_RelayAuth` as described in Interfaces. `requests` comes in with `opentelemetry-exporter-otlp-proto-http`, so this adds no new dependency. Update the comment above `DEFAULT_RELAY_URL` and the relay README's last paragraph.
- [ ] **Step 4: Run the tests and confirm they pass**, then run the existing `team_telemetry` and otel plugin tests and confirm they are still green
  Run: `venv/bin/python -m pytest tests -q -k "otel or team_telemetry"`. Expected: all pass.
- [ ] **Step 5: Commit**
  `git add vendor/hermes-agent services/telemetry-relay/README.md && git commit -m "hermes: traces go to the public relay with the person's device token"`

### Task 5: Packaged app ships tracing and switches the plugin on (desktop repo)

**Files:**
- Modify: `scripts/package/macos/build-dmg.sh:104`: add `--extra observability` next to `--extra mcp`
- Modify: `scripts/package/macos/hermes` (first-run block, after `setup-root.sh` at line ~48)
- Modify: `scripts/hermes/wire-context-layer.py`: add a `--only-otel` mode
- Test: `_selftest()` in `scripts/hermes/wire-context-layer.py` (the existing self-check, run with `WIRE_SELFTEST=1`; add to it)

**Interfaces:**
- Consumes: `wire-context-layer.py`'s existing `_enable_plugin(s: str, name: str) -> str`.
- Produces: `python3 wire-context-layer.py --only-otel <config.yaml>`, which applies only `_enable_plugin(s, "otel")`, keeps `plugins.disabled: [otel]` respected, and prints `changed` or `current`. It leaves context_layer, memory and mcp_servers alone, so packaged behaviour changes in nothing but tracing.

- [ ] **Step 1: Write the failing self-check asserts** in `_selftest()`, for a new `wire_otel_only(s: str) -> str` that `--only-otel` calls:
  - `"plugins:\n  enabled:\n    - otel\n" in wire_otel_only("model: x\n")`, and `"context_layer" not in` the same result.
  - `wire_otel_only("plugins:\n  disabled:\n    - otel\n") == "plugins:\n  disabled:\n    - otel\n"` (disabled by hand stays off).
- [ ] **Step 2: Run the self-check and confirm it fails.** Run: `WIRE_SELFTEST=1 python3 scripts/hermes/wire-context-layer.py`. Expected: `NameError: wire_otel_only`.
- [ ] **Step 3: Implement** the `--only-otel` flag in `main()`. In `scripts/package/macos/hermes`, run `"$PYTHON_BIN" "$R/scripts/hermes/wire-context-layer.py" --only-otel "$PROFILE_HOME/config.yaml" >/dev/null || true` on every launch (it is idempotent), right after the first-run block. In `build-dmg.sh` line 104, use `--extra mcp --extra observability`.
- [ ] **Step 4: Run the self-check and confirm it passes** (`WIRE_SELFTEST=1 python3 scripts/hermes/wire-context-layer.py` → `selftest ok`), then build the DMG and check
  Run: `scripts/package/macos/build-dmg.sh`, then `<app>/Contents/Resources/app/runtime/python/bin/python3 -c "import opentelemetry.exporter.otlp.proto.http"`. Expected: no error.
- [ ] **Step 5: Commit**
  `git add scripts/package/macos scripts/hermes && git commit -m "package: ship OpenTelemetry and switch the otel plugin on, so packaged apps send traces"`
- [ ] **Step 6: Windows packaging.** The script that built Windows 1.127.0 is not on `master` or `ayushkumar320/package`. Ask Ayush or Harshit for it, then make the same two changes there (the `observability` extra and the `--only-otel` call in its launcher). The Windows build doesn't send traces until this is done.

### Task 6: Deploy and prove it end to end

**Files:** none (deploy and verify). Afterwards, log the change in `~/Projects/agentic-office-work-context/80-changes-made.md` and `10-domain.md`.

- [ ] **Step 1: Deploy the admin repo** (API and gate) after its PR merges
  Run: `AO_HOST=tanmay@tanmay-hp-linux-server deploy/scripts/deploy.sh`
  Expected: step 8/8 gate checks all PASS, including the 6 new `/relay` checks.
- [ ] **Step 2: Update the relay on the host**: copy the merged `services/telemetry-relay/relay.py` to `~/ao-relay/relay.py`, add `AO_RELAY_TRUSTED_PROXIES=172.16.0.0/12` to `~/.config/telemetry-relay/relay.env`, and run `systemctl --user restart telemetry-relay`.
  Expected: `systemctl --user is-active telemetry-relay` prints `active`.
- [ ] **Step 3: Public checks from the Mac**
  Run: `curl -s https://api.agenticoffice.work/relay/health` → `{"ok": true}`; `curl -s -o /dev/null -w "%{http_code}" -X POST --data x https://api.agenticoffice.work/relay/v1/traces` → `401`.
- [ ] **Step 4: Relay down.** `systemctl --user stop telemetry-relay`, then POST with a valid sharing token → `502`. Run `systemctl --user start telemetry-relay` again.
- [ ] **Step 5: A real trace from a packaged build** (macOS DMG from Task 5, off Tailscale, signed in, sharing on): send one chat message. In ClickHouse, `SELECT count(), max(start_time) FROM events_core WHERE start_time > now() - INTERVAL 10 MINUTE` should show at least 1. With sharing turned off: send one more and check that no new trace appears.
- [ ] **Step 6: Windows.** Repeat Step 5 with a Windows build that has Task 5 Step 6 in it.
