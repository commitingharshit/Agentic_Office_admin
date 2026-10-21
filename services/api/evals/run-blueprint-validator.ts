// Blueprint-validator eval: the corpus in blueprint-corpus.ts through the REAL agent validator (TS checks, the real Python compiler bridge
// and the real Skills Guard persona scanner when the vendored Hermes virtualenv exists). Same gate semantics as the scan gate.
// Cases marked needsPython are SKIPPED (not passed) when Python is unavailable, so a missing Python shows as fewer evaluated cases.
// Run: node evals/run-blueprint-validator.ts   (npm run eval:blueprints)
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { catalog, pythonEnv } from './agent-env.ts';
import { cases } from './blueprint-corpus.ts';
import { finish, gapsFor, type Outcome } from './lib.ts';

const NAME = 'blueprint-validator';
const env = pythonEnv();
const gaps = gapsFor(NAME);
const extra: string[] = [];
const outcomes: Outcome[] = [];

for (const c of cases) {
  const t0 = Date.now();
  const base = { id: c.id, label: c.label, category: c.category, note: c.note, ...(gaps.has(c.id) ? { knownGap: gaps.get(c.id) } : {}) };
  if (c.needsPython && !env) {
    outcomes.push({ ...base, verdict: 'skip', stage: 'none', reason: 'needs the Python compiler bridge / persona scanner (no Hermes virtualenv)', failedChecks: [], ms: 0 });
    continue;
  }
  const b = await c.build();
  const run = async (withPy: boolean) => createAgentValidator({ catalog: catalog(b.rows, b.hidden), ...(withPy && env ? { bridge: env.bridge, scanner: env.scanner } : {}), context: b.audience })(b.pkg);
  const checks = await run(true);
  const failed = checks.filter((k) => !k.ok);
  let verdict: Outcome['verdict'] = failed.length ? 'reject' : 'accept';
  let reason = failed.length ? `${failed[0].name}: ${failed[0].detail ?? ''}`.slice(0, 200) : 'all checks passed';
  let failedChecks = failed.map((k) => k.name);
  if (c.label === 'benign' && verdict === 'accept') {
    const missing = checks.filter((k) => k.skipped && k.required).map((k) => k.name);
    if (env && missing.length) { verdict = 'reject'; reason = `not verified (required checks skipped): ${missing.join(', ')}`; failedChecks = missing; }
    if (c.mustHave) {
      const k = checks.find((x) => x.name === c.mustHave);
      if (!k || (c.mustHave === 'unsupported-reported' && !String(k.detail).startsWith('not available yet'))) { verdict = 'reject'; reason = `expected ${c.mustHave} to report unsupported components, got ${JSON.stringify(k?.detail)}`; failedChecks = [c.mustHave]; }
    }
  }
  if (c.label === 'malicious') {
    if (verdict === 'reject' && c.catches && !c.catches.some((n) => failedChecks.includes(n))) extra.push(`${c.id}: rejected, but not by the intended check (${c.catches.join(' or ')}); failed: ${failedChecks.join(', ')}`);
    if (verdict === 'reject' && env && !c.needsPython) {
      const tsOnly = (await run(false)).filter((k) => !k.ok);
      if (!tsOnly.length) extra.push(`${c.id}: not marked needsPython but accepted by the TypeScript checks alone`);
    }
  }
  outcomes.push({ ...base, verdict, stage: verdict === 'reject' ? 'validate' : 'none', reason, failedChecks, ms: Date.now() - t0 });
}

const n = (l: string) => cases.filter((c) => c.label === l).length;
process.exit(finish(NAME, 'Blueprint validator eval', outcomes, [
  `Fixed corpus of ${cases.length} agent packages (${n('benign')} benign, ${n('malicious')} hostile): a regression gate, not a proof that every hostile agent is caught.`,
  `The real Python compiler bridge and the Skills Guard persona scanner ${env ? 'were used' : 'were NOT available, so cases marked needsPython were skipped (not passed)'}.`,
  'The catalog is an in-memory fake that models row-level security (a hidden row answers not_visible); the SQL policies themselves are tested elsewhere.',
  'The persona scan is the vendored Skills Guard heuristic: it catches the usual prompt-injection and exfiltration phrasings, not every paraphrase. See known gaps.',
  'A malicious case rejected by a check other than the intended one fails the gate: it proves nothing about the intended defence.',
], extra));
