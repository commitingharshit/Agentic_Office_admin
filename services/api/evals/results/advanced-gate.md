# Advanced types hostile-corpus gate

Result: **passed**. Gates: 100% recall on the malicious set (known gaps in `evals/known-gaps.json` excepted), 0 false positives on the benign set, a corpus size floor per type, no validator crash counted as detection.

| type | benign | malicious | TP | FN | FP | TN | crashes | recall | precision | FPR | floor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bridge | 1 | 99 | 99 | 0 | 0 | 1 | 0 | 100.0% | 100.0% | 0.0% | 12 |
| connector | 1 | 75 | 75 | 0 | 0 | 1 | 0 | 100.0% | 100.0% | 0.0% | 11 |
| hook | 4 | 28 | 28 | 0 | 0 | 4 | 0 | 100.0% | 100.0% | 0.0% | 14 |
| memory | 6 | 38 | 38 | 0 | 0 | 6 | 0 | 100.0% | 100.0% | 0.0% | 10 |
| routine | 6 | 63 | 63 | 0 | 0 | 6 | 0 | 100.0% | 100.0% | 0.0% | 15 |
| workflow | 6 | 35 | 35 | 0 | 0 | 6 | 0 | 100.0% | 100.0% | 0.0% | 13 |

- hook-script (mode script): not run. Script hooks are off (standing security ruling, Plan 3 T10 not implemented), so there are no per-host-class results and nothing is counted as passed.

## Limits

- Fixed corpora over static validators: a regression gate, not a proof that every hostile package is caught.
- Where a case records the check that must reject it (`catches`), a rejection by a different check fails the gate.
- The Hermes-side handler corpora run separately: `cd vendor/hermes-agent && python -m pytest tests/hermes_cli/marketplace_ext -q`.
