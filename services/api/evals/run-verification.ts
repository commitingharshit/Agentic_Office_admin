// Verification-pipeline eval (Plan 4 Task 7): the corpus in verification-corpus/ through the REAL template pipeline with the REAL tools
// (officecli, the Rust kernels) when they are installed. Run: node evals/run-verification.ts [--allow-skip <reason-or-tool>,...]  (npm run eval:verification)
//   benign   verdict must not be `fail` (false positive otherwise); `incomplete` is allowed only for skips named by --allow-skip.
//   hostile  verdict `fail`, or refused at unpack (detected).    broken  verdict `fail` AND one of the case's `catches` stages failed.
//   A case whose tool is absent is SKIPPED: counted, printed, never passed; the gate fails unless that tool is named by --allow-skip.
//   An empty corpus exits 1. Required stages skipped on benign cases are counted per reason and must be covered by --allow-skip.
// Results (evals/results/verification.{json,md}) are deterministic: no timestamps, no durations, no scores.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnpackError, unpack } from '../src/marketplace/artifacts.ts';
import { getPipeline } from '../src/marketplace/verify/registry.ts';
import '../src/marketplace/verify/stages/template/index.ts';
import { memoryEvidenceSink } from '../src/marketplace/verify/evidence.ts';
import { runPipeline } from '../src/marketplace/verify/runner.ts';
import { createKernelTool, kernelBinaryPath } from '../src/marketplace/verify/tools/kernelTool.ts';
import { createOfficecliTool, officecliAvailable } from '../src/marketplace/verify/tools/officecliTool.ts';
import type { PipelineResult, PipelineTools } from '../src/marketplace/verify/types.ts';
import { here } from './lib.ts';
import { vcases, type Tool, type VCase } from './verification-corpus/index.ts';

export interface VOutcome { id: string; label: VCase['label']; verdict: PipelineResult['verdict'] | 'refused-at-unpack' | 'skipped'; failedStages: string[]; skippedRequired: { stage: string; reason: string }[]; why?: string; measured?: Record<string, string> }
export interface VGate { failures: string[]; outcomes: VOutcome[]; skippedCases: string[]; skippedStageReasons: Record<string, number> }


