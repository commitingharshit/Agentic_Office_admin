---
type: Architecture
title: Identity
description: Every user table, token type, migration and client-side credential store in the repo, and where each piece of sign-in code lives after the W4 reorganisation.
resource: services/accounts-sync/src/auth/
tags: [identity, auth, accounts, collab, clerk, sync]
timestamp: 2026-10-17T00:00:00Z
---

Two account stores exist today. Phase 2 of the reorganisation merges the second into the first.

## Account stores

| Store | Where | Tables | Migrations | Keyed by |
|---|---|---|---|---|
| **accounts-sync** (primary) | Postgres, `services/accounts-sync` | `users`, `oauth_accounts`, `devices`, `device_tokens`, `sessions`, `session_events`, `workspaces`, `document_revisions`, `memory_references`, `agent_runs`, `device_metrics`, `sync_cursors`, `admin_audit`; view `admin_user_overview` | versioned, `db/migrations/0001…0005_*.sql`, applied once each by `db/migrate.ts` | `users.id` = `usr_<ulid>` (ours); `clerk_user_id` unique |
| **collab** (phase-2 merge) | SQLite `accounts.db`, `services/collab/src/accounts/store.ts` | `accounts`, `refresh_tokens`, `room_members`, `invites` | none: `CREATE TABLE IF NOT EXISTS` at start | `accounts.id`; `firebase_uid` holds `clerk:<user id>` for Clerk sign-ins |
| ~~Go gateway~~ | archived (`archive/collab-gateway-go`, W0) | its own `users` table | — | — |

Postgres roles: `ao_app` (row-level security, `own_rows`/`own_user` policies), `ao_readonly` and
`ao_admin` (both `BYPASSRLS`; admin writes are audited in `admin_audit`).

## Token types

| Token | Issued by | Verified by | Lifetime | Stored by the client |
|---|---|---|---|---|
| Clerk session JWT | Clerk (Google/Microsoft/GitHub/email) | `services/accounts-sync/src/auth/clerk.ts` (JWKS from the publishable key, `azp` pinned) and, separately, `services/collab/src/accounts/clerk.ts` | Clerk's session | not kept: exchanged at once |
| Device token `aod_…` (row `dtk_<ulid>`) | accounts-sync `POST /v1/auth/exchange` | `src/api/sync.ts` (hash lookup in `device_tokens`) | 90 days, sliding on use | VS Code SecretStorage (docx extension `account/account.ts`) |
| Admin bearer token | `AO_ADMIN_TOKENS` env (`name:token`) | `src/api/admin.ts` | until rotated | admin's own |
| Collab access token `a.…` | collab server (auth code + PKCE to a loopback redirect) | collab | 15 min | memory |
| Collab refresh token | collab server | collab (`refresh_tokens`, rotating, reuse detection by family) | 60 days | VS Code SecretStorage per server (`account/collabSignIn.ts`) |
| Room session token | collab `/api/rooms/:id/agents/*` (HMAC-signed, stateless) | collab hub; also the Hocuspocus websocket token | 12 h, refreshable | collab-mcp / the editor session |
| Agent delegation | minted by the human for their Assistant | collab hub, single use | one join | `~/.agentic-office/collab/delegations/<room>.json` (0600) |
| Invite code | collab | collab (hash stored) | 7 days, revocable | link only |
| Editor bridge token | the docx extension | its local bridge (`/data/*`) | per launch | `~/.agentic-office/data-bridge.token`; the Hermes kernel reads it to ask who is signed in (`agent/kernel/state/device_sync.py`) |

## Where sign-in code lives

- **Server:** `services/accounts-sync/src/auth/` (the Clerk verifier). Collab's account module
  (`services/collab/src/accounts/`) keeps its own verifier and tokens until phase 2; its README
  says so.
- **Client:** one module in the docx extension, `apps/editors/docx/extension/src/account/`:
  `account.ts` (desktop sign-in → device token, per-user data root `~/.agentic-office/users/<id>/`)
  and `collabSignIn.ts` (collab server sign-in). The xlsx, pptx and pdf extensions have no
  sign-in of their own, so nothing is shared with them yet and it stays in the extension rather
  than in `packages/`.
- **Window:** `apps/desktop/src/vs/workbench/contrib/agenticOffice/browser/account.contribution.ts`
  draws the account in the Accounts menu from what the extension reports.

## Phase 2 (separate plan)

Collab's `accounts.db` → Postgres in accounts-sync with versioned migrations; one Clerk verifier;
collab keeps only room-scoped state (session tokens, delegations, members/invites keyed by
`users.id`).

# Citations

- [`services/accounts-sync/db/migrations/`](/../services/accounts-sync/db/migrations/)
- [`services/accounts-sync/src/api/sync.ts`](/../services/accounts-sync/src/api/sync.ts), [`admin.ts`](/../services/accounts-sync/src/api/admin.ts), [`src/auth/clerk.ts`](/../services/accounts-sync/src/auth/clerk.ts)
- [`services/collab/src/accounts/store.ts`](/../services/collab/src/accounts/store.ts), [`docs/reference/COLLABORATION_BACKEND.md`](/../docs/reference/COLLABORATION_BACKEND.md) §8
- [`apps/editors/docx/extension/src/account/`](/../apps/editors/docx/extension/src/account/)
- [`vendor/hermes-agent/agent/kernel/state/device_sync.py`](/../vendor/hermes-agent/agent/kernel/state/device_sync.py)
