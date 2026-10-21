import type { StageDef } from '../../types.ts';
import { failWith, notApplicable, noFile, skipped, templateFile, toolFailure } from './common.ts';

/** Stage 2: `officecli validate` (OpenXML schema). Any schema error or non-zero exit fails; PDF is not applicable. */
export const ooxmlSchema: StageDef = {
  id: 'ooxml-schema', title: 'OpenXML schema validation (officecli validate)', required: true, timeoutMs: 60_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (t.format === 'pdf') return notApplicable('pdf');
    if (!ctx.tools.officecli) return skipped('tool-missing:officecli');
    try {
      const r = await ctx.tools.officecli.validate(t.bytes, t.format);
      const lines = r.output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (r.ok) return { status: 'pass', evidence: [{ kind: 'check', label: 'officecli validate', detail: lines[0] ?? 'passed' }] };
      return failWith('schema-errors', [
        { kind: 'check', label: `officecli validate reported errors (showing ${Math.min(20, lines.length)} of ${lines.length} lines)` },
        { kind: 'text', label: 'first error lines', detail: lines.slice(0, 20).join('\n') },
      ]);
    } catch (e) { return toolFailure(e); }
  },
};
