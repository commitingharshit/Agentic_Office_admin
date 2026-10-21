# Marketplace truth table (2026-10-21, ship step A)

Source of truth in code: `OPERATIONAL` in `services/accounts-sync/src/marketplace/support.ts`, served by `GET /v1/marketplace/capabilities`.
`services/accounts-sync/test/marketplace-enablement.test.ts` fails if a type is operational without a valid passing evidence record, or has one and
is unsupported without a `heldBack` reason. All evidence below was regenerated on this tree against the real capabilities endpoint (no harness override).

"Window" means a human clicking in the Agentic Office window. The Marketplace window can browse, show details and install every operational type;
the Configure and Grant screens for advanced types are not delivered yet (ship-b), so anything that needs them is exercised only through the
installer/adapter API in the flows.

| Type | Operational | Evidence | What works | What does NOT work | Gaps |
|---|---|---|---|---|---|
| template | yes | real-window flow (12/12), `scripts/e2e/plan/marketplace-flow.mjs` | publish through validators, browse, install, appear in the Templates gallery, Use creates an editable file byte-identical to the package | | preview-fidelity check skipped for docx (pixel compare does not discriminate) |
| skill | yes | same flow | install into a real Hermes (throwaway home), list, uninstall; scanner gates publish | | Skills Guard may pass medium findings in its own verdict; the marketplace path blocks any finding |
| routine | yes | `docs/audits/marketplace-type-evidence/routine.json` | publish via admin flow, install with native confirmation, configure, one managed cron job, scheduler tick fires it, uninstall removes it, server revoke removes it | | no real model run (a fake model proves the scheduler); no window evidence; configure screen not delivered |
| memory | yes | `docs/audits/marketplace-evidence/memory.json` | binds a bundled Hermes memory provider, replace-with-consent, restore on uninstall/revoke, needs-configuration reported | | server-side revoke delivery to the binding and gateway pickup not exercised (restart_required is reported, not simulated); consent UI not delivered |
| hook | yes, declarative only | `docs/audits/marketplace-type-evidence.hook.json` | 22 steps with a real gateway: block works, revoke without restart, uninstall clean, hostile hook (deny every tool) refused | **hook scripts are unsupported** (need an OS sandbox) | reconcile of hooks through hermes (general revocation task) not exercised; before_document_edit is derived and reported as such |
| bridge | yes | `docs/audits/marketplace-type-evidence.bridge.json` | remote https MCP only; installed is not granted; grant exposes exactly the declared tools; revoke blocks the next call in a running process; production mode refuses loopback | local stdio bridges; anything without a grant | DNS-rebinding documented as residual; grant UI not delivered |
| connector | yes: none, api_key, bearer | `docs/audits/marketplace-type-evidence.connector.json` (mode api_key) | install says needs configuration, wrong key reported failed (never faked), secret only in keychain and the managed env block, grant-only exposure, revoke blocks next call | **oauth2 is unsupported** (no token broker) | `none` and `bearer` are marked operational but have no end-to-end run, only validator and Hermes unit tests (listed in `unitOnlyModes`); configure UI not delivered |
| workflow | yes | `docs/audits/marketplace-type-evidence/workflow.json` | real `dag_runtime serve`: runtime down says "DAG runtime not running", up runs to succeeded, bad parameters refused, revoke refuses next run | agent-node workflows | tool server in the flow is a stub docx server; cancelling an in-flight run on revoke not exercised; needs the DAG runtime to be running on the machine |
| surface | no | none | | everything: a surface is in-gateway code holding account credentials with no sandbox | needs sandbox + token broker |
| agent | yes (when the server's compiler self-check passed) | `docs/audits/marketplace-type-evidence/agent.json` | install and use from the Marketplace through the real handlers, the real compiler and the real hermes CLI: profile with compiled config, skills scoped to the agent, update with force-config keeps memories, test agent (hermetic dry run), server revoke tombstones it, uninstall with data confirmation | **the Agent Builder form is not wired to save, test or publish; there is no Team Library UI for agents; no admin pages for agents** | declared-only components (e.g. schedulingPolicy) are listed as unsupported, not run; no window evidence; no real SIGKILL |
| bundle | yes (same condition) | `docs/audits/marketplace-type-evidence/bundle.json` | atomic install of {skill, agent}; a kill mid-bundle is rolled back by `recover()` and a retry succeeds; `uninstallBundle` removes exactly the members; the org policy gate blocks a denied member with the stated reason and installs nothing; a withdrawn member disables the bundle and every member through the unified revoke path | no Team Library UI, no admin pages for bundles; bundles have no category of their own in the nav | the kill is simulated at a seam; policy in the flow is a served deny-agent document; dependency revoke is exercised through the anonymous reconcile |

## UI honesty

Discover's category navigation reads `GET /capabilities` (fail-closed: unreadable or malformed means every advanced category says "Not available yet").
The Agents category is available only when capabilities report `agent` supported (the server needs the compiler self-check to have passed); Surfaces have no install adapter on the desktop and stay "Not available yet" whatever a server reports. Known leftovers in files owned by
ship-b (`views/`): the Discover chips offer only All, Templates and Skills and the search placeholder says "Search templates and skills", so advanced
types are reached through the category list, not the chips.

## Dev-environment notes seen during verification

- The Installed view of the demo shows "Update status was not checked: server answered 404" (the dev server serves the catalog and install routes but the demo device is not registered for sync). Not investigated.
- A worktree without the built-in extensions logs "Activating extension ... failed" toasts in the demo window; unrelated to the marketplace.
