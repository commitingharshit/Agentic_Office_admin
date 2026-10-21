// Shared harness of the marketplace evals: a labelled corpus goes through the REAL validators, the outcomes become a
// confusion matrix (positive = malicious, "detected" = the package was rejected), and fixed gates decide the exit code.
// These are regression gates over a fixed corpus, not a security proof (see evals/README.md).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnpackError, unpack } from '../src/marketplace/artifacts.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import type { ListingType } from '../src/marketplace/types.ts';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..', '..');

export type Label = 'benign' | 'malicious';
export interface Case {
  id: string; label: Label; category: string; /** what the package is, and why it has that label */ note: string;
  build(): Uint8Array | Promise<Uint8Array>;
}
export interface Outcome {
  id: string; label: Label; category: string; note: string;
  verdict: 'accept' | 'reject'; stage: 'unpack' | 'validate' | 'none'; reason: string; failedChecks: string[];
  knownGap?: string; ms: number;
}
export interface KnownGap { id: string; reason: string }

export const GATES = { minRecall: 1.0, maxFalsePositiveRate: 0.10 };

/** unpack() then the registered validator of `type`: the same two steps the admin and creator ingest paths run. */
export async function judge(type: ListingType, bytes: Uint8Array): Promise<Pick<Outcome, 'verdict' | 'stage' | 'reason' | 'failedChecks'>> {
  let pkg;
  try { pkg = unpack(bytes); }
  catch (e) {
    if (e instanceof UnpackError) return { verdict: 'reject', stage: 'unpack', reason: `${e.code}: ${e.message}`.slice(0, 200), failedChecks: [`unpack:${e.code}`] };
    return { verdict: 'reject', stage: 'unpack', reason: String((e as Error)?.message ?? e).slice(0, 200), failedChecks: ['unpack:error'] };
  }
  const r = await validateArtifact(type, pkg);
  const bad = r.checks.filter((c) => !c.ok);
  if (bad.length) return { verdict: 'reject', stage: 'validate', reason: `${bad[0].name}: ${bad[0].detail ?? ''}`.slice(0, 200), failedChecks: bad.map((c) => c.name) };
  return { verdict: 'accept', stage: 'none', reason: r.verified ? 'all checks passed (verified)' : 'all checks passed (not verified)', failedChecks: [] };
}

function knownGaps(name: string): KnownGap[] {
  try { return (JSON.parse(readFileSync(join(here, 'known-gaps.json'), 'utf8'))[name] ?? []) as KnownGap[]; } catch { return []; }
}

