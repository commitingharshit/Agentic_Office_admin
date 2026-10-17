# Agentic Office data plane

Postgres 17 (+pgvector, pg_stat_statements) and MinIO, with a nightly
`pg_dump` mirrored into MinIO (`ao-backups/pg/`, `LATEST` names the newest).
Every port binds to `BIND_IP` only: the host's **Tailscale IP** in production,
`127.0.0.1` for local tests. Postgres and MinIO are never public; only the
accounts/sync API is (behind TLS).

MinIO no longer publishes images (Docker Hub and quay refuse them); the
compose file uses Chainguard's build of the same AGPL source, pinned by digest.

## Deploy (harshit-windows-coding, Docker Desktop)

1. Copy this folder to the host, then `copy .env.example .env` and fill it:
   `BIND_IP=100.94.155.4`, and long random values for every password
   (`openssl rand -hex 24`). Keep `.env` on the host only.
2. `docker compose -p ao-data up -d`
3. From any tailnet machine, with `services/accounts-sync/` checked out:
   ```bash
   cd server && npm install
   DATABASE_URL=postgres://ao_owner:<PG_OWNER_PASSWORD>@100.94.155.4:5432/agentic_office \
   AO_APP_PASSWORD=… AO_READONLY_PASSWORD=… AO_ADMIN_PASSWORD=… npm run migrate
   AO_TEST_PG=postgres://ao_owner:…@100.94.155.4:5432/agentic_office AO_APP_PASSWORD=… \
   AO_READONLY_PASSWORD=… AO_ADMIN_PASSWORD=… npm test
   ```
4. Windows firewall: allow 5432/9000/9001 inbound on the Tailscale interface
   only.

## Roles

| Role | Used by | Can |
|---|---|---|
| `ao_owner` | migrations | everything (never handed to a service) |
| `ao_app` | accounts/sync API | its own rows only (RLS on `app.user_id`) |
| `ao_readonly` | SQL runner, Admin Console views | read all metadata; no event payloads; read-only, 30 s timeout |
| `ao_admin` | admin API actions | act across users; `admin_audit` is insert-only |

## Restore drill

```bash
docker compose -p ao-data exec backup bash -c 'createdb restore_check && pg_restore -d restore_check /backups/$(cat /backups/LATEST) && psql -d restore_check -c "select count(*) from users" && dropdb restore_check'
```

## Windows host over SSH (harshit-windows-coding)
SSH in as `tanmaykumar@100.94.155.4`; the stack lives in `C:\Users\tanmaykumar\ao-data`.
- Docker Desktop must be started from the desktop session: started over SSH it exits when the session closes.
- `docker pull` fails over SSH ("A specified logon session does not exist"): the Windows credential store needs an
  interactive logon. Pull `--platform linux/amd64` on another machine, `docker save`, copy, `docker load`.
  Digest references do not survive the load, so the MinIO images are tagged `ao-local/minio:cg-<digest8>` and
  `ao-local/minio-client:cg-<digest8>` and selected by a host-only `docker-compose.override.yml`.
- Run docker commands with `DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine`.

## Admin API (the Admin Console's backend)
`api` in the compose file runs `services/accounts-sync/src/api/main.ts` on `${BIND_IP}:8787` (Tailscale only until the public
API exists). It reads as `ao_readonly`, acts as `ao_admin`, and writes every view, action and SQL query to
`admin_audit` before doing it. Until Clerk admin sign-in is wired, admins authenticate with a bearer token
from `AO_ADMIN_TOKENS=name:token` (24+ characters; only its hash is kept in memory). `CLERK_SECRET_KEY` is
optional: with it, "Force sign-out" revokes the user's Clerk sessions. On the Windows host `AO_SERVER_DIR=./server`
holds `api/`, `node_modules/` and `package.json`; the `node:24.15.0-alpine` image is loaded from a tar like the others.
Tests: `npm test` (schema + admin API) with `AO_TEST_PG` and, for blob deletion, `AO_TEST_MINIO`.

## Sync API (devices)
`/v1/*` on the same process: devices sign in with a Clerk session token (verified against the instance's
JWKS, found from `CLERK_PUBLISHABLE_KEY`), are mapped to our own `usr_…` id, and every request runs as
`ao_app` with `app.user_id` set, so row-level security scopes it. Routes: `POST /v1/session`, `GET /v1/me`,
`PUT /v1/devices/:id`, `GET|PUT /v1/workspaces[/:id]`, `GET|PUT /v1/sessions[/:id]`, `POST|GET /v1/events`
(idempotent by `event_id`, ordered per session), `PUT|GET /v1/blobs/:sha256` (encrypted bytes, checked against
their hash, stored under `ao-user-blobs/<user>/`), `POST /v1/revisions` + `GET /v1/revisions/:doc` (next
revision must be latest + 1, else 409 with `latest`), `GET|PUT|DELETE /v1/memory[/:id]`, `GET|PUT
/v1/cursors/:device/:stream`. Clerk dashboard → Sessions → Customize session token:
`{"email":"{{user.primary_email_address}}","name":"{{user.full_name}}","role":"{{user.public_metadata.role}}"}`.

Desktop sign-in (the app's status bar → Sign in): `GET /v1/auth/config` gives the app the publishable key; the
app opens Clerk's sign-in page in the browser, which returns to a one-off `127.0.0.1` page in the app that posts
the Clerk session token back; the app swaps it at `POST /v1/auth/exchange` for a device token (`aod_…`, 90 days,
sliding; only its SHA-256 is stored in `device_tokens`). The app keeps it in the OS keychain and sends it like a
Clerk token. `POST /v1/auth/signout` ends that device; the Admin Console's Force sign-out ends every device and
the user's Clerk sessions; a disabled account is refused within a minute. Production Clerk instances only accept
their own domain, so before release the return page moves to the public API host.

## Backups: dumps, base backups, WAL, and the weekly restore drill
- `backup` (daily): a `pg_dump` plus a physical base backup in `/backups/base/<ts>.tar.gz` and `.label`. The base
  backup uses the low-level API (`pg_backup_start`, then a tar of the read-only `pgdata` mount, then
  `pg_backup_stop`), so it needs no replication slot or `pg_hba` change.
- `postgres` archives every WAL segment into `/backups/wal` (`archive_mode=on`, `archive_timeout=300`).
  Base + WAL restore to any point after the base, not just the nightly dump.
- `backup-mirror` copies all of `/backups` to MinIO `ao-backups/pg/`. It runs as root in its container: WAL
  files are 0600 to the postgres user, and when it could not read them it stopped mirroring everything.
- `restore-drill` (weekly; `DRILL_EVERY_SECONDS`): restores the newest base + WAL into a throwaway Postgres
  started with the primary's `max_connections` (recovery refuses a lower one), waits for promotion, counts
  users, and writes `/backups/drills/LATEST.json`. Admin Console → System health shows the drill with WAL and
  base-backup status; the card turns "Needs attention" when any of them is missing or stale.
- Verified on the test stack: a row committed after the base backup was present in the restore. (Commit
  before `pg_switch_wal()`: in one `psql -c` they are a single transaction, so the commit lands in the next
  segment.)
