# Marketplace evals

Two evals that run the marketplace's real validators over fixed, labelled corpora and gate on the numbers. They
answer "did a change to a validator, the file policy or the vendored scanner let something through that used to be
caught, or start blocking things that used to pass?". They are **regression gates, not security proofs**.

| Eval | Corpus | Pipeline under test |
|---|---|---|
| `run-scan-gate.ts` | 12 benign + 12 malicious skill packages, built in the runner | `unpack()` then `validateArtifact('skill')` with `createSkillValidator` and the real Skills Guard (`createSkillsGuardScanner` runs `vendor/hermes-agent/tools/skills_scan_cli.py` under `python3`) |
| `run-template-validator.ts` | 5 real templates from `templates/` + 20 hostile or malformed packages (mutations of those templates) | `unpack()` then `validateArtifact('template')` (static checks; no OfficeCLI) |

Positive class = malicious; "detected" = the package was rejected (at unpack or by any failed validation check).

## Running

```
cd services/accounts-sync
npm run eval              # both
npm run eval:scan-gate    # needs python3 and vendor/hermes-agent in the checkout
npm run eval:templates    # pure Node
```

Each run prints the confusion matrix, recall, precision, the false-positive rate and one line per case, and exits 1
when a gate fails. It writes `results/<eval>.json` (machine readable, deterministic: no timestamps) and
`results/<eval>.md` (the human summary). The results files are committed, so a behavior change shows up as a diff.

## Gates

- Recall on the malicious set must be 100%: any malicious package accepted fails the run, unless the case is listed in
  `known-gaps.json`. A known gap is reported separately (raw recall and recall excluding known gaps are both printed),
  never silently dropped; when a listed case starts being detected the runner says to remove the entry.
- The benign false-positive rate must not exceed 10%.

## Adding a case

Add a `Case` (label, category, note, a `build()` that returns the zip bytes) to the runner. Measure first: run it, read
the verdict and the failed check names, and only then record the label. Never relabel a case to make the gate pass; if a
malicious case is accepted, either fix the validator or add an entry with the reason to `known-gaps.json`.

## Honest limits

- Static checks over a small fixed corpus. 100% recall here means "these 32 hostile packages are caught", not "hostile
  packages are caught".
- The skill scanner is `skills_guard.py` (patterns plus a few structural checks). The marketplace closes some of its gaps
  itself (any finding blocks; unscannable, non-UTF-8, oversized-line, hidden-Unicode, ignore-file and disguised-binary
  files are rejected by the file policy in `skill.ts`), but the guard itself is unchanged by design (ruling R27 in
  `.superpowers/sdd/2026-10-21-extension-marketplace/progress.md`: medium and low findings still pass its own verdict;
  its extension allow-list stays). Purely semantic attacks written as ordinary prose are invisible to a pattern scanner.
- The Python adapter path is the same scanner child process; the Hermes install side (verification, refusal of unsafe
  skills, local-edit protection) is covered by `tests/tools/test_agentic_marketplace_source.py` and Task 10's e2e, not here.
- The PDF check is a heuristic scan for active-content names, not a PDF parser. The renderer check (OfficeCLI) is not run.
- Hostile markdown (raw HTML, bad links) is neutralised by the Marketplace renderer, not by the scanner; remote images
  are rejected by the `no-remote-images` check. `known-gaps.json` is currently empty.
