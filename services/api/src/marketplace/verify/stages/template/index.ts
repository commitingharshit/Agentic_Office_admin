// The template verification pipeline (Plan 4, Task 3). Registered at import. Stage order is the plan's.
// Each stage is a pure function of (package bytes, injected tools): no tool => `skipped: tool-missing:<name>`.
import { validateArtifact } from '../../../validate/index.ts';
import { registerPipeline } from '../../registry.ts';
import type { Evidence, StageDef } from '../../types.ts';
import { failWith } from './common.ts';
import { docxStructure } from './docxStructure.ts';
import { formulaValidity } from './formulaValidity.ts';
import { issues } from './issues.ts';
import { kernelIndex } from './kernelIndex.ts';
import { ooxmlSchema } from './ooxmlSchema.ts';
import { previewFidelity } from './previewFidelity.ts';
import { renderPages } from './renderPages.ts';
import { visualSanity } from './visualSanity.ts';

/**
 * Stage 1 reuses the existing validator (common checks + validate/template.ts static checks) instead of duplicating it.
 * Its own `officecli-open` check is dropped when it was skipped for lack of a renderer: `render-pages` is that check here.
 */
export const manifest: StageDef = {
  id: 'manifest', title: 'Package and template static checks', required: true, timeoutMs: 20_000,
  async run(ctx) {
    const report = await validateArtifact('template', ctx.pkg);
    const checks = report.checks.filter(c => !(c.name === 'officecli-open' && c.skipped));
    const ev: Evidence[] = checks.map(c => ({ kind: 'check' as const, label: c.skipped ? `${c.name} (skipped)` : c.name, ...(c.detail ? { detail: c.detail } : {}) }));
    const failed = checks.filter(c => !c.ok);
    return failed.length ? failWith(`manifest-checks-failed: ${failed.map(c => c.name).join(', ')}`.slice(0, 500), ev) : { status: 'pass', evidence: ev };
  },
};

export const TEMPLATE_STAGES: StageDef[] = [manifest, ooxmlSchema, kernelIndex, issues, formulaValidity, docxStructure, renderPages, visualSanity, previewFidelity];

registerPipeline({ type: 'template', name: 'template', version: 1, stages: TEMPLATE_STAGES });
