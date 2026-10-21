import { gridKey, decodePng, inkFraction, lumaGrid, meanLuma, PngError } from './png.ts';
import type { Evidence, StageDef } from '../../types.ts';
import { failWith, noFile, skipped, templateFile } from './common.ts';
import { renderOnce } from './renderPages.ts';

/** Blank/black render floors, measured on the repo's own templates (see test/marketplace-verify-template.test.ts). */
export const INK_FLOOR = 0.002;   // fraction of pixels not in the dominant colour; a blank page is ~0
export const BLACK_LUMA = 6;      // mean luma 0..255 of an all-black render

/**
 * Stage 8: per rendered page, not blank, not black, decodable (a truncated PNG is a truncated render); a deck or document of
 * more than 2 pages whose pages are ALL identical is a stuck renderer. Some identical pages are legitimate (duplicated
 * slides) and are evidence only. The plan's "page larger than the declared slide size" check is not implemented: the
 * screenshots are fixed-viewport, so size says nothing about the document. `visual.layout()` findings (perception
 * checkDeck) are evidence only until Task 7 calibrates them; absent => noted, never a skip of this stage.
 */
export const visualSanity: StageDef = {
  id: 'visual-sanity', title: 'Per-page visual sanity (blank, black, truncated)', required: false, timeoutMs: 60_000, after: ['render-pages'],
  async run(ctx) {
    const t = templateFile(ctx.pkg);
    if (!t) return noFile();
    let r;
    try { r = await renderOnce(ctx); } catch (e) { return skipped(`prerequisite-failed:render-pages (${e instanceof Error ? e.message.slice(0, 120) : 'render'})`); }
    const bad: Evidence[] = [], keys: string[] = [];
    for (const p of r.pages) {
      try {
        const img = decodePng(p.png);
        const ink = inkFraction(img), luma = meanLuma(img);
        if (luma < BLACK_LUMA) bad.push({ kind: 'check', label: `page ${p.page} is black`, measured: { name: 'mean-luma', value: Number(luma.toFixed(2)), threshold: BLACK_LUMA, op: '>=' } });
        else if (ink < INK_FLOOR) bad.push({ kind: 'check', label: `page ${p.page} is blank`, measured: { name: 'ink-fraction', value: Number(ink.toFixed(5)), threshold: INK_FLOOR, op: '>=' } });
        keys.push(gridKey(lumaGrid(img, 32, 32)));
      } catch (e) {
        bad.push({ kind: 'check', label: `page ${p.page} render is not a readable PNG`, detail: e instanceof PngError ? e.message : String(e).slice(0, 200) });
        keys.push(`unreadable-${p.page}`);
      }
    }
    const ev: Evidence[] = [...bad];
    if (keys.length > 2 && keys.every(k => k === keys[0]) && !bad.length) bad.push({ kind: 'check', label: `all ${keys.length} pages render identically`, detail: 'a stuck or non-paginating renderer' });
    else if (keys.some((k, i) => i && k === keys[i - 1])) ev.push({ kind: 'check', label: 'consecutive identical pages (evidence only)', detail: `pages ${keys.map((k, i) => i && k === keys[i - 1] ? i + 1 : 0).filter(Boolean).join(', ')}` });
    if (ctx.tools.visual?.layout) {
      try {
        const findings = await ctx.tools.visual.layout(t.bytes, t.format);
        for (const f of findings.slice(0, 20)) ev.push({ kind: 'check', label: `layout ${f.rule} (slide ${f.slide})${f.blocking ? ' [advisory until calibrated]' : ''}`, detail: f.message });
      } catch (e) { ev.push({ kind: 'text', label: 'layout rules unavailable', detail: e instanceof Error ? e.message.slice(0, 200) : 'error' }); }
    } else ev.push({ kind: 'text', label: 'layout rules not run', detail: 'tool-missing:visual' });
    if (!bad.length) return { status: 'pass', evidence: [{ kind: 'check', label: `${r.pages.length} rendered page(s) look populated` }, ...ev] };
    return failWith(`bad-render: ${bad.length} page problem(s)`, [...bad, ...ev.filter(e => !bad.includes(e))]);
  },
};
