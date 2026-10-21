# Skill scan-gate eval

Result: **passed**. Gates: recall on the malicious set = 100% (known gaps listed in `evals/known-gaps.json` excepted), benign false-positive rate <= 10%.

```
                      predicted reject   predicted accept
  malicious (n=12 )         11 (TP)             1 (FN)
  benign    (n=12 )          0 (FP)            12 (TN)
```

- recall 91.7% (11/12); 100.0% excluding 1 documented known gap(s)
- precision 100.0% (11/11)
- false-positive rate 0.0% (0/12)

## Known gaps (malicious, accepted today)

- **m09-remote-image**: The Skills Guard and the file policy accept a SKILL.md containing a remote tracking image (![x](https://evil.example/pixel.png?...)). Not fixed here: skills_guard.py is vendored and R27 keeps it unmodified in this release. Mitigation lives in the renderer: the Marketplace UI never loads remote images from a stranger's SKILL.md (Task 9, live-verified 0 requests to the evil host). Proposed fix: flag markdown/HTML image URLs with a query string or non-allowlisted host in skill.ts.

## Cases

| case | label | category | verdict | failed checks |
|---|---|---|---|---|
| b01-memo-style-seed | benign | real | accept | - |
| b02-docx-outline-seed | benign | real | accept | - |
| b03-git-commit-helper | benign | code-fence | accept | - |
| b04-curl-in-prose | benign | prose-mention | accept | - |
| b05-ignore-previous-prose | benign | prose-mention | accept | - |
| b06-pytest-helper | benign | script | accept | - |
| b07-csv-cleaner | benign | references | accept | - |
| b08-skill-with-png | benign | binary | accept | - |
| b09-license-readme | benign | no-extension | accept | - |
| b10-yaml-template | benign | references | accept | - |
| b11-sql-style | benign | code-fence | accept | - |
| b12-multilingual | benign | unicode | accept | - |
| m01-prompt-injection | malicious | prompt-injection | reject | security-scan |
| m02-exfil-curl-sh | malicious | exfiltration | reject | security-scan |
| m03-base64-exec | malicious | obfuscated-exec | reject | security-scan |
| m04-hidden-unicode | malicious | hidden-unicode | reject | hidden-unicode, security-scan |
| m05-skillignore-evasion | malicious | scanner-evasion | reject | no-scan-ignore-files |
| m06-non-utf8-smuggling | malicious | scanner-evasion | reject | file-policy |
| m07-redos-long-line | malicious | denial-of-service | reject | file-policy |
| m08-symlink-escape | malicious | archive | reject | unpack:symlink |
| m09-remote-image | malicious | hostile-markdown | accept (known gap) | - |
| m10-nested-archive | malicious | archive | reject | file-policy |
| m11-binary-as-png | malicious | disguised-binary | reject | file-policy |
| m12-unscannable-extension | malicious | scanner-evasion | reject | file-policy |

## Limits of this eval

- Static checks over a fixed corpus of 24 packages: a regression gate, not a proof that every hostile skill is caught.
- The scanner is skills_guard.py (regexes and a few structural checks). The marketplace path blocks ANY finding and rejects unscannable files itself, but the guard's own gaps remain (ruling R27: medium/low findings pass its own verdict; its extension allow-list is unchanged).
- Semantic attacks that are plain prose without trigger words are invisible to a pattern scanner.
- The Hermes install path (tests/tools/test_agentic_marketplace_source.py) is not re-run here; the scanner child process is the same Python code that path uses.
- Remote images and hostile HTML are neutralised by the Marketplace renderer (Task 9), not by the scanner: that defence is tested in the desktop tests.
