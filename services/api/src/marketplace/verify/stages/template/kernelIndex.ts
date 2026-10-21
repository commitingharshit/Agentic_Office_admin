import type { StageDef } from '../../types.ts';
import { failWith, kernelMissing, kernelTimedOut, noFile, skipped, templateFile } from './common.ts';

const KERNEL = { docx: 'docpatch', pptx: 'pptx', xlsx: 'xlsx', pdf: 'pdf' } as const;

/**
 * Stage 3: the format's Rust kernel must be able to build its index (`map`) and the index must be non-empty.
 * Deviation from the plan text (measured here): `outline` is heading based and is `[]` for pptx, pdf and xlsx even for the
 * repo's own good templates, so "non-empty" is the kernel's `node_count`, not the outline.
 */
export const kernelIndex: StageDef = {
  id: 'kernel-index', title: 'Kernel index builds and is non-empty', required: true, timeoutMs: 60_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (!ctx.tools.kernel) return skipped('tool-missing:kernel');
    const r = await ctx.tools.kernel.run(KERNEL[t.format], ['map'], t.bytes);
    const missing = kernelMissing(r);
    if (missing) return skipped(missing);
    if (kernelTimedOut(r)) return failWith('timeout', [{ kind: 'check', label: 'kernel map timed out', detail: r.stderr.slice(0, 300) }]);
    if (r.code !== 0) return failWith('kernel-index-failed', [{ kind: 'log', label: `${KERNEL[t.format]} map exited ${r.code}`, detail: r.stderr.slice(0, 1000) }]);
    const j = (r.json ?? {}) as { node_count?: unknown; opaque_parts?: unknown };
    const nodes = typeof j.node_count === 'number' ? j.node_count : 0;
    const counts = { node_count: nodes, opaque_parts: Array.isArray(j.opaque_parts) ? j.opaque_parts.length : 0 };
    const ev = [{ kind: 'json' as const, label: `${KERNEL[t.format]} index element counts`, detail: JSON.stringify(counts) }];
    return nodes > 0 ? { status: 'pass', evidence: ev } : failWith('kernel-index-empty', ev);
  },
};