export async function evaluate(cases: VCase[], tools: PipelineTools, have: Record<Tool, boolean>, allowSkip: string[]): Promise<VGate> {
  const failures: string[] = [], outcomes: VOutcome[] = [], skippedCases: string[] = [], reasons: Record<string, number> = {};
  if (!cases.length) failures.push('the corpus is empty: refusing to pass on zero cases');
  for (const lab of ['benign', 'hostile', 'broken'] as const) if (cases.length && !cases.some((c) => c.label === lab)) failures.push(`no ${lab} cases: that class gates nothing`);
  const allowed = (r: string) => allowSkip.some((a) => r.includes(a));
  for (const c of cases) {
    const missing = c.needs.filter((t) => !have[t]);
    if (missing.length) { outcomes.push({ id: c.id, label: c.label, verdict: 'skipped', failedStages: [], skippedRequired: [], why: `tool-missing:${missing.join(',')}` }); skippedCases.push(c.id); if (!missing.every((m) => allowSkip.includes(m))) failures.push(`${c.id}: skipped (tool-missing:${missing.join(',')}) and not covered by --allow-skip`); continue; }
    let r: PipelineResult;
    try {
      const pkg = unpack(c.build());
      r = await runPipeline('template', pkg, tools, { evidence: memoryEvidenceSink() });
    } catch (e) {
      if (e instanceof UnpackError) { outcomes.push({ id: c.id, label: c.label, verdict: 'refused-at-unpack', failedStages: [`unpack:${e.code}`], skippedRequired: [] }); if (c.label === 'benign') failures.push(`${c.id}: false positive, a benign package was refused at unpack (${e.code})`); continue; }
      outcomes.push({ id: c.id, label: c.label, verdict: 'fail', failedStages: ['crash'], skippedRequired: [], why: 'crash' }); failures.push(`${c.id}: the pipeline crashed (${(e as Error).message.slice(0, 120)}); a crash is not a detection`); continue;
    }
    const failed = r.stages.filter((s) => s.status === 'fail').map((s) => s.id);
    const skippedRequired = r.stages.filter((s) => s.required && s.status === 'skipped').map((s) => ({ stage: s.id, reason: String(s.reason ?? '') }));
    const measured: Record<string, string> = {};
    for (const s of r.stages) for (const e of s.evidence) if (e.measured && (s.id === 'preview-fidelity' || s.id === 'visual-sanity')) measured[`${s.id}:${e.measured.name}`] = `${e.measured.value} ${e.measured.op} ${e.measured.threshold}`;
    outcomes.push({ id: c.id, label: c.label, verdict: r.verdict, failedStages: failed, skippedRequired, ...(Object.keys(measured).length ? { measured } : {}) });
    if (c.label === 'benign') {
      if (r.verdict === 'fail') failures.push(`${c.id}: false positive, a benign package failed ${failed.join(', ')}`);
      for (const s of skippedRequired) { reasons[s.reason] = (reasons[s.reason] ?? 0) + 1; if (!allowed(s.reason)) failures.push(`${c.id}: required stage ${s.stage} skipped (${s.reason}), not covered by --allow-skip`); }
    } else if (r.verdict !== 'fail') failures.push(`${c.id}: ${c.label} package ended ${r.verdict}, not fail`);
    else if (c.label === 'broken' && c.catches && !c.catches.some((s) => failed.includes(s))) failures.push(`${c.id}: failed, but not at the expected stage (${c.catches.join(' or ')}); failed: ${failed.join(', ')}`);
  }
  return { failures, outcomes, skippedCases, skippedStageReasons: reasons };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), ai = args.indexOf('--allow-skip');
  const allowSkip = ai >= 0 ? (args[ai + 1] ?? '').split(',').filter(Boolean) : [];
  const have: Record<Tool, boolean> = { officecli: await officecliAvailable(), kernel: (['xlsx', 'docpatch', 'pptx', 'pdf'] as const).every((k) => kernelBinaryPath(k)) };
  const tools: PipelineTools = { ...(have.officecli ? { officecli: createOfficecliTool({ timeoutMs: 180_000, perPageTimeoutMs: 180_000 }) } : {}), ...(have.kernel ? { kernel: createKernelTool({ timeoutMs: 120_000 }) } : {}) };
  const def = getPipeline('template');
  const g = await evaluate(vcases, tools, have, allowSkip);
  const n = (l: string) => g.outcomes.filter((o) => o.label === l);
  const det = (l: 'hostile' | 'broken') => n(l).filter((o) => o.verdict === 'fail' || o.verdict === 'refused-at-unpack').length;
  console.log(`\n== Verification pipeline eval ==\ncorpus: ${vcases.length} cases (${n('benign').length} benign, ${n('hostile').length} hostile, ${n('broken').length} broken); pipeline ${def?.name} v${def?.version}; tools: officecli=${have.officecli} kernel=${have.kernel}; allow-skip: ${allowSkip.join(',') || '(none)'}`);
  const evaluated = (l: string) => n(l).filter((o) => o.verdict !== 'skipped').length;
  console.log(`benign verdict fail (false positives): ${n('benign').filter((o) => o.verdict === 'fail' || o.verdict === 'refused-at-unpack').length}/${evaluated('benign')}; hostile detected: ${det('hostile')}/${evaluated('hostile')}; broken detected: ${det('broken')}/${evaluated('broken')}; skipped cases: ${g.skippedCases.length}`);
  for (const [r, k] of Object.entries(g.skippedStageReasons)) console.log(`required stage skipped on benign cases: ${k} x ${r}`);
  for (const o of g.outcomes) console.log(`${o.verdict === 'skipped' ? 'SKIP' : ((o.label === 'benign') === (o.verdict !== 'fail' && o.verdict !== 'refused-at-unpack')) ? 'ok  ' : 'FAIL'} ${o.label.padEnd(7)} ${o.id.padEnd(50)} ${o.verdict.padEnd(17)} ${o.failedStages.length ? `[${o.failedStages.join(',')}]` : ''}${o.why ? ` ${o.why}` : ''}`);
  console.log(g.failures.length ? `\nGATE FAILED:\n- ${g.failures.join('\n- ')}` : '\nGATE PASSED');
  const outDir = join(here, 'results'); mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'verification.json'), JSON.stringify({ eval: 'verification', pipeline: { name: def?.name, version: def?.version }, tools: have, allowSkip, passed: g.failures.length === 0, corpus: { total: vcases.length, benign: n('benign').length, hostile: n('hostile').length, broken: n('broken').length },
    skippedStageReasonsOnBenign: g.skippedStageReasons, skippedCases: g.skippedCases, failures: g.failures, cases: g.outcomes }, null, 2) + '\n');
  const calib = g.outcomes.filter((o) => o.measured && (o.label === 'benign' || o.id.startsWith('v05'))).map((o) => `| ${o.id} | ${o.label} | ${Object.entries(o.measured!).map(([k, v]) => `${k} ${v}`).join('; ')} |`);
  writeFileSync(join(outDir, 'verification.md'), [
    '# Verification pipeline eval', '', `Result: **${g.failures.length ? 'FAILED' : 'passed'}**. Pipeline ${def?.name} v${def?.version}. Tools present: officecli=${have.officecli}, kernel=${have.kernel}. \`--allow-skip\`: ${allowSkip.join(', ') || 'none'}.`, '',
    `Corpus: ${vcases.length} cases: ${n('benign').length} benign (real templates), ${n('hostile').length} hostile (the template-validator corpus), ${n('broken').length} valid-OOXML-but-broken.`, '',
    `- benign verdict \`fail\` (false positives): ${n('benign').filter((o) => o.verdict === 'fail' || o.verdict === 'refused-at-unpack').length} of ${evaluated('benign')}`, `- hostile detected: ${det('hostile')} of ${evaluated('hostile')}`, `- broken detected at the expected stage: ${det('broken')} of ${evaluated('broken')}`,
    `- skipped cases (tool missing): ${g.skippedCases.length}${g.skippedCases.length ? `: ${g.skippedCases.join(', ')}` : ''}`, '',
    '## Required stages skipped on benign cases', '', ...(Object.keys(g.skippedStageReasons).length ? Object.entries(g.skippedStageReasons).map(([r, k]) => `- ${k} x \`${r}\``) : ['- none']), '',
    '## Measured (preview fidelity), benign and the swapped-preview case', '', '| case | label | measured against its threshold |', '|---|---|---|', ...calib, '',
    ...(g.failures.length ? ['## Gate failures', '', ...g.failures.map((f) => `- ${f}`), ''] : []),
    '## Cases', '', '| case | label | verdict | failed stages |', '|---|---|---|---|', ...g.outcomes.map((o) => `| ${o.id} | ${o.label} | ${o.verdict}${o.why ? ` (${o.why})` : ''} | ${o.failedStages.join(', ') || '-'} |`), '',
    '## Limits', '', '- The visual comparator (CLIP/DINO worker) is not part of this run; preview fidelity is decided by the in-process pixel/SSIM check for pptx only. docx, xlsx and pdf end `incomplete` by design until a comparator exists.',
    '- No threshold was changed and `visual-sanity` stays non-required: four real decks are not enough to prove 0 false positives for its layout rules.', '- A regression gate over a fixed corpus, not a proof.', '',
  ].join('\n'));
  process.exit(g.failures.length ? 1 : 0);
}
