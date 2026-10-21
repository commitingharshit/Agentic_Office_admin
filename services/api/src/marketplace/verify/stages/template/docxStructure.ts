import type { Evidence, StageDef } from '../../types.ts';
import { failWith, kernelMissing, kernelTimedOut, notApplicable, noFile, skipped, templateFile } from './common.ts';

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : [];

/**
 * Stage 6 (docx only): `docpatch resolve --mode all`. Blocking: unresolved cross-references that name a NUMBER
 * (section 9, table 4, figure 2: the target heading/caption is missing). Evidence only, because the kernel flags the
 * repo's own good templates for them (measured: board-memo.docx and meeting-notes.docx): heading numbering mismatches
 * (meeting-notes: typed "1." computed "0.1" for headings under no level-1 parent), unresolved references with a
 * letter label ("Appendix A": the kernel's appendix numbering counts 1, 2 and cannot match A) and `seq` caption
 * mismatches. Blocking those would reject the repo's own templates for a kernel limitation.
 */
export const docxStructure: StageDef = {
  id: 'docx-structure', title: 'Document structure (docpatch resolve)', required: true, timeoutMs: 60_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (t.format !== 'docx') return notApplicable(t.format);
    if (!ctx.tools.kernel) return skipped('tool-missing:kernel');
    const r = await ctx.tools.kernel.run('docpatch', ['resolve', '{db}', '--doc-id', '{doc}', '--mode', 'all'], t.bytes);
    const missing = kernelMissing(r);
    if (missing) return skipped(missing);
    if (kernelTimedOut(r)) return failWith('timeout', [{ kind: 'check', label: 'docpatch resolve timed out', detail: r.stderr.slice(0, 300) }]);
    if (r.code !== 0) return failWith(`kernel-error: resolve exited ${r.code}`, [{ kind: 'log', label: 'docpatch resolve', detail: r.stderr.slice(0, 1000) }]);
    const j = (r.json ?? {}) as Rec;
    const numbering = (j.numbering ?? {}) as Rec, refs = (j.references ?? {}) as Rec, seq = (j.seq_captions ?? {}) as Rec;
    const block: Evidence[] = [], note: Evidence[] = [];
    for (const h of arr(numbering.headings)) if (h.match === false) note.push({ kind: 'check', label: 'heading numbering mismatch (evidence only)', detail: `${JSON.stringify(String(h.text)).slice(0, 120)}: typed ${String(h.actual_number)}, computed ${String(h.computed_number)}` });
    for (const x of arr(refs.references)) {
      if (x.resolved !== false) continue;
      const e: Evidence = { kind: 'check', label: x.number !== undefined && /^\d+$/.test(String(x.number)) ? 'unresolved cross-reference' : 'unresolved lettered reference (evidence only)', detail: `${JSON.stringify(String(x.ref_text))}: no ${String(x.keyword)} ${String(x.number)} in the document` };
      (/^\d+$/.test(String(x.number)) ? block : note).push(e);
    }
    const seqBad = arr(seq.captions).filter(c => c.match === false).length;
    if (seqBad) note.push({ kind: 'check', label: 'caption numbering differs from computed (evidence only)', detail: `${seqBad} caption(s)` });
    const ev = [...block.slice(0, 25), ...note.slice(0, 10)];
    return block.length ? failWith(`unresolved-structure: ${block.length} finding(s)`, ev) : { status: 'pass', evidence: ev.length ? ev : [{ kind: 'check', label: 'resolve --mode all', detail: 'numbering and references resolve' }] };
  },
};
