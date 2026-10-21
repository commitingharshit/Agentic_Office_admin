# Template validator eval

Result: **passed**. Gates: recall on the malicious set = 100% (known gaps listed in `evals/known-gaps.json` excepted), benign false-positive rate <= 10%.

```
                      predicted reject   predicted accept
  malicious (n=60 )         60 (TP)             0 (FN)
  benign    (n=6  )          0 (FP)             6 (TN)
```

- recall 100.0% (60/60)
- precision 100.0% (60/60)
- false-positive rate 0.0% (0/6)

## Cases

| case | label | category | verdict | failed checks |
|---|---|---|---|---|
| t01-pptx-board-update | benign | real-template | accept | - |
| t02-pptx-investor-pitch | benign | real-template | accept | - |
| t03-docx-board-memo | benign | real-template | accept | - |
| t04-xlsx-budget-tracker | benign | real-template | accept | - |
| t05-pdf-one-pager | benign | real-template | accept | - |
| x01-macro-vba | malicious | macro | reject | no-active-content |
| x02-macro-content-type | malicious | macro | reject | ooxml-zip, no-active-content |
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
| h01-doctype-unlisted-part | malicious | xml-all-parts | reject | no-active-content |
| h02-malformed-unlisted-part | malicious | xml-all-parts | reject | no-active-content |
| h03-stylesheet-pi-first-bytes | malicious | processing-instruction | reject | no-active-content |
| h04-pi-in-slide | malicious | processing-instruction | reject | no-active-content |
| h05-dde-glossary | malicious | dde | reject | no-active-content |
| h06-field-zero-width | malicious | dde | reject | no-active-content |
| h07-field-deleted-instr | malicious | dde | reject | no-active-content |
| h08-field-macrobutton | malicious | dde | reject | no-active-content |
| h09-field-hyperlink-http | malicious | external-link | reject | no-active-content |
| h10-xlsx-table-formula | malicious | dde | reject | no-active-content |
| h11-xlsx-validation-dde | malicious | dde | reject | no-active-content |
| h12-script-element | malicious | svg-script | reject | no-active-content |
| h13-svgblip | malicious | svg-script | reject | no-active-content |
| h14-svg-as-png | malicious | svg-script | reject | no-active-content |
| h15-svg-content-type | malicious | svg-script | reject | no-active-content |
| h16-vml-remote-href | malicious | external-link | reject | no-active-content |
| h17-rel-attached-template-internal | malicious | rel-kind | reject | no-active-content |
| h18-rel-customui | malicious | rel-kind | reject | no-active-content |
| h19-rel-kind-query | malicious | rel-kind | reject | no-active-content |
| h20-xlsx-connections | malicious | remote-data | reject | no-active-content |
| h21-webextension-part | malicious | remote-data | reject | no-active-content |
| h22-html-part | malicious | disguised-file | reject | no-active-content |
| h23-trailing-dot-exe | malicious | name-trick | reject | no-active-content |
| h24-percent-traversal-name | malicious | name-trick | reject | no-active-content |
| h25-fullwidth-slash-name | malicious | name-trick | reject | no-active-content |
| h26-bidi-name | malicious | name-trick | reject | no-active-content |
| h27-percent-twin | malicious | name-trick | reject | ooxml-zip |
| h28-ads-colon | malicious | name-trick | reject | no-active-content |
| h29-target-above-root | malicious | name-trick | reject | no-active-content |
| h30-target-double-encoded | malicious | name-trick | reject | no-active-content |
| h31-deep-nesting | malicious | budget | reject | no-active-content |
| h32-nested-workbook-doctype | malicious | budget | reject | no-active-content |
| h33-override-retypes-rels | malicious | opc-structure | reject | ooxml-zip |
| h34-duplicate-override | malicious | opc-structure | reject | ooxml-zip |
| h35-main-part-retyped | malicious | opc-structure | reject | ooxml-zip |
| h36-duplicate-relationship-id | malicious | opc-structure | reject | ooxml-zip |
| h37-bad-xml-encoding | malicious | opc-structure | reject | ooxml-zip, no-active-content |
| h38-rels-unknown-child | malicious | opc-structure | reject | ooxml-zip |
| h39-rels-namespace-typo | malicious | opc-structure | reject | ooxml-zip |
| h40-types-namespace-typo | malicious | opc-structure | reject | ooxml-zip |
| b06-hyperlink-field-https-link-path | benign | real-template | accept | - |

## Limits of this eval

- Static checks over a fixed corpus of 66 packages (6 real, 60 hostile or malformed): a regression gate, not a proof that every hostile Office file is caught.
- The renderer check (officecli-open) is not run: it needs the OfficeCLI binary and is injected in production. Passing here means the static structure and active-content scan passed.
- The PDF check is a heuristic byte scan for /JavaScript, /Launch and similar names (with name-escape handling); it is not a PDF parser.
- Hostile Office files that rely on application behavior (DDE, remote template injection through unusual relationship types, formula injection) are only caught where the scanner has a rule for them; see known gaps.
- Mutations are built from the repo's own templates, so exotic real-world malware families are not represented.
