#!/usr/bin/env python3
"""Print the heading outline of a .docx file. Read-only; standard library only."""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
STYLE = re.compile(r"^(Heading([1-9])|Title)$")


def outline(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    rows = []
    for p in root.iter(W + "p"):
        style = p.find(f"{W}pPr/{W}pStyle")
        m = STYLE.match(style.get(W + "val", "")) if style is not None else None
        if not m:
            continue
        text = "".join(t.text or "" for t in p.iter(W + "t")).strip()
        if text:
            rows.append((0 if m.group(1) == "Title" else int(m.group(2)), text))
    return rows


def main(argv):
    if len(argv) != 2:
        print("usage: outline.py document.docx", file=sys.stderr)
        return 2
    try:
        rows = outline(argv[1])
    except (OSError, KeyError, zipfile.BadZipFile, ET.ParseError) as e:
        print(f"cannot read {argv[1]}: {e}", file=sys.stderr)
        return 1
    if not rows:
        print("No heading styles found.")
        return 0
    counts = {}
    for level, text in rows:
        counts[level] = counts.get(level, 0) + 1
        label = "Title" if level == 0 else f"H{level}"
        print(f"{'  ' * max(level - 1, 0)}{label} {text}")
    print()
    for level in sorted(counts):
        print(f"{'Title' if level == 0 else 'H' + str(level)}: {counts[level]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
