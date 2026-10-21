# Marketplace evals

Evals that run the marketplace's real validators over fixed, labelled corpora and gate on the numbers. They
answer "did a change to a validator, the file policy or the vendored scanner let something through that used to be
caught, or start blocking things that used to pass?". They are **regression gates, not security proofs**.

| Eval | Corpus | Pipeline under test |
|---|---|---|
| `run-scan-gate.ts` | 12 benign + 12 malicious skill packages, built in the runner | `unpack()` then `validateArtifact('skill')` with `createSkillValidator` and the real Skills Guard (`createSkillsGuardScanner` runs `vendor/hermes-agent/tools/skills_scan_cli.py` under `python3`) |
| `run-template-validator.ts` | corpus in `template-corpus.ts`: 6 benign (5 real templates from `templates/` + 1 benign edge) + 52 hostile or malformed packages (mutations of those templates; the `h*` cases are the Plan 4 Task 11 hardening gaps) | `unpack()` then `validateArtifact('template')` (static checks; no OfficeCLI) |
| `run-template-differential.ts` | the template corpus + `FUZZ_MUTATIONS` (default 500) seeded mutations of the real templates (`FUZZ_SEED`, default 1) | validator verdict vs OfficeCLI `validate` + `view issues` (skipped when `officecli` is missing) |
| `run-blueprint-validator.ts` | `blueprint-corpus.ts`: 18 benign agents (incl. the M&A Analyst and Legal Research fixtures from `test/fixtures/agents/`, test fixtures only, never listings) + 54 hostile ones (escalation, injection, supply-chain, cycle, dependency, config-smuggling, dos, secrets) | `createAgentValidator` with a fake caller-scoped catalog, the REAL Python compiler bridge (with dry run over real skill trees) and the REAL Skills Guard persona scanner when `vendor/hermes-agent/venv` exists (`HERMES_PYTHON` overrides). Cases marked `needsPython` are **skipped, not passed** without it |
| `run-bundle-validator.ts` | `bundle-corpus.ts`: 11 benign + 35 hostile bundles (swapped hash, range pins, nesting, visibility, closure, order, compat, permission union, forbidden files, smuggling, DoS) | `createBundleValidator` with a fake caller-scoped catalog |
| `run-advanced-gate.ts` | `corpora/{hook,bridge,connector,routine,memory,workflow}.ts`, normalised by `advanced-gate.ts` (hook 4+28, bridge 1+99, connector 1+75, routine 6+63, memory 6+38, workflow 6+35 benign+malicious) | `unpack()` then the REAL `validateArtifact(type, pkg)` for each advanced type. Gates: 100% recall on malicious (known gaps excepted), 0 benign false positives, a size floor per type (hook 14, bridge 12, connector 11, routine 15, memory 10, workflow 13), a missing or empty corpus fails, a validator crash is never counted as detection, a rejection by a different check than the recorded `catches` fails. Script-mode hooks are off (no per-host-class results; reported as not run, never as passed). `test/marketplace-advanced-gate.test.ts` holds the meta-tests that prove the runner cannot pass vacuously. Hermes-side handler corpora: `cd vendor/hermes-agent && python -m pytest tests/hermes_cli/marketplace_ext -q` |

Positive class = malicious; "detected" = the package was rejected (at unpack or by any failed validation check).

## Running

```
cd services/accounts-sync
npm run eval              # all (scan gate, templates, blueprints, bundles, advanced types)
npm run eval:advanced     # the six advanced-type hostile corpora
npm run eval:scan-gate    # needs python3 and vendor/hermes-agent in the checkout
npm run eval:templates    # pure Node
npm run eval:differential # needs the officecli binary (slow: ~2 officecli calls per case; FUZZ_MUTATIONS=50 for a quick pass)
```

Each run prints the confusion matrix, recall, precision, the false-positive rate and one line per case, and exits 1
when a gate fails. It writes `results/<eval>.json` (machine readable, deterministic: no timestamps) and
`results/<eval>.md` (the human summary). The results files are committed, so a behavior change shows up as a diff.

## Gates

- Recall on the malicious set must be 100%: any malicious package accepted fails the run, unless the case is listed in
  `known-gaps.json`. A known gap is reported separately (raw recall and recall excluding known gaps are both printed),
  never silently dropped; when a listed case starts being detected the runner says to remove the entry.
- The benign false-positive rate must not exceed 10%.

## The OfficeCLI differential

OfficeCLI is the renderer users get, so it is the independent reference for "is this OOXML package corrupt".
`run-template-differential.ts` runs every case through the validator and through `officecli validate` (then `view issues`
when the file opens) and buckets the pairs:

