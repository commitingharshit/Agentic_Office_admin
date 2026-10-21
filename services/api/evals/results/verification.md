# Verification pipeline eval

Result: **passed**. Pipeline template v1. Tools present: officecli=true, kernel=true. `--allow-skip`: not-discriminating, prerequisite-skipped:render-pages.

Corpus: 75 cases: 9 benign (real templates), 60 hostile (the template-validator corpus), 6 valid-OOXML-but-broken.

- benign verdict `fail` (false positives): 0 of 9
- hostile detected: 60 of 60
- broken detected at the expected stage: 6 of 6
- skipped cases (tool missing): 0

## Required stages skipped on benign cases

- 2 x `not-discriminating:docx: the pixel/SSIM comparison does not separate docx previews from other templates (they are not produced by this renderer); needs the visual comparator`
- 2 x `not-discriminating:xlsx: the pixel/SSIM comparison does not separate xlsx previews from other templates (they are not produced by this renderer); needs the visual comparator`
- 1 x `prerequisite-skipped:render-pages`

## Measured (preview fidelity), benign and the swapped-preview case

| case | label | measured against its threshold |
|---|---|---|
| b01-pptx-board-update-pptx | benign | preview-fidelity:luma-mad 0.0017 <= 0.02; preview-fidelity:luma-ssim 0.9979 >= 0.9 |
| b02-pptx-investor-pitch-pptx | benign | preview-fidelity:luma-mad 0.0032 <= 0.02; preview-fidelity:luma-ssim 0.9961 >= 0.9 |
| b03-pptx-product-roadmap-pptx | benign | preview-fidelity:luma-mad 0.0022 <= 0.02; preview-fidelity:luma-ssim 0.9973 >= 0.9 |
| b04-pptx-quarterly-review-pptx | benign | preview-fidelity:luma-mad 0.0024 <= 0.02; preview-fidelity:luma-ssim 0.9976 >= 0.9 |
| b05-docx-board-memo-docx | benign | preview-fidelity:ink-fraction 0.0968 >= 0.002 |
| b06-docx-meeting-notes-docx | benign | preview-fidelity:ink-fraction 0.1317 >= 0.002 |
| b07-xlsx-budget-tracker-xlsx | benign | preview-fidelity:ink-fraction 0.3498 >= 0.002 |
| b08-xlsx-sales-pipeline-xlsx | benign | preview-fidelity:ink-fraction 0.3727 >= 0.002 |
| v05-preview-swapped | broken | preview-fidelity:luma-mad 0.4923 <= 0.02; preview-fidelity:luma-ssim 0.363 >= 0.9 |

## Cases

