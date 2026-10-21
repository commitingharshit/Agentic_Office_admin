import type { StageDef } from '../../types.ts';
import { failWith, notApplicable, noFile, skipped, templateFile, toolFailure, type Format } from './common.ts';

/**
 * Stage 4 blocking set: the officecli issue subtypes that fail the stage. This constant is the thing a reviewer argues
 * about; each entry says why. Everything else officecli reports is attached as `check` evidence and never changes status.
 */
export const BLOCKING_ISSUES: Record<Exclude<Format, 'pdf'>, Record<string, string>> = {
  xlsx: {
    formula_eval_error: 'a formula evaluates to an error (#REF!, #DIV/0!, ...): the template ships a broken calculation',
    formula_ref_missing_sheet: 'a formula points at a sheet that does not exist: Excel shows #REF!',
    definedname_broken: 'a defined name is unresolvable: every formula using it breaks',
    definedname_target_missing: 'a defined name targets a missing sheet or range',
    chart_series_ref_missing_sheet: 'a chart series reads a sheet that does not exist: the chart renders empty',
  },
  pptx: {
    broken_part_ref: 'a relationship targets a part that is not in the package: PowerPoint offers to repair the file',
    notes_unresolved_rid: 'a notes slide relationship id does not resolve: the deck opens with a repair prompt',
  },
  docx: {}, // no docx subtype is blocking: field_* findings are routine in templates (fields refresh on open)
};
const MAX_BLOCKING_EVIDENCE = 20, MAX_OTHER_EVIDENCE = 15;

export const issues: StageDef = {
  id: 'issues', title: 'Document issues (officecli view issues)', required: true, timeoutMs: 60_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (t.format === 'pdf') return notApplicable('pdf');
    if (!ctx.tools.officecli) return skipped('tool-missing:officecli');
    try {
      const all = await ctx.tools.officecli.issues(t.bytes, t.format);
      const block = BLOCKING_ISSUES[t.format];
      const blocking = all.filter(i => Object.hasOwn(block, i.type)), other = all.filter(i => !Object.hasOwn(block, i.type));
      const ev = [
        ...blocking.slice(0, MAX_BLOCKING_EVIDENCE).map(i => ({ kind: 'check' as const, label: `blocking: ${i.type}${i.path ? ` at ${i.path}` : ''}`, detail: `${i.message}\nwhy blocking: ${block[i.type]}` })),
        ...other.slice(0, MAX_OTHER_EVIDENCE).map(i => ({ kind: 'check' as const, label: `${i.type}${i.path ? ` at ${i.path}` : ''}`, detail: i.message })),
      ];
      if (blocking.length > MAX_BLOCKING_EVIDENCE || other.length > MAX_OTHER_EVIDENCE) ev.push({ kind: 'text' as const, label: 'issue list truncated', detail: `${blocking.length} blocking and ${other.length} other issues in total` });
      if (blocking.length) return failWith(`blocking-issues: ${[...new Set(blocking.map(b => b.type))].join(', ')}`, ev);
      ev.unshift({ kind: 'check' as const, label: 'no blocking issues', detail: `${other.length} non-blocking finding(s) attached` });
      return { status: 'pass', evidence: ev };
    } catch (e) { return toolFailure(e); }
  },
};
