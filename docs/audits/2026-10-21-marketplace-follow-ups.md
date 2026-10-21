# Marketplace follow-ups (what the shorter path deliberately left)

Chosen by the user on 2026-10-21: finish and verify what is usable now, document the rest. Nothing below is claimed as working.
Source of truth for what works today: `marketplace-truth-table.md`, `2026-10-21-marketplace-acceptance.md`, `2026-10-21-marketplace-final-verification.md`.

## Plan 2 (agents, bundles) — server side done, desktop side not
- Update: the agent adapter is registered, the bundle transaction, policy gate, assignments sync and the publish-to-install flow exist (T10), and agent and bundle are operational for install and use from the marketplace (T15, evidence `marketplace-type-evidence/agent.json`, `bundle.json`). The `AGENT_BUNDLE_INSTALLABLE` hold-back is gone; support still needs the server's compiler self-check.
- Update (Plan 2 follow-up, 2026-10-21): T12 builder wiring (test agent on a draft, dependency graph, save, publish), T14 admin pages (committed in services/control-plane) and T15 acceptance (`2026-10-21-marketplace-plan2-acceptance.md`) are done. T13 (Team Library / bundle detail / installed agent UI) is tracked on another branch. T8 and T10 exist in code (fixtures, corpora, bundle transaction, policy gate); their entries here were stale.
- Open design points: bundle `permissions-union` rejects wildcard scopes; dry run lacks child blueprints and `declared` capabilities; skill trees over about 640 KiB drop out of the dry run; the lockfile `(id, scope)` helpers must replace id-only lookups (~15 places in `marketplaceInstaller.ts`) before agent-scoped skills are recorded.

## Plan 3 (advanced types) — six types operational, rest open
- Not started: T10 hook scripts (needs an OS sandbox; stays unsupported), T11 remaining UI (bridge/workflow-run/memory-replace screens have unit tests only), T12 admin API and pages for the new types, T13 eval runner, T14 revocation integration (reconcile calls `adapter.revoke()` for types that have one; memory has no revoke API; hook handler ledger entry lacks `artifact_sha256`).
- Surfaces stay unsupported (no sandbox). OAuth connectors stay unsupported (no token broker: separate plan). `bearer`/`none` connector modes have unit coverage only.
- `max_rpm` / `max_response_kb` are recorded but not enforced (Hermes has no per-server limiter). Enable/Disable for non-skill types only flips the lockfile flag.

## Plan 4 (verification, polish) — framework, template and skill static pipelines, worker, hardening, perf harness done
- Not started: T6 skill task evaluations (needs real Hermes plus a model; opt-in), T7 pipeline eval corpus and calibration, T13/T14 verification display in desktop and admin, T16 live-verification gaps (native confirmation dialog needs macOS Accessibility; signed-in gate), T17 full screenshot pass, T18 CI-form acceptance gates, T19 release readiness.
- `verification_required_types` is empty by default (a deployment decision); enabling a type with no registered pipeline makes it unpublishable. PDF, docx and xlsx templates end `incomplete` until a visual comparator exists. Linux sandbox containment is documented, not verified.

## Cross-cutting
- Migrations 0016 to 0024 must be renumbered against the other session's 0006 to 0015 at merge time (the compose test guards silent function overwrites).
- Admin console pages are committed in `services/control-plane` (the overlay patch was applied and removed). They need `AO_MARKETPLACE_ROLES` on the API; permissions come from `GET /admin/marketplace/me`. The Plan 3 overlay `marketplace-admin-pages-advanced.patch` no longer applies cleanly (nav.ts, admin-api.ts and actions.ts moved); re-apply it by hand.
- Known pre-existing desktop unit failures on master (24: ClaudeAgent 16, AgentSideEffects 7, ChatModeService 1) are unrelated.
- Discover search box and chips still say "templates and skills".
