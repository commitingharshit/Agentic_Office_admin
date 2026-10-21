# Agent fixtures: TEST FIXTURES ONLY. Not listings.

These directories exist so the agent and bundle validators, the compiler bridge and the eval corpora have realistic
agents to run against (the "M&A Analyst" and "Legal Research" examples). They are **never seeded as marketplace
listings**: no seed script, migration or production code path may reference this directory
(`test/marketplace-fixtures.test.ts` asserts that for `src/` and `db/`). The skills they depend on (`fixture-pub/*`)
are built inside the tests and published into a throwaway store only.

Each directory is a complete agent package: `agentic.marketplace.json`, `blueprint.json`, `SOUL.md`, `README.md`.
The manifest's file hashes are checked by the fixtures test; if you edit a file, regenerate the manifest hashes
(the test prints the expected values).
