import { sha256Hex } from '../../../artifacts.ts';
import type { UnpackedPackage } from '../../../types.ts';
import type { Evidence, PipelineTools, StageContext, StageDef } from '../../types.ts';
import { noFile, notApplicable, skipped, templateFile, toolFailure } from './common.ts';
import { pngSize } from './png.ts';

/** Starting value from the plan; Task 7 measures render time per page and may lower it. */
export const MAX_PAGES = 60;
const KEEP_IMAGES = 12;
export interface Rendered { pages: { png: Uint8Array; page: number }[]; totalPages: number; viewport: { width: number; height: number } }

/** Viewport follows the aspect of the first declared preview so the fidelity comparison is like for like. */
function viewportFor(pkg: UnpackedPackage, previews: string[]): { width: number; height: number } {
  const first = previews[0] ? pkg.files.get(previews[0]) : undefined;
  try {
    if (first) { const { width, height } = pngSize(first); if (width && height) return { width: 900, height: Math.min(2400, Math.max(200, Math.round(900 * height / width))) }; }
  } catch { /* JPEG or corrupt preview: default viewport */ }
  return { width: 900, height: 700 };
}

// One render per (package, tools) pair, shared by render-pages, visual-sanity and preview-fidelity. A failed render is cached
// as the rejection, and the dependents are skipped by `after: ['render-pages']` before they ever read it.
const cache = new WeakMap<UnpackedPackage, WeakMap<object, Promise<Rendered>>>();
export function renderOnce(ctx: StageContext): Promise<Rendered> {
  const t = templateFile(ctx.pkg), oc = ctx.tools.officecli;
  if (!t || !oc || t.format === 'pdf') return Promise.reject(new Error('render not possible'));
  let byTools = cache.get(ctx.pkg); if (!byTools) cache.set(ctx.pkg, byTools = new WeakMap());
  let p = byTools.get(ctx.tools as PipelineTools);
  if (!p) {
    const viewport = viewportFor(ctx.pkg, t.previews);
    p = oc.renderPages(t.bytes, t.format, { maxPages: MAX_PAGES, ...viewport, signal: ctx.signal }).then(r => ({ ...r, viewport }));
    p.catch(() => { /* surfaced by the awaiting stage */ });
    byTools.set(ctx.tools as PipelineTools, p);
  }
  return p;
}

/** Stage 7: render every page/slide up to MAX_PAGES. Coverage is stated as text, never rounded up to "verified". */
export const renderPages: StageDef = {
  id: 'render-pages', title: 'Render every page or slide (officecli screenshot)', required: true, timeoutMs: 300_000, after: ['manifest'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    if (t.format === 'pdf') return notApplicable('pdf'); // officecli does not open PDFs; preview-fidelity/visual stages then skip as prerequisites
    if (!ctx.tools.officecli) return skipped('tool-missing:officecli');
    let r: Rendered;
    try { r = await renderOnce(ctx); } catch (e) { return toolFailure(e); }
    if (!r.pages.length) return { status: 'fail', reason: 'no-pages-rendered', evidence: [] };
    const known = r.totalPages;
    const ev: Evidence[] = [r.pages.length >= known
      ? { kind: 'text', label: `rendered ${r.pages.length} of ${known} page(s)` }
      : { kind: 'text', label: `rendered ${r.pages.length} of ${known} pages`, detail: `capped at ${MAX_PAGES}; the rest were not rendered` }];
    if (t.format !== 'pptx') ev.push({ kind: 'text', label: 'coverage: page 1 only', detail: `officecli reports no page count for ${t.format}; its html render is a single viewport` });
    const hashed: string[] = [];
    for (const p of r.pages) {
      if (p.page <= KEEP_IMAGES) {
        try { ev.push({ kind: 'image', label: `page ${p.page} render`, blob: await ctx.evidence.addBlob('image/png', p.png) }); continue; } catch { /* over the evidence cap: hash only */ }
      }
      hashed.push(`${p.page}:${sha256Hex(p.png).slice(0, 16)}`);
    }
    // The per-stage evidence cap is 50 items: pages past the image budget are one compact item (page:sha256 prefix), not one each.
    if (hashed.length) ev.push({ kind: 'json', label: `${hashed.length} page render(s) hashed only (page:sha256[0..16])`, detail: hashed.join(' ').slice(0, 2000) });
    return { status: 'pass', evidence: ev };
  },
};