export async function runEval(name: string, title: string, cases: Case[], type: ListingType, limits: string[]): Promise<number> {
  const gaps = new Map(knownGaps(name).map((g) => [g.id, g.reason]));
  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    const bytes = await c.build();
    const j = await judge(type, bytes);
    outcomes.push({ id: c.id, label: c.label, category: c.category, note: c.note, ...j, ...(gaps.has(c.id) ? { knownGap: gaps.get(c.id) } : {}), ms: Date.now() - t0 });
  }
  const mal = outcomes.filter((o) => o.label === 'malicious'), ben = outcomes.filter((o) => o.label === 'benign');
  const tp = mal.filter((o) => o.verdict === 'reject').length, fn = mal.length - tp;
  const fp = ben.filter((o) => o.verdict === 'reject').length, tn = ben.length - fp;
  const recall = mal.length ? tp / mal.length : 1;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const fpr = ben.length ? fp / ben.length : 0;
  const unexpectedMisses = mal.filter((o) => o.verdict === 'accept' && !o.knownGap);
  const documentedMisses = mal.filter((o) => o.verdict === 'accept' && o.knownGap);
  const staleGaps = mal.filter((o) => o.verdict === 'reject' && o.knownGap);
  const recallExcludingKnown = mal.length - documentedMisses.length ? (tp / (mal.length - documentedMisses.length)) : 1;
  const failures: string[] = [];
  if (unexpectedMisses.length) failures.push(`malicious accepted (not a known gap): ${unexpectedMisses.map((o) => o.id).join(', ')}`);
  if (fpr > GATES.maxFalsePositiveRate) failures.push(`false-positive rate ${(fpr * 100).toFixed(1)}% is over ${GATES.maxFalsePositiveRate * 100}%: ${ben.filter((o) => o.verdict === 'reject').map((o) => o.id).join(', ')}`);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const matrix = [
    '                      predicted reject   predicted accept',
    `  malicious (n=${String(mal.length).padEnd(3)})   ${String(tp).padStart(8)} (TP)      ${String(fn).padStart(8)} (FN)`,
    `  benign    (n=${String(ben.length).padEnd(3)})   ${String(fp).padStart(8)} (FP)      ${String(tn).padStart(8)} (TN)`,
  ].join('\n');

  // console
  console.log(`\n== ${title} ==\n\n${matrix}\n`);
  console.log(`recall ${pct(recall)} (${tp}/${mal.length})${documentedMisses.length ? `; excluding ${documentedMisses.length} documented known gap(s): ${pct(recallExcludingKnown)}` : ''}`);
  console.log(`precision ${pct(precision)} (${tp}/${tp + fp}); false-positive rate ${pct(fpr)} (${fp}/${ben.length})\n`);
  for (const o of outcomes) {
    const ok = o.label === 'malicious' ? o.verdict === 'reject' : o.verdict === 'accept';
    console.log(`${ok ? 'ok  ' : o.knownGap ? 'GAP ' : 'FAIL'} ${o.label.padEnd(9)} ${o.id.padEnd(34)} ${o.verdict.padEnd(6)} ${o.stage === 'none' ? '' : `[${o.failedChecks.join(',')}] `}${o.knownGap ? '(known gap) ' : ''}${o.ms}ms`);
  }
  for (const o of staleGaps) console.log(`note: known gap ${o.id} is now detected; remove it from evals/known-gaps.json`);
  if (failures.length) console.log(`\nGATE FAILED:\n- ${failures.join('\n- ')}`); else console.log('\nGATE PASSED');

  // files (deterministic: no timestamps or durations)
  const outDir = join(here, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify({
    eval: name, gates: GATES, passed: failures.length === 0,
    confusion: { truePositive: tp, falseNegative: fn, falsePositive: fp, trueNegative: tn },
    metrics: { recall, recallExcludingKnownGaps: recallExcludingKnown, precision, falsePositiveRate: fpr },
    knownGapsStillOpen: documentedMisses.map((o) => o.id), failures,
    cases: outcomes.map(({ ms: _ms, ...o }) => o),
  }, null, 2) + '\n');
  const row = (o: Outcome) => `| ${o.id} | ${o.label} | ${o.category} | ${o.verdict}${o.knownGap ? ' (known gap)' : ''} | ${o.failedChecks.join(', ') || '-'} |`;
  writeFileSync(join(outDir, `${name}.md`), [
    `# ${title}`, '',
    `Result: **${failures.length ? 'FAILED' : 'passed'}**. Gates: recall on the malicious set = 100% (known gaps listed in \`evals/known-gaps.json\` excepted), benign false-positive rate <= ${GATES.maxFalsePositiveRate * 100}%.`, '',
    '```', matrix, '```', '',
    `- recall ${pct(recall)} (${tp}/${mal.length})${documentedMisses.length ? `; ${pct(recallExcludingKnown)} excluding ${documentedMisses.length} documented known gap(s)` : ''}`,
    `- precision ${pct(precision)} (${tp}/${tp + fp})`,
    `- false-positive rate ${pct(fpr)} (${fp}/${ben.length})`, '',
    ...(documentedMisses.length ? ['## Known gaps (malicious, accepted today)', '', ...documentedMisses.map((o) => `- **${o.id}**: ${o.knownGap}`), ''] : []),
    ...(failures.length ? ['## Gate failures', '', ...failures.map((f) => `- ${f}`), ''] : []),
    '## Cases', '', '| case | label | category | verdict | failed checks |', '|---|---|---|---|---|', ...outcomes.map(row), '',
    '## Limits of this eval', '', ...limits.map((l) => `- ${l}`), '',
  ].join('\n'));
  return failures.length ? 1 : 0;
}
