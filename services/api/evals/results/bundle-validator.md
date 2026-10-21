# Bundle validator eval

Result: **passed**. Gates: recall on the malicious set = 100% (known gaps listed in `evals/known-gaps.json` excepted), benign false-positive rate <= 10%.

```
                      predicted reject   predicted accept
  malicious (n=35 )         35 (TP)             0 (FN)
  benign    (n=11 )          0 (FP)            11 (TN)
```

- recall 100.0% (35/35)
- precision 100.0% (35/35)
- false-positive rate 0.0% (0/11)

## Cases

| case | label | category | verdict | failed checks |
|---|---|---|---|---|
| b01-single-skill | benign | real | accept | - |
| b02-template-skill-agent | benign | real | accept | - |
| b03-dependency-chain | benign | real | accept | - |
| b04-pinned-not-ranged | benign | real | accept | - |
| b05-team-bundle | benign | real | accept | - |
| b06-org-bundle | benign | real | accept | - |
| b07-warnings-member | benign | real | accept | - |
| b08-elevated-member-manual-review | benign | real | accept | - |
| b09-private-with-private | benign | real | accept | - |
| b10-readme-and-notes | benign | real | accept | - |
| b11-over-declared-permission | benign | real | accept | - |
| m01-swapped-hash | malicious | supply-chain | reject | items-pinned |
| m02-range-instead-of-pin | malicious | supply-chain | reject | bundle-parse |
| m03-nested-bundle | malicious | supply-chain | reject | items-types |
| m04-private-in-public | malicious | dependency | reject | visibility-no-escalation |
| m05-other-team-member | malicious | dependency | reject | visibility-no-escalation |
| m06-revoked-member | malicious | supply-chain | reject | items-pinned |
| m07-not-visible-member | malicious | dependency | reject | items-pinned |
| m08-unknown-member | malicious | dependency | reject | items-pinned |
| m09-missing-transitive-dep | malicious | dependency | reject | closure-complete |
| m10-dep-at-unsatisfying-pin | malicious | dependency | reject | closure-complete |
| m11-disjoint-compat | malicious | dependency | reject | compat-consistent |
| m12-install-order-violation | malicious | dependency | reject | install-order-valid |
| m13-under-declared-union | malicious | escalation | reject | permissions-union |
| m14-wildcard-scope | malicious | escalation | reject | permissions-union |
| m15-env-file | malicious | secrets | reject | bundle-files-allowlist |
| m16-memory-file | malicious | secrets | reject | bundle-files-allowlist |
| m17-document-file | malicious | secrets | reject | bundle-files-allowlist |
| m18-credentials-file | malicious | secrets | reject | bundle-files-allowlist |
| m19-secret-in-notes | malicious | secrets | reject | no-secrets |
| m20-two-hundred-members | malicious | dos | reject | bundle-parse |
| m21-confusable-ids | malicious | supply-chain | reject | bundle-parse |
| m22-contains-itself | malicious | cycle | reject | items-types |
| m23-duplicate-member | malicious | supply-chain | reject | bundle-parse |
| m24-proto-key | malicious | config-smuggling | reject | bundle-parse |
| m25-depth-1000 | malicious | dos | reject | bundle-parse |
| m26-credentials-key | malicious | secrets | reject | bundle-parse |
| m27-memories-and-documents-keys | malicious | secrets | reject | bundle-parse |
| m28-team-scope-mismatch | malicious | dependency | reject | team-scope-valid |
| m29-unsupported-member-type | malicious | supply-chain | reject | members-supported |
| m30-manifest-deps-mismatch | malicious | supply-chain | reject | deps-match-manifest |
| m31-member-wrong-type | malicious | supply-chain | reject | items-pinned |
| m32-unpublished-member | malicious | supply-chain | reject | items-pinned |
| m33-dependency-cycle | malicious | cycle | reject | closure-complete, install-order-valid |
| m34-secret-in-manifest-payload | malicious | secrets | reject | no-secrets-manifest-payload |
| m35-duplicate-key | malicious | config-smuggling | reject | bundle-parse |

## Limits of this eval

- Fixed corpus of 46 bundle packages (11 benign, 35 hostile): a regression gate, not a proof that every hostile bundle is caught.
- The catalog is an in-memory fake that models row-level security; the SQL policies and the install-time transaction are tested elsewhere.
- A bundle references members by exact version and sha256; this eval does not re-hash the member artifacts (the catalog row is the source of the published hash).
- A malicious case rejected by a check other than the intended one fails the gate: it proves nothing about the intended defence.
