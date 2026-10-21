# Marketplace release readiness (Plan 4 Task 19, written 2026-10-21)

Status of the three marketplace-owned migrations, rollback, kill switches and open items. Nothing here is a claim that a release
is ready: it lists what is verified and what a person must still do.

## Migrations

- Marketplace migrations on this branch: `0021_marketplace` to `0028_marketplace_type_policy_admin` (renumbered once already by
  `18f14c30d`; two files may not share a number, `test/migration-numbers.test.ts`). Gaps in the numbering are allowed: other branches
  reserve ranges (growth took 0029 and 0030; a branch that adds migrations must pick the next free number at merge, or 0040 and up).
- `test/marketplace-migrations.test.ts` asserts the marketplace migrations are 0021 to 0028, that each has exactly one rollback
  script in `db/rollback/`, and, on a real embedded Postgres, that the chain rolls back in reverse order leaving no `marketplace_*`
  table, function or view, and applies again. It was mutation-checked (a rollback script with its `DROP TABLE` removed fails it).
- `test/marketplace-migrations-compose.test.ts` (existing) guards silent function overwrites between migrations.
- The full `0001..N` chain against a real pgvector Postgres: run with `scripts/dev/marketplace-gates.sh --only postgres` (it starts a
  throwaway `pgvector/pgvector:pg17` container when no local pgvector Postgres exists). The result of the run for this branch is in
  `2026-10-21-marketplace-plan34-followup-acceptance.md`.
- A database that applied an earlier draft of the marketplace migrations (before they were edited in place) must be recreated. No such
  database is known outside developer machines; this was not verified against the control-plane beta host (ask, do not assume).

## Rollback

- Database: deploy the previous API image first (the tables are unused by it), then run `db/rollback/00NN_*.down.sql` in reverse number
  order, each in a transaction, and delete the matching row from `schema_migrations`. The scripts drop data in the objects they name.
  One residue: `0024` also added CHECK constraints and indexes that the rollback leaves in place (they are additive and harmless).
  Published versions are immutable, so the only "un-publish" is `revoked`.
- Client: the lockfile is `version: 1` and unknown fields are preserved, so an older app ignores newer fields. Uninstalling the
  Marketplace contribution leaves installed skills working in Hermes (they are ordinary hub-installed skills with provenance).
- Kill switches: unset `AGENTICOFFICE_MARKETPLACE_URL` hides the connection; `VERIFY_WORKER=off` makes the heavy verification stages
  skip; `marketplace_settings.verification_required_types` can be emptied (audited) to stop gating approvals; `OPERATIONAL` flags are
  fail-closed and a type with `supported:false` is not installable.

## What is operational

Generated from the tree by `node scripts/dev/marketplace-truth-table.mjs` (validator, pipeline, adapter, evidence, operational per
type). Hook scripts, OAuth connectors and surfaces are not operational; the table says so. Only template and skill have a verification
pipeline.

## Open items

- `skills_guard.py` policy (block medium findings, read every file type for every source) is a plan-level user decision (ruling R27) and
  stays out of scope: it changes behaviour for every skill source.
- Real browser OAuth sign-in cannot be scripted here: the residual manual check is documented in Plan 4 Task 16.
- Not run in this follow-up: the real-window flows (no Electron build on this machine; see the acceptance record), the screenshot pass,
  a live render of the admin pages, skill task evaluations against a real model (no credentials), the visual comparator calibration.
- `marketplace.*` permissions must be in the control-plane role map for the console nav to show the pages.
- Second-instance rate limiting remains a documented limit (single instance).
