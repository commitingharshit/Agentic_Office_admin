# Marketplace Plan 2, Task 9: spike results (D4, D8) and adapter notes

Written instead of editing `docs/reference/agent-blueprint.md`, which Task 0 owns and which does not exist on the integration branch yet; fold this into it at merge.

## D4 confirmed: skills install into the agent profile's own HERMES_HOME

`SkillAdapter(run, <profile dir>)` runs `hermes skills install agentic-marketplace/<id>@<version> --yes` with `HERMES_HOME=<root>/profiles/<profile>`.
The hub state is `<profile>/skills/.hub/lock.json` and the skill tree `<profile>/skills/<name>/`; the shared root home is untouched (the real-Hermes test
asserts `<root>/skills/.hub` does not exist and that `hermes -p <profile> skills list` shows exactly the declared skill). No fallback to the shared
gateway home is needed. The lockfile identity becomes `(id, scope)` with `scope` = `'user'` (default, absent in old files) or `'agent:<listing id>'`.

## D8 confirmed: no chat-window selection

Facts doc row 18 stands: a multiplexing gateway can serve `profiles/<name>`, the chat window's gateway is single-profile. Use is `hermes -p <profile>`
(`AgentAdapter.profileOf(id)` gives the name for the "Open in terminal" action).

## Hermes behaviours the adapter depends on (all exercised against the real CLI in `agentHermes.integration.test.ts`)

- `hermes profile update <name>` re-pulls from the `source:` recorded in `distribution.yaml`, which for a local directory is the resolved absolute path.
  The adapter therefore keeps the staged files at a stable path, `<root>/.agentic-marketplace/agents/<profile>/dist`, and swaps the directory (previous
  one kept until the update succeeds) instead of passing a new path.
- `distribution.yaml` is rewritten by Hermes on install (it adds `source:` and `installed_at:`), so `isActive` compares `name`, `version` and the SOUL.md
  hash recorded in `state.json`, not the file bytes. The compiler's `distribution.yaml` has no artifact hash field; the artifact sha256 lives in `state.json`.
- Upgrade = `hermes profile update <name> --force-config --yes`: local edits to `config.yaml` are replaced (the install plan must say so); `memories/`,
  `sessions/`, `.env`, `auth.json` are untouched. A first install never uses `--force`; an existing profile that is not ours is refused.
- Tombstone = `hermes blueprint compile` with `disabled_reason` from the stored blueprint (`package.json` next to `state.json`), staged and applied with the
  same `update --force-config`; its skills are removed through `SkillAdapter.deactivate`. Re-activation is an ordinary `activate` (update path).
- Deleting data is `hermes profile delete <name> --yes`, only when `deactivate` receives `deleteData: true`.
