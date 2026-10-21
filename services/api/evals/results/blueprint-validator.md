# Blueprint validator eval

Result: **passed**. Gates: recall on the malicious set = 100% (known gaps listed in `evals/known-gaps.json` excepted), benign false-positive rate <= 10%.

```
                      predicted reject   predicted accept
  malicious (n=54 )         54 (TP)             0 (FN)
  benign    (n=18 )          0 (FP)            18 (TN)
```

- recall 100.0% (54/54)
- precision 100.0% (54/54)
- false-positive rate 0.0% (0/18)

## Cases

| case | label | category | verdict | failed checks |
|---|---|---|---|---|
| b01-minimal | benign | real | accept | - |
| b02-ma-analyst-fixture | benign | fixture | accept | - |
| b03-legal-research-fixture | benign | fixture | accept | - |
| b04-read-research | benign | real | accept | - |
| b05-unsupported-warnings | benign | real | accept | - |
| b06-advisory-verification | benign | real | accept | - |
| b07-two-level-delegation | benign | real | accept | - |
| b08-private-private-dep | benign | real | accept | - |
| b09-team-team-dep | benign | real | accept | - |
| b10-file-toolset | benign | real | accept | - |
| b11-memory-binding | benign | real | accept | - |
| b12-model-fallbacks | benign | real | accept | - |
| b13-manual-trigger | benign | real | accept | - |
| b14-optional-skill-warnings | benign | real | accept | - |
| b15-persona-mentions-approvals | benign | persona | accept | - |
| b16-persona-unicode | benign | persona | accept | - |
| b17-yaml-special-name | benign | real | accept | - |
| b18-long-skill-slug | benign | real | accept | - |
| m01-terminal-undeclared | malicious | escalation | reject | permissions-subset |
| m02-hidden-skill-exec | malicious | escalation | reject | permissions-subset |
| m03-hidden-skill-network | malicious | escalation | reject | permissions-subset |
| m04-child-exceeds-parent | malicious | escalation | reject | permissions-subset |
| m05-child-toolset-exceeds | malicious | escalation | reject | permissions-subset, compiles |
| m06-grandchild-exceeds | malicious | escalation | reject | permissions-subset |
| m07-wildcard-toolset | malicious | escalation | reject | no-wildcards, compiles |
| m08-wildcard-kit | malicious | escalation | reject | blueprint-parse |
| m09-wildcard-permission-scope | malicious | escalation | reject | no-wildcards |
| m10-auto-edit-no-write | malicious | escalation | reject | permissions-subset |
| m11-workspace-write-undeclared | malicious | escalation | reject | permissions-subset |
| m12-url-knowledge-no-network | malicious | escalation | reject | permissions-subset |
| m13-approvals-off | malicious | escalation | reject | blueprint-parse |
| m14-skill-scope-broader | malicious | escalation | reject | permissions-subset |
| m15-public-agent-private-skill | malicious | dependency | reject | visibility-no-escalation |
| m16-revoked-dependency | malicious | supply-chain | reject | refs-resolve |
| m17-unsatisfiable-range | malicious | supply-chain | reject | refs-resolve |
| m18-other-team-dependency | malicious | dependency | reject | visibility-no-escalation |
| m19-dependency-not-visible | malicious | dependency | reject | refs-resolve |
| m20-confusable-skill-ids | malicious | supply-chain | reject | blueprint-parse |
| m21-deps-manifest-extra | malicious | supply-chain | reject | deps-match-manifest |
| m22-payload-lies | malicious | config-smuggling | reject | payload-matches, permissions-subset |
| m23-extra-file | malicious | supply-chain | reject | agent-files-allowlist |
| m24-dependency-wrong-type | malicious | supply-chain | reject | refs-resolve |
| m54-workflow-not-pinned | malicious | supply-chain | reject | deps-match-manifest |
| m25-delegation-cycle | malicious | cycle | reject | delegation-acyclic, dry-run |
| m26-self-delegation | malicious | cycle | reject | deps-match-manifest, delegation-acyclic, compiles |
| m27-delegation-too-deep | malicious | cycle | reject | delegation-acyclic, dry-run |
| m28-soul-ignore-instructions | malicious | injection | reject | persona-scan, compiles |
| m29-soul-exfiltrate-memory | malicious | injection | reject | persona-scan |
| m30-soul-override-host-policy | malicious | injection | reject | compiles |
| m33-soul-read-ssh-keys | malicious | injection | reject | persona-scan |
| m31-soul-zero-width | malicious | injection | reject | soul-file |
| m32-instructions-traversal | malicious | config-smuggling | reject | blueprint-parse |
| m34-yaml-newline-name | malicious | config-smuggling | reject | blueprint-parse |
| m35-proto-key | malicious | config-smuggling | reject | blueprint-parse |
| m36-hook-inline-command | malicious | config-smuggling | reject | blueprint-parse |
| m37-model-base-url | malicious | config-smuggling | reject | blueprint-parse |
| m38-knowledge-userinfo | malicious | config-smuggling | reject | blueprint-parse, no-secrets |
| m39-duplicate-key | malicious | config-smuggling | reject | blueprint-parse |
| m40-bom-prefix | malicious | config-smuggling | reject | blueprint-parse |
| m41-constructor-key | malicious | config-smuggling | reject | blueprint-parse |
| m52-unicode-confusable-id | malicious | supply-chain | reject | blueprint-parse |
| m53-unknown-component | malicious | config-smuggling | reject | blueprint-parse |
| m42-secret-in-description | malicious | secrets | reject | blueprint-parse, no-secrets |
| m43-secret-in-soul | malicious | secrets | reject | no-secrets, persona-scan, compiles |
| m44-private-key-in-goal | malicious | secrets | reject | blueprint-parse, no-secrets |
| m45-secret-behind-parse-error | malicious | secrets | reject | blueprint-parse, no-secrets |
| m46-one-megabyte | malicious | dos | reject | blueprint-parse |
| m47-ten-thousand-elements | malicious | dos | reject | blueprint-parse |
| m48-depth-1000 | malicious | dos | reject | blueprint-parse |
| m49-oversized-soul | malicious | dos | reject | soul-file |
| m50-sixty-five-skills | malicious | dos | reject | blueprint-parse |
| m51-oversized-graph | malicious | dos | reject | refs-resolve, delegation-acyclic |

## Limits of this eval

- Fixed corpus of 72 agent packages (18 benign, 54 hostile): a regression gate, not a proof that every hostile agent is caught.
- The real Python compiler bridge and the Skills Guard persona scanner were used.
- The catalog is an in-memory fake that models row-level security (a hidden row answers not_visible); the SQL policies themselves are tested elsewhere.
- The persona scan is the vendored Skills Guard heuristic: it catches the usual prompt-injection and exfiltration phrasings, not every paraphrase. See known gaps.
- A malicious case rejected by a check other than the intended one fails the gate: it proves nothing about the intended defence.
