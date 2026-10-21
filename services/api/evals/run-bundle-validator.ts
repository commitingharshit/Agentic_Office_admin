// Bundle-validator eval: the corpus in bundle-corpus.ts through the REAL bundle validator against a fake caller-scoped catalog.
// Same gate semantics as the scan gate (confusion matrix, recall 100% excluding documented known gaps, benign FP rate <= 10%).
// Run: node evals/run-bundle-validator.ts   (npm run eval:bundles)
import { createBundleValidator } from '../src/marketplace/validate/bundle.ts';
import { isPublishable } from '../src/marketplace/support.ts';
import { parseRiskTier } from '../src/marketplace/validate/advanced-common.ts';
import { catalogOf } from '../test/helpers/bundle-fixtures.ts';
import { cases } from './bundle-corpus.ts';
import { finish, gapsFor, type Outcome } from './lib.ts';

const NAME = 'bundle-validator';
const gaps = gapsFor(NAME);
const extra: string[] = [];
const outcomes: Outcome[] = [];

for (const c of cases) {
  const t0 = Date.now();
  const b = c.build();
  // production: agent members are supported once the agent runtime self-check passed (agents.ts register)
  const checks = await createBundleValidator({ catalog: catalogOf(b.members, b.hidden), context: b.ctx, supported: (t) => isPublishable(t) || t === 'agent' })(b.pkg);
  const failed = checks.filter((k) => !k.ok);
  let verdict: Outcome['verdict'] = failed.length ? 'reject' : 'accept';
  let reason = failed.length ? `${failed[0].name}: ${failed[0].detail ?? ''}`.slice(0, 200) : 'all checks passed';
  let failedChecks = failed.map((k) => k.name);
  if (c.label === 'benign' && verdict === 'accept') {
    const skipped = checks.filter((k) => k.skipped && k.required).map((k) => k.name);
    if (skipped.length) { verdict = 'reject'; reason = `not verified (required checks skipped): ${skipped.join(', ')}`; failedChecks = skipped; }
    if (c.mustHave && !checks.some((k) => k.name === c.mustHave)) { verdict = 'reject'; reason = `expected check ${c.mustHave} (manual review routing) is missing`; failedChecks = [c.mustHave]; }
    if (c.mustHave === 'manual-review-required' && parseRiskTier(checks) !== 'executable') { verdict = 'reject'; reason = 'an elevated member did not raise the bundle to the executable tier'; failedChecks = ['risk-tier']; }
  }
  if (c.label === 'malicious' && verdict === 'reject' && c.catches && !c.catches.some((n) => failedChecks.includes(n))) extra.push(`${c.id}: rejected, but not by the intended check (${c.catches.join(' or ')}); failed: ${failedChecks.join(', ')}`);
  outcomes.push({ id: c.id, label: c.label, category: c.category, note: c.note, verdict, stage: verdict === 'reject' ? 'validate' : 'none', reason, failedChecks, ...(gaps.has(c.id) ? { knownGap: gaps.get(c.id) } : {}), ms: Date.now() - t0 });
}

const n = (l: string) => cases.filter((c) => c.label === l).length;
process.exit(finish(NAME, 'Bundle validator eval', outcomes, [
  `Fixed corpus of ${cases.length} bundle packages (${n('benign')} benign, ${n('malicious')} hostile): a regression gate, not a proof that every hostile bundle is caught.`,
  'The catalog is an in-memory fake that models row-level security; the SQL policies and the install-time transaction are tested elsewhere.',
  'A bundle references members by exact version and sha256; this eval does not re-hash the member artifacts (the catalog row is the source of the published hash).',
  'A malicious case rejected by a check other than the intended one fails the gate: it proves nothing about the intended defence.',
], extra));
