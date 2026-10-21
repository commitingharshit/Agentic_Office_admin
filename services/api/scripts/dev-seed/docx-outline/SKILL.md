---
name: docx-outline
description: Print the heading outline of a .docx file (level, text and a count per level) so a document's structure can be reviewed before it is edited.
---

# docx-outline

Use this skill when you need to understand how a Word document is organised before changing it:
which headings exist, how deep they nest, and whether a level is skipped.

## How to use it

1. Find the `.docx` file the user is talking about inside the workspace.
2. Run the bundled script with the path to that file:

   ```
   python3 scripts/outline.py path/to/document.docx
   ```

3. Read the result. Each line is `<indent><level> <heading text>`; the last lines are a count per level.
4. Report the outline back to the user, and point out skipped levels (for example a Heading 3 directly
   under a Heading 1) or an empty outline (the document uses direct formatting instead of heading styles).

## Notes

- The script only reads the file. It never writes, and it makes no network calls.
- It understands the built-in `Heading 1` to `Heading 9` styles and the `Title` style. Documents that
  fake headings with bold text have no outline; say so rather than guessing.
- See [the style guide](references/styles.md) for how Word names heading styles.
