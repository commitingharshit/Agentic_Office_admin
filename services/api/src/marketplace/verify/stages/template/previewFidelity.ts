import type { Evidence, Measured, StageDef } from '../../types.ts';
import { failWith, noFile, skipped, templateFile } from './common.ts';
import { decodePng, gridMad, gridSsim, inkFraction, lumaGrid, PngError } from './png.ts';
import { INK_FLOOR } from './visualSanity.ts';
import { renderOnce } from './renderPages.ts';

/**
 * Deterministic, model-free thresholds on a 64x64 luma grid. MEASURED over the repo's 13 docx/pptx/xlsx templates (own
 * preview vs own fresh officecli render, and every other template's render as the negative), 2026-10-21:
 *   pptx  own: mad 0.002-0.003, ssim 1.00      others: mad >= 0.057, ssim <= 0.60      => discriminating; thresholds sit between
 *   docx  own: mad 0.037-0.062, ssim 0.46-0.69 others: mad >= 0.031, ssim <= 0.78      => NOT discriminating
 *   xlsx  own: mad 0.12-0.20,  ssim 0.13-0.28  others: mad >= 0.086, ssim <= 0.42      => NOT discriminating
 * The repo's pptx thumbnails are officecli renders, the docx/xlsx thumbnails are not (different engine, different
 * chrome), so a pixel comparison only means something for pptx. Finer grids (200x200) and row-ink profiles did not
 * separate docx or xlsx either. Elsewhere the decision needs the injected comparator (CLIP/DINO worker, Task 5).
 */
export const FIDELITY = { grid: 64, madMax: 0.02, ssimMin: 0.9 } as const;
export const DETERMINISTIC_FORMATS: ReadonlySet<string> = new Set(['pptx']);
const measuredOk = (m: Measured) => m.op === '>=' ? m.value >= m.threshold : m.op === '<=' ? m.value <= m.threshold : m.value === m.threshold;

/**
 * Stage 9: each declared preview against the fresh render of the same page/slide (preview i <-> page i). Purpose: the
 * preview users see is the template they get (anti bait-and-switch), not a quality opinion. The decision is the pixel
 * (luma MAD) and SSIM comparison alone (pptx; see FIDELITY for why not docx/xlsx); CLIP/DINO from `tools.visual.compare` are evidence next to it, and missing
 * models are noted, never a skip of the stage.
 */
export const previewFidelity: StageDef = {
  id: 'preview-fidelity', title: 'Previews match fresh renders (pixel and SSIM)', required: true, timeoutMs: 60_000, after: ['render-pages'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    let r;
    try { r = await renderOnce(ctx); } catch (e) { return skipped(`prerequisite-failed:render-pages (${e instanceof Error ? e.message.slice(0, 120) : 'render'})`); }
    const ev: Evidence[] = [], mismatched: string[] = [];
    let compared = 0;
    if (!ctx.tools.visual?.compare && !DETERMINISTIC_FORMATS.has(t.format)) {
      // The pixel/SSIM comparison was measured NOT to discriminate for this format (see FIDELITY). The one deterministic
      // verdict still available is gross: a blank or black preview over a render that has content is bait-and-switch.
      for (let i = 0; i < t.previews.length; i++) {
        const bytes = ctx.pkg.files.get(t.previews[i]), page = r.pages[i];
        if (!bytes || !page) continue;
        try {
          const pi = inkFraction(decodePng(bytes)), ri = inkFraction(decodePng(page.png));
          ev.push({ kind: 'check', label: `preview ${t.previews[i]}: ink-fraction`, measured: { name: 'ink-fraction', value: Number(pi.toFixed(4)), threshold: INK_FLOOR, op: '>=' } });
          if (pi < INK_FLOOR && ri >= INK_FLOOR) mismatched.push(t.previews[i]);
        } catch (e) { ev.push({ kind: 'check', label: `preview ${t.previews[i]} not readable`, detail: e instanceof PngError ? e.message : String(e).slice(0, 200) }); }
      }
      if (mismatched.length) return failWith(`preview-blank: ${mismatched.join(', ').slice(0, 300)}`, ev);
      return skipped(`not-discriminating:${t.format}: the pixel/SSIM comparison does not separate ${t.format} previews from other templates (they are not produced by this renderer); needs the visual comparator`, { evidence: ev });
    }
    for (let i = 0; i < t.previews.length; i++) {
      const path = t.previews[i], bytes = ctx.pkg.files.get(path), page = r.pages[i];
      if (!bytes) { ev.push({ kind: 'check', label: `preview ${path}`, detail: 'not in the package' }); continue; }
      if (!page) { ev.push({ kind: 'check', label: `preview ${path} (preview ${i + 1})`, detail: `no rendered page ${i + 1} to compare (rendered ${r.pages.length})` }); continue; }
      try {
        let pixel: Measured, ssim: Measured, extra: (Measured | undefined)[] = [];
        if (ctx.tools.visual?.compare) {
          const c = await ctx.tools.visual.compare(bytes, page.png, { clip: true, dino: true });
          pixel = c.pixel; ssim = c.ssim; extra = [c.clip, c.dino];
        } else {
          const a = lumaGrid(decodePng(bytes), FIDELITY.grid, FIDELITY.grid), b = lumaGrid(decodePng(page.png), FIDELITY.grid, FIDELITY.grid);
          pixel = { name: 'luma-mad', value: Number(gridMad(a, b).toFixed(4)), threshold: FIDELITY.madMax, op: '<=' };
          ssim = { name: 'luma-ssim', value: Number(gridSsim(a, b, FIDELITY.grid, FIDELITY.grid).toFixed(4)), threshold: FIDELITY.ssimMin, op: '>=' };
          ev.push({ kind: 'text', label: 'clip and dino not run', detail: 'tool-missing:visual (model-missing:clip-vit-base-patch32); the pixel/SSIM comparison decides' });
        }
        compared++;
        const ok = measuredOk(pixel) && measuredOk(ssim);
        ev.push({ kind: 'check', label: `preview ${path} vs page ${i + 1}: ${pixel.name}`, measured: pixel }, { kind: 'check', label: `preview ${path} vs page ${i + 1}: ${ssim.name}`, measured: ssim });
        for (const m of extra) if (m) ev.push({ kind: 'check', label: `preview ${path}: ${m.name} (evidence only)`, measured: m });
        if (!ok) mismatched.push(path);
      } catch (e) {
        ev.push({ kind: 'check', label: `preview ${path} not comparable`, detail: e instanceof PngError ? `${e.message} (only PNG previews are compared deterministically)` : String(e).slice(0, 200) });
      }
    }
    if (mismatched.length) return failWith(`preview-mismatch: ${mismatched.join(', ').slice(0, 300)}`, ev);
    if (!compared) return skipped('no-comparable-preview: no declared preview could be decoded and paired with a rendered page', { evidence: ev });
    return { status: 'pass', evidence: ev };
  },
};
