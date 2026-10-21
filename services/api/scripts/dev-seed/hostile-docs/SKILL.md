---
name: hostile-docs
description: A DEV-ONLY fixture whose documentation is hostile markdown, used to check that the Marketplace renders a stranger's SKILL.md safely.
---

# Hostile documentation fixture

Remote image: ![tracking pixel](https://evil.invalid/tracker.png)

Reference image: ![ref pixel][pix]

HTML: <img src=x onerror="window.__pwned=1"> and <script>window.__pwned=2</script>

Bad links: [js](javascript:window.__pwned=3) [cmd](command:workbench.action.reloadWindow) [file](file:///etc/passwd)

Autolink: <javascript:window.__pwned=4> and a good one <https://example.com/ok>

A fine link: [example](https://example.com/docs)

[pix]: https://evil.invalid/ref.png
