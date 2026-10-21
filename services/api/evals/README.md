# Marketplace evals

Two evals that run the marketplace's real validators over fixed, labelled corpora and gate on the numbers. They
answer "did a change to a validator, the file policy or the vendored scanner let something through that used to be
caught, or start blocking things that used to pass?". They are **regression gates, not security proofs**.

| Eval | Corpus | Pipeline under test |
|---|---|---|
| `run-scan-gate.ts` | 12 benign + 12 malicious skill packages, built in the runner | `unpack()` then `validateArtifact('skill')` with `createSkillValidator` and the real Skills Guard (`createSkillsGuardScanner` runs `vendor/hermes-agent/tools/skills_scan_cli.py` under `python3`) |
| `run-template-validator.ts` | corpus in `template-corpus.ts`: 6 benign (5 real templates from `templates/` + 1 benign edge) + 52 hostile or malformed packages (mutations of those templates; the `h*` cases are the Plan 4 Task 11 hardening gaps) | `unpack()` then `validateArtifact('template')` (static checks; no OfficeCLI) |
| `run-template-differential.ts` | the template corpus + `FUZZ_MUTATIONS` (default 500) seeded mutations of the real templates (`FUZZ_SEED`, default 1) | validator verdict vs OfficeCLI `validate` + `view issues` (skipped when `officecli` is missing) |

Positive class = malicious; "detected" = the package was rejected (at unpack or by any failed validation check).

## Running

```
cd services/accounts-sync
npm run eval              # both
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
