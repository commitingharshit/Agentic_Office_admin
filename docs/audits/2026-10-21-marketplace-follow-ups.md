# Marketplace follow-ups (what the shorter path deliberately left)

Chosen by the user on 2026-10-21: finish and verify what is usable now, document the rest. Nothing below is claimed as working.
Source of truth for what works today: `marketplace-truth-table.md`, `2026-10-21-marketplace-acceptance.md`, `2026-10-21-marketplace-final-verification.md`.

## Plan 2 (agents, bundles) — server side done, desktop side not
- Desktop agent adapter is not registered in `advancedAdapters.ts`; no bundle install transaction; no publish→install e2e. `AGENT_BUNDLE_INSTALLABLE=false` keeps agent and bundle unsupported.
- Tasks not started: T8 (fixtures and eval corpora for blueprint/bundle validators), T10 (desktop bundle transaction, policy gate, assignments sync, testAgent), T12 (builder wiring: test agent, dependency graph, save, publish), T13 (Team Library / bundle detail UI), T14 (admin pages patch for agents), T15 (acceptance flows A1 to A8).
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
- Admin console pages ship as a patch (`marketplace-admin-pages.patch`) for the control-plane tree, which is not on master; needs `marketplace.*` permissions in its `rbac.ts` and `AO_MARKETPLACE_ROLES` on the API.
- Known pre-existing desktop unit failures on master (24: ClaudeAgent 16, AgentSideEffects 7, ChatModeService 1) are unrelated.
- Discover search box and chips still say "templates and skills".
