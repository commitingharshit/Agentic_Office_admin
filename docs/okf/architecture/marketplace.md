---
type: Reference
title: "Extension marketplace"
description: "The 11-type taxonomy, the version and install state machines, and the existing infrastructure each type reuses; only templates and skills are in the first plan."
tags: [marketplace, hermes, mcp, accounts]
timestamp: 2026-10-21T00:00:00Z
---

Status: **planned, not yet operational.** Plan 1 builds templates and skills end to end with the
admin console; every other type is planned and is not operational. The desktop must show unbuilt
categories as "not yet available", never as empty or fake listings.

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
| connector | 3 | OAuth through Better Auth |
| bridge | 3 | `mcp/registry.json` |
| surface | 3 | not yet decided |
| workflow | 3 | `services/dag-runtime` |
| hook | 3 | `agent/shell_hooks.py` |
| routine | 3 | `cron/` scheduler |

# Version states

`draft`, `validating`, `testing`, `submitted`, `in_review`, `approved`, `published`, `rejected`,
`deprecated`, `quarantined`, `revoked`. Publishing is only valid from `approved`. A published
version is immutable (identity is its `sha256`); `quarantined` and `revoked` are reported to
installed clients on the next sync.

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

Everything in this concept is a design; no marketplace code, table or route exists. Plan 1 will
add the first slice (templates and skills); agents, bundles, memory, connectors, bridges, surfaces,
workflows, hooks and routines are planned in later plans.

# Citations

- [`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](/../docs/superpowers/plans/2026-10-21-extension-marketplace.md)
- [`docs/plans/2026-10-21-marketplace-brief.md`](/../docs/plans/2026-10-21-marketplace-brief.md)