- **gap**: validator accepts, OfficeCLI cannot open the file. Fails the run unless the case id is listed under
  `template-differential` in `known-gaps.json` with a reason.
- **schema-invalid but accepted**: OfficeCLI opens the file but reports `[Package]`/`[Schema]` errors. Counted and sampled in
  the results, not a failure: schema validation is the pipeline's `ooxml-schema` stage (OfficeCLI itself), not this scanner.
- **rejected but OfficeCLI is fine**: reviewed. Rejections by `no-active-content`, `unpack:*`, `preview-images` or
  `payload-shape` are policy (OfficeCLI opens macro/remote content happily by design). Rejections by `ooxml-zip` alone are
  listed as "stricter than OfficeCLI".

The Rust kernels (`docpatch-kernel`, `xlsx-kernel`) are not part of it: they index a document for editing, expose no
accept/reject command, and are not built in a fresh checkout. `results/template-differential.json` records the run
(seed, counts, every gap and stricter-than-OfficeCLI rejection); `template-diff-corpus/manifest.json` lists the exact
mutations (id, operator, sha256) so a finding can be reproduced from the seed.

## Adding a case

Add a `Case` (label, category, note, a `build()` that returns the zip bytes) to the runner. Measure first: run it, read
the verdict and the failed check names, and only then record the label. Never relabel a case to make the gate pass; if a
malicious case is accepted, either fix the validator or add an entry with the reason to `known-gaps.json`.

## Honest limits

- Static checks over a small fixed corpus. 100% recall here means "these hostile packages are caught", not "hostile
  packages are caught".
- The skill scanner is `skills_guard.py` (patterns plus a few structural checks). The marketplace closes some of its gaps
  itself (any finding blocks; unscannable, non-UTF-8, oversized-line, hidden-Unicode, ignore-file and disguised-binary
  files are rejected by the file policy in `skill.ts`), but the guard itself is unchanged by design (ruling R27 in
  `.superpowers/sdd/2026-10-21-extension-marketplace/progress.md`: medium and low findings still pass its own verdict;
  its extension allow-list stays). Purely semantic attacks written as ordinary prose are invisible to a pattern scanner.
- The Python adapter path is the same scanner child process; the Hermes install side (verification, refusal of unsafe
  skills, local-edit protection) is covered by `tests/tools/test_agentic_marketplace_source.py` and Task 10's e2e, not here.
- The PDF check is a heuristic scan for active-content names, not a PDF parser. The renderer check (OfficeCLI) is not run in the gates; the differential is the cross-check.
- Residual risk of the template scanner: a hand-written XML scanner can have exotic bypasses (field obfuscation through nested fields,
  attributes with unlisted names that a consumer treats as URLs, Office behaviours not covered by a rule). The layers behind it are
  the admin review queue and the rule that no external relationship except an https hyperlink is allowed. A rewrite on a full OOXML
  parser was declined as disproportionate (OfficeCLI already schema-validates in the verification pipeline).
- Hostile markdown (raw HTML, bad links) is neutralised by the Marketplace renderer, not by the scanner; remote images
  are rejected by the `no-remote-images` check. `known-gaps.json` is currently empty.

## Blueprint and bundle evals: extra rules

- Every malicious case has `catches`, the check that should reject it. A case rejected by a different check **fails the gate** (it proves nothing about the intended defence). A blueprint case not marked `needsPython` must also be rejected by the TypeScript checks alone (the runner re-runs it without the bridge and scanner).
- Benign cases must be accepted and, when Python is available, `verified` (no required check skipped). Some also assert a check is present (for example `manual-review-required` for an elevated bundle member, `unsupported-reported` for declared-only components).
- Without the Hermes virtualenv the blueprint run still gates on the TypeScript-detectable cases and prints `SKIPPED n case(s)`; the skipped list is also in `results/blueprint-validator.json|md`. Skipped is never counted as passed, so a missing Python shows up as fewer evaluated cases.
- Labels are set by what the package is. If a hostile case is accepted, fix the validator or record a `known-gaps.json` entry with the reason; never relabel.
- Holes these corpora found (fixed with regression tests in `test/marketplace-fixtures.test.ts`): a long hyphenated skill id tripped the secret entropy rule (false positive), the dry run was never sent the child blueprints (any agent with a delegated child failed the real dry run), a BOM before `blueprint.json` was stripped by the decoder, hyphen-only confusable skill/child ids in a blueprint, and duplicate keys in `bundle.json`.
- Run: `npm run eval:blueprints`, `npm run eval:bundles`; `npm run eval` runs all four.
