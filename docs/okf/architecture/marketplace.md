---
type: Reference
title: "Extension marketplace"
description: "The 11-type taxonomy, the version and install state machines, which types are operational (and which are not, with evidence) and the infrastructure each type reuses."
tags: [marketplace, hermes, mcp, accounts]
timestamp: 2026-10-21T00:00:00Z
---

Status: **operational types are decided by `OPERATIONAL` in `services/accounts-sync/src/marketplace/support.ts`, each backed by
an end-to-end evidence record** (see [`docs/audits/marketplace-truth-table.md`](/../docs/audits/marketplace-truth-table.md) and the
enforcement test `test/marketplace-enablement.test.ts`). Operational: template, skill, routine, memory, hook (declarative mode only),
bridge, connector (none, api_key, bearer; not oauth2), workflow, agent and bundle (install and use from the marketplace only; evidence in
`docs/audits/marketplace-type-evidence/agent.json` and `bundle.json`; `GET /capabilities` reports them supported only while the blueprint compiler's
startup self-check passed). NOT operational: surface (no sandbox), hook scripts and oauth2 connectors. For agents and bundles the Agent Builder is wired to
save, test (hermetic dry run) and publish from My Creations (`workbench.action.marketplace.createAgent`), and the console has review pages for them
(`services/control-plane`, see [`docs/audits/marketplace-admin-pages.md`](/../docs/audits/marketplace-admin-pages.md)); the Team Library UI is
tracked separately (acceptance: [`docs/audits/2026-10-21-marketplace-plan2-acceptance.md`](/../docs/audits/2026-10-21-marketplace-plan2-acceptance.md)). The
desktop reads `GET /v1/marketplace/capabilities` to decide which Discover categories are available; anything it cannot read or does not
recognise stays "Not available yet". The admin web pages are committed in `services/control-plane` ([`docs/audits/marketplace-admin-pages.md`](/../docs/audits/marketplace-admin-pages.md));
they show the permissions that `GET /admin/marketplace/me` reports and set `AO_MARKETPLACE_ROLES` on the API.

One listing identity with immutable, content-hashed versions lives in the accounts-sync Postgres
([service](/architecture/marketplace-service.md)). The desktop gets one Marketplace editor tab and a local
install index. Install adapters hand off to infrastructure that already exists; the marketplace
adds no second loader, scheduler or identity system.

# Taxonomy

| Type | Plan | Target backend |
|---|---|---|
| template | 1 | templates gallery (`officeTemplates`) |
| skill | 1 | Hermes skills hub, guard and sync |
| agent | 2 | agent blueprints |
| bundle | 2 | a set of other listings |
| memory | 3 | `plugins/memory/*` providers |
| connector | 3 | none / api_key / bearer through the bridge path; oauth2 needs a token broker (not built) |
| bridge | 3 | `mcp/registry.json` |
| surface | 3 | not yet decided |
| workflow | 3 | `services/dag-runtime` |
| hook | 3 | `agent/shell_hooks.py` |
| routine | 3 | `cron/` scheduler |

# Version states

`draft`, `validating`, `testing`, `submitted`, `in_review`, `approved`, `published`, `rejected`,
`deprecated`, `quarantined`, `revoked`. A published version is immutable (identity is its `sha256`).
Two ways to `published`:

- **Creator path** (private or team audience): the server validates the upload and, when the report is
  verified (the skill scanner ran), publishes it automatically to the owner or team. No admin looks at it.
  Without a scanner it stays `submitted`; a failed check stores it `rejected`.
- **Admin review path**: `submitted` -> (claim) -> `approved` -> `published`, each step by an admin. This is
  the only way a listing becomes public: the `publish` action with `visibility: "public"` flips an existing
  listing, and only when every installable version of it has an admin `approved` event (409
  `unreviewed_versions` otherwise). An admin submission never changes an existing listing's visibility.

`deprecated` versions stay installable (they are only de-emphasised). `quarantined` and `revoked` versions
are not installable and download as 410.

# Revocation: what is actually built

A pulled version reaches clients in three ways: (1) `POST installs/sync` returns `updates` entries with
`revoked: true` for every install row of the device whose version is `revoked` or `quarantined`; (2) the same
response also carries such an entry for every `versionId` the device reported in the request even if it has no
install row (a failed first sync), derived from `marketplace_version_status()`; (3) a signed-out client may
`POST versions/status` with up to 200 ids and gets states only. The desktop checks when the user opens the
Marketplace and on sync; Hermes does not re-check by itself. A device that never syncs and never opens the
tab keeps running its local copy until it does. Known limitation: when a team member loses access (removal or
leaving), their installed copies persist locally; only the listing's visibility changes. An owner can withdraw
a version (state `revoked`, reason "withdrawn by owner") or delete a private or team listing nobody else has
installed.

# Install states

`requested`, `permission_review`, `installed`, `configured`, `enabled`, `disabled`,
`update_available`, `failed`, `uninstalled`. Install is transactional (download, verify hash,
unpack to temp, adapter activate, atomic lockfile write); a failure restores the prior lockfile.
The local index is `~/.agentic-office/marketplace/installed.lock.json`.

# Reuse, not rebuild

| Need | Existing piece |
|---|---|
| Templates hub | `contrib/officeTemplates`, `templates/catalog.json`, OfficeCLI thumbnails |
| Skills | `vendor/hermes-agent/tools/skills_hub.py`, `skills_guard.py`, `skills_sync.py` (skips user-modified skills) |
| Hooks | `agent/shell_hooks.py` consent allowlist |
| Routines | `vendor/hermes-agent/cron/` |
| Memory | `plugins/memory/*` |
| MCP / bridges | `mcp/registry.json` |
| Workflows | `services/dag-runtime`, `agent/office/orchestration` |
| Auth, users, plans | accounts-sync tables and Better Auth ([identity](/architecture/identity.md)) |
| Admin authz and UI | `src/api/rbac.ts`, control-plane `admin/*` components |

# Not built yet

The Team Library UI for bundles and assignments, live Hermes capabilities in the Agent Builder (it shows the built-in lists), surfaces, hook scripts, oauth2 connectors,
the Configure/Grant UI for advanced types (in progress as a separate step), org visibility,
payments, and revocation of an advanced item inside an already-running process for every type (bridge, connector, hook and workflow have
it with e2e evidence; see the truth table).

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`docs/plans/2026-10-21-marketplace-brief.md`](/../docs/plans/2026-10-21-marketplace-brief.md)
