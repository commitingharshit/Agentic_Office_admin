# Template validator eval

Result: **passed**. Gates: recall on the malicious set = 100% (known gaps listed in `evals/known-gaps.json` excepted), benign false-positive rate <= 10%.

```
                      predicted reject   predicted accept
  malicious (n=20 )         20 (TP)             0 (FN)
  benign    (n=5  )          0 (FP)             5 (TN)
```

- recall 100.0% (20/20)
- precision 100.0% (20/20)
- false-positive rate 0.0% (0/5)

## Cases

| case | label | category | verdict | failed checks |
|---|---|---|---|---|
| t01-pptx-board-update | benign | real-template | accept | - |
| t02-pptx-investor-pitch | benign | real-template | accept | - |
| t03-docx-board-memo | benign | real-template | accept | - |
| t04-xlsx-budget-tracker | benign | real-template | accept | - |
| t05-pdf-one-pager | benign | real-template | accept | - |
| x01-macro-vba | malicious | macro | reject | no-active-content |
| x02-macro-content-type | malicious | macro | reject | no-active-content |
| x03-external-http-link | malicious | external-link | reject | no-active-content |
| x04-external-unc | malicious | external-link | reject | no-active-content |
| x05-external-scheme-relative | malicious | external-link | reject | no-active-content |
| x06-external-file-uri | malicious | external-link | reject | no-active-content |
| x07-dde-docx-field | malicious | dde | reject | no-active-content |
| x08-dde-xlsx-formula | malicious | dde | reject | no-active-content |
| x09-zip-bomb | malicious | bomb | reject | unpack:too-large |
| x10-truncated | malicious | malformed | reject | ooxml-zip |
| x11-no-content-types | malicious | malformed | reject | ooxml-zip |
| x12-override-missing-part | malicious | malformed | reject | ooxml-zip |
| x13-svg-preview | malicious | disguised-file | reject | preview-images |
| x14-html-as-pptx | malicious | disguised-file | reject | ooxml-zip |
| x15-elf-in-embeddings | malicious | executable | reject | no-active-content |
| x16-case-variant-attributes | malicious | evasion | reject | ooxml-zip, no-active-content |
| x17-utf16-rels | malicious | evasion | reject | no-active-content |
| x18-nested-workbook-bomb | malicious | bomb | reject | no-active-content |
| x19-pdf-javascript | malicious | pdf-active | reject | pdf-header |
| x20-pdf-launch | malicious | pdf-active | reject | pdf-header |

## Limits of this eval

- Static checks over a fixed corpus of 25 packages (5 real, 20 hostile or malformed): a regression gate, not a proof that every hostile Office file is caught.
- The renderer check (officecli-open) is not run: it needs the OfficeCLI binary and is injected in production. Passing here means the static structure and active-content scan passed.
- The PDF check is a heuristic byte scan for /JavaScript, /Launch and similar names (with name-escape handling); it is not a PDF parser.
- Hostile Office files that rely on application behavior (DDE, remote template injection through unusual relationship types, formula injection) are only caught where the scanner has a rule for them; see known gaps.
- Mutations are built from the repo's own templates, so exotic real-world malware families are not represented.
