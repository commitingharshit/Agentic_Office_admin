import type { Evidence, StageDef } from '../../types.ts';
import { failWith, kernelMissing, kernelTimedOut, notApplicable, noFile, skipped, templateFile } from './common.ts';

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : [];
const sheetOf = (part: unknown) => String(part ?? '').replace(/^.*\//, '');
const MAX_ADDR = 40;

/**
 * Stage 5 (xlsx only): `xlsx-context detect-broken` (cached error values, #REF!, dangling sheet refs) and
 * `audit-circularity` (Tarjan SCC). Any finding in either fails, with cell addresses as evidence. audit-formulas /
 * audit-hardcodes are deliberately not run: templates legitimately contain inputs (plan: evidence only, no gate).
 */
export const formulaValidity: StageDef = {
  id: 'formula-validity', title: 'Formula validity (xlsx kernel)', required: true, timeoutMs: 90_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (t.format !== 'xlsx') return notApplicable(t.format);
    if (!ctx.tools.kernel) return skipped('tool-missing:kernel');
    const calls = [
      ['detect-broken', '{db}', '{doc}', '--rebuild'],
      ['audit-circularity', '{db}', '{doc}', '--rebuild'],
    ];
    const findings: string[] = [];
    const ev: Evidence[] = [];
    for (const args of calls) {
      const r = await ctx.tools.kernel.run('xlsx', args, t.bytes);
      const missing = kernelMissing(r);
      if (missing) return skipped(missing);
      if (kernelTimedOut(r)) return failWith('timeout', [{ kind: 'check', label: `${args[0]} timed out`, detail: r.stderr.slice(0, 300) }]);
      if (r.code !== 0) return failWith(`kernel-error: ${args[0]} exited ${r.code}`, [{ kind: 'log', label: args[0], detail: r.stderr.slice(0, 1000) }]);
      const j = (r.json ?? {}) as Rec;
      if (args[0] === 'detect-broken') {
        for (const f of arr(j.broken_refs_in_formula)) findings.push(`${sheetOf(f.part)}!${String(f.cell)}: broken reference in =${String(f.formula)}`);
        for (const f of arr(j.dangling_sheet_refs)) findings.push(`${sheetOf(f.part)}!${String(f.cell)}: references missing sheet ${JSON.stringify(String(f.missing_sheet))}`);
        for (const f of arr(j.error_values)) findings.push(`${sheetOf(f.part)}!${String(f.cell)}: cached error value ${String(f.error)}`);
      } else {
        for (const c of arr(j.cycles)) findings.push(`circular reference: ${(Array.isArray(c.cells) ? c.cells : []).slice(0, 8).join(' -> ')}${c.self_reference ? ' (self reference)' : ''}`);
      }
    }
    for (const f of findings.slice(0, MAX_ADDR)) ev.push({ kind: 'check', label: 'formula finding', detail: f });
    if (findings.length > MAX_ADDR) ev.push({ kind: 'text', label: 'findings truncated', detail: `${findings.length} findings in total` });
    return findings.length ? failWith(`formula-findings: ${findings.length}`, ev) : { status: 'pass', evidence: [{ kind: 'check', label: 'detect-broken and audit-circularity', detail: 'no findings' }] };
  },
};
