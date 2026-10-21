# Heading styles in Word files

Word stores a paragraph's style in `w:pStyle` inside `word/document.xml`. The built-in heading styles have
the ids `Heading1` to `Heading9` (the display name is "heading 1" ... "heading 9"), and `Title` for the
document title. Localised Word versions keep the ids, so the script matches on the id.