| case | label | verdict | failed stages |
|---|---|---|---|
| b01-pptx-board-update-pptx | benign | pass | - |
| b02-pptx-investor-pitch-pptx | benign | pass | - |
| b03-pptx-product-roadmap-pptx | benign | pass | - |
| b04-pptx-quarterly-review-pptx | benign | pass | - |
| b05-docx-board-memo-docx | benign | incomplete | - |
| b06-docx-meeting-notes-docx | benign | incomplete | - |
| b07-xlsx-budget-tracker-xlsx | benign | incomplete | - |
| b08-xlsx-sales-pipeline-xlsx | benign | incomplete | - |
| b09-pdf-one-pager-pdf | benign | incomplete | - |
| h-x01-macro-vba | hostile | fail | manifest |
| h-x02-macro-content-type | hostile | fail | manifest |
| h-x03-external-http-link | hostile | fail | manifest |
| h-x04-external-unc | hostile | fail | manifest |
| h-x05-external-scheme-relative | hostile | fail | manifest |
| h-x06-external-file-uri | hostile | fail | manifest |
| h-x07-dde-docx-field | hostile | fail | manifest |
| h-x08-dde-xlsx-formula | hostile | fail | manifest |
| h-x09-zip-bomb | hostile | refused-at-unpack | unpack:too-large |
| h-x10-truncated | hostile | fail | manifest |
| h-x11-no-content-types | hostile | fail | manifest |
| h-x12-override-missing-part | hostile | fail | manifest |
| h-x13-svg-preview | hostile | fail | manifest |
| h-x14-html-as-pptx | hostile | fail | manifest |
| h-x15-elf-in-embeddings | hostile | fail | manifest |
| h-x16-case-variant-attributes | hostile | fail | manifest |
| h-x17-utf16-rels | hostile | fail | manifest |
| h-x18-nested-workbook-bomb | hostile | fail | manifest |
| h-x19-pdf-javascript | hostile | fail | manifest |
| h-x20-pdf-launch | hostile | fail | manifest |
| h-h01-doctype-unlisted-part | hostile | fail | manifest |
| h-h02-malformed-unlisted-part | hostile | fail | manifest |
| h-h03-stylesheet-pi-first-bytes | hostile | fail | manifest |
| h-h04-pi-in-slide | hostile | fail | manifest |
| h-h05-dde-glossary | hostile | fail | manifest |
| h-h06-field-zero-width | hostile | fail | manifest |
| h-h07-field-deleted-instr | hostile | fail | manifest |
| h-h08-field-macrobutton | hostile | fail | manifest |
| h-h09-field-hyperlink-http | hostile | fail | manifest |
| h-h10-xlsx-table-formula | hostile | fail | manifest |
| h-h11-xlsx-validation-dde | hostile | fail | manifest |
| h-h12-script-element | hostile | fail | manifest |
| h-h13-svgblip | hostile | fail | manifest |
| h-h14-svg-as-png | hostile | fail | manifest |
| h-h15-svg-content-type | hostile | fail | manifest |
| h-h16-vml-remote-href | hostile | fail | manifest |
| h-h17-rel-attached-template-internal | hostile | fail | manifest |
| h-h18-rel-customui | hostile | fail | manifest |
| h-h19-rel-kind-query | hostile | fail | manifest |
| h-h20-xlsx-connections | hostile | fail | manifest |
| h-h21-webextension-part | hostile | fail | manifest |
| h-h22-html-part | hostile | fail | manifest |
| h-h23-trailing-dot-exe | hostile | fail | manifest |
| h-h24-percent-traversal-name | hostile | fail | manifest |
| h-h25-fullwidth-slash-name | hostile | fail | manifest |
| h-h26-bidi-name | hostile | fail | manifest |
| h-h27-percent-twin | hostile | fail | manifest |
| h-h28-ads-colon | hostile | fail | manifest |
| h-h29-target-above-root | hostile | fail | manifest |
| h-h30-target-double-encoded | hostile | fail | manifest |
| h-h31-deep-nesting | hostile | fail | manifest |
| h-h32-nested-workbook-doctype | hostile | fail | manifest |
| h-h33-override-retypes-rels | hostile | fail | manifest |
| h-h34-duplicate-override | hostile | fail | manifest |
| h-h35-main-part-retyped | hostile | fail | manifest |
| h-h36-duplicate-relationship-id | hostile | fail | manifest |
| h-h37-bad-xml-encoding | hostile | fail | manifest |
| h-h38-rels-unknown-child | hostile | fail | manifest |
| h-h39-rels-namespace-typo | hostile | fail | manifest |
| h-h40-types-namespace-typo | hostile | fail | manifest |
| v01-xlsx-ref-error | broken | fail | issues, formula-validity |
| v02-xlsx-circular | broken | fail | formula-validity |
| v03-docx-dangling-xref | broken | fail | docx-structure |
| v04-pptx-dangling-notes | broken | fail | manifest |
| v05-preview-swapped | broken | fail | preview-fidelity |
| v06-pptx-blank-deck | broken | fail | visual-sanity, preview-fidelity |

## Limits

- The visual comparator (CLIP/DINO worker) is not part of this run; preview fidelity is decided by the in-process pixel/SSIM check for pptx only. docx, xlsx and pdf end `incomplete` by design until a comparator exists.
- No threshold was changed and `visual-sanity` stays non-required: four real decks are not enough to prove 0 false positives for its layout rules.
- A regression gate over a fixed corpus, not a proof.
