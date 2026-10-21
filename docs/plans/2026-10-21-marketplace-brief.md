# Agentic Office Extension Marketplace brief

> This is a structured condensation of the 2026-10-21 request "Build the Agentic Office Extension
> Marketplace", not the verbatim text. It was reconstructed from the implementation plan
> ([`docs/superpowers/plans/2026-10-21-extension-marketplace.md`](../superpowers/plans/2026-10-21-extension-marketplace.md)),
> which cites the brief by section number. Section numbers below are the brief's; where the plan
> does not quote a section's detail, only what the plan states is recorded. Nothing here is a new
> requirement. If the original text is recovered, it supersedes this file.

## Goal

One marketplace where users discover, install, configure, create and share templates, skills,
agents, memory, connectors, bridges, surfaces, workflows, hooks, routines and bundles. The admin
console is its publishing and governance plane.

## Type taxonomy (11)

template, skill, agent, memory, connector, bridge, surface, workflow, hook, routine, bundle.

## Requirement sections

| # | Heading (as far as the plan states it) | Key rules |
|---|---|---|
| 1-4 | Foundation: listing identity, versions, catalog, desktop shell | One listing identity with immutable versions in the accounts-sync Postgres; desktop Marketplace tab with Discover, Installed, My Creations, Team Library, Updates and the type categories; activity-bar entry. Reuse existing infrastructure; no second loader, scheduler or identity system. |
| 5 | Templates | Templates feed the existing templates gallery; validated as real OOXML (or PDF) and rendered through OfficeCLI; a zip that is not valid OOXML is never offered; preview is generated. |
| 6 | Skills | Standard `SKILL.md` (agentskills.io) with Agentic Office metadata in a sidecar `agentic.marketplace.json`; install goes through the Hermes skills hub, guard and sync; create, fork, share privately; local edits are never overwritten. |
| 7-8 | Agents / blueprints and builder | Versioned agent blueprint, builder, bundles and team toolkits. Planned (Plan 2). |
| 9-13 | Advanced types | Memory, connectors, bridges, surfaces, workflows, hooks, routines. Each reuses the existing backend (shell hooks, cron, memory plugins, MCP registry, DAG runtime). Planned (Plan 3). |
| 14 | Data model and catalog API | Relational columns carry everything queried (type, publisher, visibility, state, semver, hash); counts and ratings are computed from rows, never seeded or hardcoded; catalog tables are separate from per-user instance tables; no credentials, prompts, sessions, memories or documents in any marketplace table; published versions are immutable and identified by `sha256`. |
| 15 | Install lifecycle and local state | Install is transactional: download, verify sha256, unpack to temp, adapter activate, atomic lockfile write, install event; any failure restores the prior lockfile; never a half-installed item visible to Hermes; the desktop reads only the local install index at startup; offline shows an explicit offline state. |
| 16 | Admin plane | Admin console publishes and governs: catalog, publish wizard, review queue, installations, reviews moderation, analytics, security reports, settings, per-user Marketplace tab. Every mutation checks `can(role, permission)` server-side; every admin action writes `admin_audit`; analytics report telemetry coverage and never imply complete data. |
| 17 | Roles and permissions | `marketplace.read/write/review/moderate`; non-admin and `analyst` get 403 on publish and approve. |
| 18 | Validation per type | One validator per type behind a registry; an unknown or unfinished type returns `type-supported: false` and cannot be published. |
| 19 | Security | Reject zip-slip (`..`, absolute paths), symlinks and archives over 64 MB; a hash mismatch aborts and rolls back; declared permissions are shown before install; scan before publish; a failed scan cannot be published or enabled, even by editing the local lockfile; revoked or quarantined versions are disabled on the next sync with a stated reason; private artifacts are not retrievable by non-owners. |
| 20 | Honesty about scope | Only what works is shown as operational; types not built appear as "not yet available", with no fake listings or placeholder stats. |
| 21 | Acceptance flows | Eight flows; Plan 1 covers 1 to 8 for templates and skills: (1)-(5) discover, install and use a published template and skill end to end; (6) an unsafe skill fails the gate and cannot be activated; (7) an update preserves local edits or offers fork; (8) a skill needing an unconfigured external service shows "needs configuration", not success. A type is not operational until its flow has passed. |
| 22 | Delivery | Phased delivery (A foundation, B templates and skills, C admin core, then D to F); each phase ships working, tested software. |

## Version states

draft, validating, testing, submitted, in_review, approved, published, rejected, deprecated,
quarantined, revoked. Publishing is only valid from `approved`.

## Install states

requested, permission_review, installed, configured, enabled, disabled, update_available, failed,
uninstalled.

## Trust and visibility

Trust shown on cards: official, verified, community, private. Visibility: public, org, team, private.
