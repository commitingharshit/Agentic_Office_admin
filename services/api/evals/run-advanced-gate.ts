// Hostile-corpus gate for the advanced types (Plan 3 Task 13). Run: node evals/run-advanced-gate.ts   (npm run eval:advanced)
// Prints a per-type confusion matrix, writes results/advanced-gate.{json,md} (deterministic, no timestamps), exits 1 when a gate fails.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAdvancedGate, loadCorpora, MIN_CASES } from './advanced-gate.ts';
import { gapsFor, here } from './lib.ts';

const gaps = new Map([...gapsFor('advanced-gate')].map(([k, v]) => [k, v] as [string, string]));
const r = await evaluateAdvancedGate(await loadCorpora(), gaps);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log('\n== Advanced types hostile-corpus gate ==\n');
console.log('type        benign mal  TP   FN   FP   TN   crash recall   precision FPR     floor');
for (const t of r.perType) console.log(`${t.type.padEnd(11)} ${String(t.benign).padStart(6)} ${String(t.malicious).padStart(4)} ${String(t.tp).padStart(4)} ${String(t.fn).padStart(4)} ${String(t.fp).padStart(4)} ${String(t.tn).padStart(4)} ${String(t.crashes).padStart(5)} ${pct(t.recall).padStart(7)} ${pct(t.precision).padStart(9)} ${pct(t.falsePositiveRate).padStart(7)} ${MIN_CASES[t.type]}`);
const hookScript = 'hook-script (mode script): not run. Script hooks are off (standing security ruling, Plan 3 T10 not implemented), so there are no per-host-class results and nothing is counted as passed.';
console.log(`\n${hookScript}`);
for (const n of r.notes) console.log(`note: ${n}`);
console.log(r.failures.length ? `\nGATE FAILED:\n- ${r.failures.join('\n- ')}` : '\nGATE PASSED');

const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'advanced-gate.json'), JSON.stringify({ eval: 'advanced-gate', passed: r.exitCode === 0, minCases: MIN_CASES, perType: r.perType, knownGapsOpen: r.knownGapsOpen, notes: r.notes, failures: r.failures, scriptHooks: 'not run: script mode is off', cases: r.results }, null, 2) + '\n');
writeFileSync(join(outDir, 'advanced-gate.md'), [
  '# Advanced types hostile-corpus gate', '',
  `Result: **${r.exitCode ? 'FAILED' : 'passed'}**. Gates: 100% recall on the malicious set (known gaps in \`evals/known-gaps.json\` excepted), 0 false positives on the benign set, a corpus size floor per type, no validator crash counted as detection.`, '',
  '| type | benign | malicious | TP | FN | FP | TN | crashes | recall | precision | FPR | floor |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...r.perType.map((t) => `| ${t.type} | ${t.benign} | ${t.malicious} | ${t.tp} | ${t.fn} | ${t.fp} | ${t.tn} | ${t.crashes} | ${pct(t.recall)} | ${pct(t.precision)} | ${pct(t.falsePositiveRate)} | ${MIN_CASES[t.type]} |`), '',
  `- ${hookScript}`, ...(r.knownGapsOpen.length ? ['', '## Known gaps', ...r.knownGapsOpen.map((g) => `- ${g}`)] : []), ...(r.failures.length ? ['', '## Failures', ...r.failures.map((f) => `- ${f}`)] : []), '',
  '## Limits', '', '- Fixed corpora over static validators: a regression gate, not a proof that every hostile package is caught.',
  '- Where a case records the check that must reject it (`catches`), a rejection by a different check fails the gate.',
  '- The Hermes-side handler corpora run separately: `cd vendor/hermes-agent && python -m pytest tests/hermes_cli/marketplace_ext -q`.', '',
].join('\n'));
process.exit(r.exitCode);
