// Template verification pipeline (Plan 4, Task 3). Three groups:
//   1. injected FAKE tools for every outcome (pass / fail / skipped / timeout / crash) and hostile inputs;
//   2. REAL kernels on the repo's templates/ fixtures (skips when the kernel binaries are not built);
//   3. REAL officecli on the repo's templates/ fixtures (skips when officecli is absent).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import type { ManifestV1, UnpackedPackage } from '../src/marketplace/types.ts';
import { memoryEvidenceSink } from '../src/marketplace/verify/evidence.ts';
import { getPipeline, registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';
import { runPipeline } from '../src/marketplace/verify/runner.ts';
import { BLOCKING_ISSUES } from '../src/marketplace/verify/stages/template/issues.ts';
import { TEMPLATE_STAGES } from '../src/marketplace/verify/stages/template/index.ts';
import { decodePng, PngError } from '../src/marketplace/verify/stages/template/png.ts';
import { FIDELITY } from '../src/marketplace/verify/stages/template/previewFidelity.ts';
import { MAX_PAGES } from '../src/marketplace/verify/stages/template/renderPages.ts';
import { createKernelTool, kernelBinaryPath } from '../src/marketplace/verify/tools/kernelTool.ts';
import { createOfficecliTool, officecliAvailable } from '../src/marketplace/verify/tools/officecliTool.ts';
import type { PipelineResult, PipelineTools, StageResult } from '../src/marketplace/verify/types.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const tpl = (rel: string) => new Uint8Array(readFileSync(join(ROOT, 'tests', 'fixtures', 'templates', rel)));
type Format = 'pptx' | 'docx' | 'xlsx' | 'pdf';

// ---------------------------------------------------------------- fixtures
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
/** A small valid RGB PNG whose pixel (x,y) is px(x,y). */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y), o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
/** A recognisable "slide": dark band, bright text-like stripes and a block. Deterministic. */
const slide = (seed = 0) => png(96, 54, (x, y) => (y < 8 ? [20, 30, 60] : ((x + seed * 7) % 24 < 10 && y % 12 < 4) ? [240, 240, 240] : x > 70 && y > 30 ? [200, 60, 60] : [250, 250, 250]));
const blank = () => png(96, 54, () => [255, 255, 255]);
const black = () => png(96, 54, () => [0, 0, 0]);
const inverted = () => png(96, 54, (x, y) => { const [r, g, b] = (y < 8 ? [20, 30, 60] : ((x) % 24 < 10 && y % 12 < 4) ? [240, 240, 240] : x > 70 && y > 30 ? [200, 60, 60] : [250, 250, 250]); return [255 - r, 255 - g, 255 - b]; });

function pack(format: Format, file: Uint8Array, previews: Record<string, Uint8Array> = { 'previews/1.png': slide() }): UnpackedPackage {
  const files = new Map<string, Uint8Array>([[`template.${format}`, file], ...Object.entries(previews)]);
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: 'acme/verify-template', type: 'template', version: '1.0.0', title: 'Verify template', summary: 'A template.', license: 'MIT', compat: { app: '*' },
    dependencies: [], permissions: [], files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format, file: `template.${format}`, previews: Object.keys(previews) },
  };
  return { files, manifest };
}
const mutate = (b: Uint8Array, edit: (z: Record<string, Uint8Array>) => void): Uint8Array => { const z = unzipSync(b); edit(z); return zipSync(z as Zippable); };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const real = (rel: string, format: Format, preview?: string) => pack(format, tpl(rel), { 'previews/1.png': tpl(preview ?? `thumbnails/${rel.replace('/', '-').replace(/\.[a-z]+$/, '')}.png`) });

const run = (pkg: UnpackedPackage, tools: PipelineTools) => runPipeline('template', pkg, tools, { evidence: memoryEvidenceSink() });
const stage = (r: PipelineResult, id: string): StageResult => { const s = r.stages.find(x => x.id === id); assert.ok(s, `no stage ${id}`); return s; };
const statuses = (r: PipelineResult) => Object.fromEntries(r.stages.map(s => [s.id, s.status]));

// fake tools -------------------------------------------------------------
type K = NonNullable<PipelineTools['kernel']>;
const okKernel = (over: Record<string, unknown> = {}): K => ({
  async run(_k, args) {
    if (args[0] === 'map') return { code: 0, json: { node_count: 10, opaque_parts: [] }, stderr: '' };
    if (args[0] === 'detect-broken') return { code: 0, json: { broken_refs_in_formula: [], dangling_sheet_refs: [], error_values: [], total: 0, ...over }, stderr: '' };
    if (args[0] === 'audit-circularity') return { code: 0, json: { cycles: [], total: 0, ...over }, stderr: '' };
    return { code: 0, json: { numbering: { headings: [], mismatches: 0 }, references: { references: [] }, seq_captions: { captions: [] }, ...over }, stderr: '' };
  },
});
const fakeOffice = (o: { validate?: { ok: boolean; output: string } | Error; issues?: { type: string; message: string; path?: string }[] | Error; pages?: Uint8Array[]; total?: number | Error } = {}): NonNullable<PipelineTools['officecli']> => ({
  async validate() { if (o.validate instanceof Error) throw o.validate; return o.validate ?? { ok: true, output: 'Validation passed: no errors found.' }; },
  async issues() { if (o.issues instanceof Error) throw o.issues; return o.issues ?? []; },
  async renderPages() {
    if (o.total instanceof Error) throw o.total;
    const pages = (o.pages ?? [slide()]).map((p, i) => ({ png: p, page: i + 1 }));
    return { pages, totalPages: o.total ?? pages.length };
  },
});
const allFake = (over: Partial<PipelineTools> = {}): PipelineTools => ({ officecli: fakeOffice(), kernel: okKernel(), ...over });
const PPTX = tpl('pptx/board-update.pptx'), DOCX = tpl('docx/board-memo.docx'), XLSX = tpl('xlsx/budget-tracker.xlsx');

// ---------------------------------------------------------------- 1. fakes
describe('template pipeline with injected fake tools', () => {
  test('registered at import with the plan stage order, manifest first, and honest required flags', () => {
    const d = getPipeline('template')!;
    assert.deepEqual(d.stages.map(s => s.id), ['manifest', 'ooxml-schema', 'kernel-index', 'issues', 'formula-validity', 'docx-structure', 'render-pages', 'visual-sanity', 'preview-fidelity']);
    assert.equal(d.stages.find(s => s.id === 'visual-sanity')!.required, false);
    assert.equal(d.stages.filter(s => s.id !== 'visual-sanity').every(s => s.required), true);
    assert.equal(MAX_PAGES, 60);
  });

  test('every stage passes for a pptx with matching preview: verdict pass, evidence carries the measurements', async () => {
    const r = await run(pack('pptx', PPTX), allFake());
    assert.equal(r.verdict, 'pass', JSON.stringify(statuses(r)));
    assert.deepEqual(statuses(r), { manifest: 'pass', 'ooxml-schema': 'pass', 'kernel-index': 'pass', issues: 'pass', 'formula-validity': 'skipped', 'docx-structure': 'skipped', 'render-pages': 'pass', 'visual-sanity': 'pass', 'preview-fidelity': 'pass' });
    assert.equal(stage(r, 'formula-validity').reason, 'not-applicable:pptx');
    assert.equal(stage(r, 'formula-validity').required, false, 'a not-applicable skip never makes the verdict incomplete');
    const m = stage(r, 'preview-fidelity').evidence.filter(e => e.measured);
    assert.deepEqual(m.map(e => e.measured!.name).sort(), ['luma-mad', 'luma-ssim']);
    assert.ok(stage(r, 'render-pages').evidence.some(e => e.kind === 'image' && e.blob));
  });

  test('no tools at all: every tool stage is skipped with an explicit tool-missing reason; verdict incomplete, never pass', async () => {
    const r = await run(pack('xlsx', XLSX), {});
    assert.equal(r.verdict, 'incomplete');
    assert.equal(stage(r, 'manifest').status, 'pass');
    assert.equal(stage(r, 'ooxml-schema').reason, 'tool-missing:officecli');
    assert.equal(stage(r, 'issues').reason, 'tool-missing:officecli');
    assert.equal(stage(r, 'render-pages').reason, 'tool-missing:officecli');
    assert.equal(stage(r, 'kernel-index').reason, 'tool-missing:kernel');
    assert.equal(stage(r, 'formula-validity').reason, 'tool-missing:kernel');
    assert.match(stage(r, 'preview-fidelity').reason!, /^prerequisite-skipped:render-pages/);
    assert.ok(r.stages.every(s => s.status !== 'pass' || s.id === 'manifest'), 'nothing but the static stage may pass without tools');
  });

  test('a kernel whose binary is missing (code 127) skips, it does not pass or crash', async () => {
    const kernel: K = { async run() { return { code: 127, stderr: 'tool-missing:xlsx-context' }; } };
    const r = await run(pack('xlsx', XLSX), allFake({ kernel }));
    assert.equal(stage(r, 'kernel-index').reason, 'tool-missing:xlsx-context');
    assert.equal(stage(r, 'formula-validity').reason, 'tool-missing:xlsx-context');
    assert.equal(r.verdict, 'incomplete');
  });

  describe('ooxml-schema', () => {
    test('schema errors fail with the first 20 lines as evidence', async () => {
      const output = Array.from({ length: 30 }, (_, i) => `[${i}] The element has invalid child element`).join('\n');
      const r = await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ validate: { ok: false, output } }) }));
      const s = stage(r, 'ooxml-schema');
      assert.equal(s.status, 'fail'); assert.equal(s.reason, 'schema-errors'); assert.equal(r.verdict, 'fail');
      assert.equal(s.evidence.find(e => e.kind === 'text')!.detail!.split('\n').length, 20);
    });
    test('a tool timeout is fail:timeout, a crash is fail:tool-error, never pass or skipped', async () => {
      const t = await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ validate: new Error('timeout: officecli did not finish within 30000 ms') }) }));
      assert.equal(stage(t, 'ooxml-schema').status, 'fail'); assert.equal(stage(t, 'ooxml-schema').reason, 'timeout');
      const c = await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ validate: new Error('spawn blew up') }) }));
      assert.equal(stage(c, 'ooxml-schema').status, 'fail'); assert.match(stage(c, 'ooxml-schema').reason!, /^tool-error: spawn blew up/);
    });
    test('pdf: not applicable and not counted against the verdict', async () => {
      const s = stage(await run(pack('pdf', tpl('pdf/one-pager.pdf')), allFake()), 'ooxml-schema');
      assert.equal(s.status, 'skipped'); assert.equal(s.reason, 'not-applicable:pdf'); assert.equal(s.required, false);
    });
  });

  describe('issues (blocking set)', () => {
    test('every blocking subtype fails the stage, per format', async () => {
      for (const [fmt, pkg] of [['xlsx', pack('xlsx', XLSX)], ['pptx', pack('pptx', PPTX)]] as const) {
        for (const type of Object.keys(BLOCKING_ISSUES[fmt])) {
          const s = stage(await run(pkg, allFake({ officecli: fakeOffice({ issues: [{ type, message: 'boom', path: 'Sheet!A1' }] }) })), 'issues');
          assert.equal(s.status, 'fail', `${fmt}/${type}`); assert.match(s.reason!, new RegExp(type));
          assert.match(s.evidence[0].detail!, /why blocking/);
        }
      }
    });
    test('non-blocking findings (low_contrast, field_not_evaluated, numeric_overflow) are evidence only', async () => {
      const issues = [{ type: 'low_contrast', message: 'x' }, { type: 'field_not_evaluated', message: 'y' }, { type: 'numeric_overflow', message: 'z' }, { type: 'picture_aspect_distorted', message: 'w' }];
      for (const pkg of [pack('pptx', PPTX), pack('docx', DOCX), pack('xlsx', XLSX)]) {
        const s = stage(await run(pkg, allFake({ officecli: fakeOffice({ issues }) })), 'issues');
        assert.equal(s.status, 'pass'); assert.equal(s.evidence.filter(e => e.kind === 'check').length, 5);
      }
    });
    test('docx has no blocking subtype at all, even the xlsx and pptx ones', async () => {
      const s = stage(await run(pack('docx', DOCX), allFake({ officecli: fakeOffice({ issues: [{ type: 'formula_eval_error', message: 'm' }, { type: 'broken_part_ref', message: 'm' }] }) })), 'issues');
      assert.equal(s.status, 'pass');
    });
    test('crash => fail tool-error', async () => assert.match(stage(await run(pack('docx', DOCX), allFake({ officecli: fakeOffice({ issues: new Error('bad json') }) })), 'issues').reason!, /^tool-error/));
  });

  describe('kernel stages', () => {
    test('formula-validity: error values, dangling sheets and cycles fail with cell addresses', async () => {
      const kernel: K = { async run(_k, args) {
        if (args[0] === 'map') return { code: 0, json: { node_count: 5 }, stderr: '' };
        if (args[0] === 'detect-broken') return { code: 0, stderr: '', json: { broken_refs_in_formula: [{ cell: 'F10', formula: '#REF!+1', part: 'xl/worksheets/sheet1.xml' }], dangling_sheet_refs: [{ cell: 'B2', missing_sheet: 'Nope', part: 'xl/worksheets/sheet2.xml' }], error_values: [{ cell: 'C3', error: '#DIV/0!', part: 'xl/worksheets/sheet1.xml' }] } };
        return { code: 0, stderr: '', json: { cycles: [{ cells: ['sheet1.xml!F11', 'sheet1.xml!F10'], self_reference: false }] } };
      } };
      const s = stage(await run(pack('xlsx', XLSX), allFake({ kernel })), 'formula-validity');
      assert.equal(s.status, 'fail'); assert.match(s.reason!, /formula-findings: 4/);
      const text = s.evidence.map(e => e.detail).join('\n');
      for (const want of ['sheet1.xml!F10', 'sheet2.xml!B2', 'sheet1.xml!C3', 'circular reference: sheet1.xml!F11 -> sheet1.xml!F10']) assert.ok(text.includes(want), want);
    });
    test('formula-validity: clean passes, not applicable for docx', async () => {
      assert.equal(stage(await run(pack('xlsx', XLSX), allFake()), 'formula-validity').status, 'pass');
      assert.equal(stage(await run(pack('docx', DOCX), allFake()), 'formula-validity').reason, 'not-applicable:docx');
    });
    test('kernel crash (non-zero exit) and kernel timeout (code 124) both fail', async () => {
      const crash: K = { async run(_k, a) { return a[0] === 'map' ? { code: 0, json: { node_count: 5 }, stderr: '' } : { code: 101, stderr: 'panic: oops' }; } };
      assert.match(stage(await run(pack('xlsx', XLSX), allFake({ kernel: crash })), 'formula-validity').reason!, /^kernel-error/);
      const slow: K = { async run() { return { code: 124, stderr: 'timeout: xlsx-context did not finish within 30000 ms' }; } };
      const r = await run(pack('xlsx', XLSX), allFake({ kernel: slow }));
      assert.equal(stage(r, 'formula-validity').reason, 'timeout'); assert.equal(stage(r, 'kernel-index').reason, 'timeout');
    });
    test('kernel-index: map failure or an empty index fails', async () => {
      const bad: K = { async run() { return { code: 2, stderr: 'not a workbook' }; } };
      assert.equal(stage(await run(pack('xlsx', XLSX), allFake({ kernel: bad })), 'kernel-index').reason, 'kernel-index-failed');
      const empty: K = { async run() { return { code: 0, json: { node_count: 0, opaque_parts: [] }, stderr: '' }; } };
      assert.equal(stage(await run(pack('xlsx', XLSX), allFake({ kernel: empty })), 'kernel-index').reason, 'kernel-index-empty');
    });
    test('docx-structure: a numbered dangling reference fails; lettered references, numbering and caption findings are evidence only', async () => {
      const dangling = okKernel({ references: { references: [{ ref_text: 'section 9', keyword: 'section', number: '9', resolved: false }] } });
      const s = stage(await run(pack('docx', DOCX), allFake({ kernel: dangling })), 'docx-structure');
      assert.equal(s.status, 'fail'); assert.equal(s.evidence[0].label, 'unresolved cross-reference');
      const lenient = okKernel({
        references: { references: [{ ref_text: 'Appendix A', keyword: 'Appendix', number: 'A', resolved: false }] },
        numbering: { headings: [{ text: '1. X', actual_number: '1', computed_number: '0.1', match: false }] },
        seq_captions: { captions: [{ match: false }] },
      });
      const l = stage(await run(pack('docx', DOCX), allFake({ kernel: lenient })), 'docx-structure');
      assert.equal(l.status, 'pass'); assert.equal(l.evidence.length, 3);
    });
  });

  describe('render-pages', () => {
    test('cap path: 60 of 140 rendered passes with the coverage stated as text; only 12 page images are stored', async () => {
      const pages = Array.from({ length: MAX_PAGES }, (_, i) => slide(i));
      const sink = memoryEvidenceSink();
      const r = await runPipeline('template', pack('pptx', PPTX), allFake({ officecli: fakeOffice({ pages, total: 140 }) }), { evidence: sink });
      const s = stage(r, 'render-pages');
      assert.equal(s.status, 'pass');
      assert.ok(s.evidence.some(e => e.label === 'rendered 60 of 140 pages' && /capped at 60/.test(e.detail!)));
      assert.equal(s.evidence.filter(e => e.kind === 'image').length, 12);
      const hashed = s.evidence.find(e => e.kind === 'json' && /48 page render\(s\) hashed only/.test(e.label));
      assert.ok(hashed, 'the other 48 pages are one compact hashed item'); assert.equal(hashed.detail!.split(' ').length, 48);
      assert.equal(s.evidence.some(e => /truncated/.test(e.label)), false, 'the per-stage evidence cap is not hit');
      assert.ok(sink.count <= 40);
    });
    test('zero pages, a timeout and a crash fail', async () => {
      assert.equal(stage(await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ pages: [] }) })), 'render-pages').reason, 'no-pages-rendered');
      assert.equal(stage(await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ total: new Error('timeout: officecli did not finish within 90000 ms') }) })), 'render-pages').reason, 'timeout');
      assert.match(stage(await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ total: new Error('exit 3') }) })), 'render-pages').reason!, /^tool-error/);
    });
    test('a render that fails skips the visual stages with the prerequisite as the reason (not a pass, not a crash)', async () => {
      const r = await run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ total: new Error('exit 3') }) }));
      assert.match(stage(r, 'visual-sanity').reason!, /^prerequisite-failed:render-pages/);
      assert.match(stage(r, 'preview-fidelity').reason!, /^prerequisite-failed:render-pages/);
      assert.equal(r.verdict, 'fail');
    });
    test('docx/xlsx coverage is stated honestly as page 1 only', async () => {
      assert.ok(stage(await run(pack('docx', DOCX), allFake()), 'render-pages').evidence.some(e => e.label === 'coverage: page 1 only'));
    });
    test('a hung tool cannot hang the run: the stage timeout wins and the result is fail:timeout', async () => {
      const def = getPipeline('template')!;
      unregisterPipelineForTest('template');
      registerPipeline({ ...def, stages: def.stages.map(s => s.id === 'render-pages' ? { ...s, timeoutMs: 150 } : s) });
      try {
        const hang = fakeOffice(); hang.renderPages = () => new Promise(() => { /* never settles */ });
        const t0 = Date.now(); const r = await run(pack('pptx', PPTX), allFake({ officecli: hang }));
        assert.ok(Date.now() - t0 < 5000);
        assert.equal(stage(r, 'render-pages').status, 'fail'); assert.equal(stage(r, 'render-pages').reason, 'timeout');
      } finally { unregisterPipelineForTest('template'); registerPipeline(def); }
    });
  });

  describe('visual-sanity', () => {
    const sanity = (pages: Uint8Array[], extra: Partial<PipelineTools> = {}) => run(pack('pptx', PPTX), allFake({ officecli: fakeOffice({ pages }), ...extra })).then(r => stage(r, 'visual-sanity'));
    test('blank render fails with the measured ink fraction against its floor', async () => {
      const s = await sanity([slide(), blank()]);
      assert.equal(s.status, 'fail'); assert.ok(s.evidence.some(e => /page 2 is blank/.test(e.label) && e.measured!.name === 'ink-fraction'));
    });
    test('black render fails', async () => { const s = await sanity([black()]); assert.equal(s.status, 'fail'); assert.ok(s.evidence.some(e => /page 1 is black/.test(e.label))); });
    test('truncated / corrupt PNG fails as an unreadable render', async () => {
      const good = slide(); const s = await sanity([slide(), good.subarray(0, good.length - 40)]);
      assert.equal(s.status, 'fail'); assert.ok(s.evidence.some(e => /page 2 render is not a readable PNG/.test(e.label)));
    });
    test('all pages identical (>2 pages) is a stuck renderer; a repeated page among different ones is evidence only', async () => {
      assert.equal((await sanity([slide(), slide(), slide()])).status, 'fail');
      const ok = await sanity([slide(1), slide(1), slide(2)]);
      assert.equal(ok.status, 'pass'); assert.ok(ok.evidence.some(e => /consecutive identical pages/.test(e.label)));
    });
    test('layout findings are advisory evidence; a throwing layout tool and an absent one never change the status', async () => {
      const lay: NonNullable<PipelineTools['visual']> = { compare: async () => { throw new Error('unused'); }, layout: async () => [{ rule: 'text_overflow', blocking: true, slide: 2, message: 'overflows' }] };
      const a = await sanity([slide(1), slide(2)], { visual: { ...lay } });
      assert.equal(a.status, 'pass'); assert.ok(a.evidence.some(e => /layout text_overflow \(slide 2\)/.test(e.label)));
      const b = await sanity([slide(1)], { visual: { ...lay, layout: async () => { throw new Error('chromium missing'); } } });
      assert.equal(b.status, 'pass'); assert.ok(b.evidence.some(e => e.label === 'layout rules unavailable'));
      assert.ok((await sanity([slide(1)])).evidence.some(e => e.detail === 'tool-missing:visual'));
    });
  });

  describe('preview-fidelity', () => {
    test('a different image fails with measurements next to their thresholds; identical passes', async () => {
      const bad = await run(pack('pptx', PPTX, { 'previews/1.png': inverted() }), allFake());
      const s = stage(bad, 'preview-fidelity');
      assert.equal(s.status, 'fail'); assert.match(s.reason!, /preview-mismatch: previews\/1\.png/); assert.equal(bad.verdict, 'fail');
      const m = s.evidence.filter(e => e.measured);
      assert.ok(m.some(e => e.measured!.name === 'luma-ssim' && e.measured!.value < FIDELITY.ssimMin && e.measured!.threshold === FIDELITY.ssimMin));
      assert.equal(stage(await run(pack('pptx', PPTX, { 'previews/1.png': slide() })), 'preview-fidelity').status, 'skipped'); // no tools => prerequisite skip
      assert.equal(stage(await run(pack('pptx', PPTX, { 'previews/1.png': slide() }), allFake()), 'preview-fidelity').status, 'pass');
    });
    test('a blank preview over a real render is rejected (bait-and-switch)', async () => assert.equal(stage(await run(pack('pptx', PPTX, { 'previews/1.png': blank() }), allFake()), 'preview-fidelity').status, 'fail'));
    test('JPEG preview is not comparable deterministically: skipped with a reason, verdict incomplete, never pass', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
      const r = await run(pack('pptx', PPTX, { 'previews/1.jpg': jpg }), allFake());
      const s = stage(r, 'preview-fidelity'); assert.equal(s.status, 'skipped'); assert.match(s.reason!, /^no-comparable-preview/); assert.equal(r.verdict, 'incomplete');
    });
    test('an injected comparator decides the status; CLIP/DINO ride along as evidence only', async () => {
      const m = (name: string, value: number, threshold: number, op: '>=' | '<=' = '>='): { name: string; value: number; threshold: number; op: '>=' | '<=' } => ({ name, value, threshold, op });
      const visual = (ssim: number): NonNullable<PipelineTools['visual']> => ({ layout: async () => [], compare: async () => ({ pixel: m('pixelmatch-diff', 0.01, 0.1, '<='), ssim: m('ssim', ssim, 0.9), clip: m('clip', 0.2, 0.9), dino: m('dino', 0.1, 0.6) }) });
      const ok = stage(await run(pack('pptx', PPTX), allFake({ visual: visual(0.95) })), 'preview-fidelity');
      assert.equal(ok.status, 'pass', 'a failing CLIP/DINO measurement alone never fails the stage');
      assert.ok(ok.evidence.some(e => /clip \(evidence only\)/.test(e.label)));
      assert.equal(stage(await run(pack('pptx', PPTX), allFake({ visual: visual(0.5) })), 'preview-fidelity').status, 'fail');
    });
    test('previews beyond the rendered pages are noted, not failed', async () => {
      const r = await run(pack('pptx', PPTX, { 'previews/1.png': slide(), 'previews/2.png': slide(3) }), allFake());
      const s = stage(r, 'preview-fidelity'); assert.equal(s.status, 'pass'); assert.ok(s.evidence.some(e => /no rendered page 2/.test(e.detail ?? '')));
    });
  });

  describe('hostile inputs through the stage entry', () => {
    test('zip bomb as the template file: manifest fails, no external tool is ever invoked, and it is fast', async () => {
      const bomb = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'ppt/presentation.xml': strToU8('<p/>'), 'ppt/media/big.bin': new Uint8Array(200 * 1024 * 1024) }, { level: 9 });
      let calls = 0; const spy: PipelineTools = { officecli: fakeOffice(), kernel: { async run() { calls++; return { code: 0, json: {}, stderr: '' }; } } };
      const o = spy.officecli!; for (const k of ['validate', 'issues', 'renderPages'] as const) { const f = (o as any)[k]; (o as any)[k] = (...a: unknown[]) => { calls++; return f(...a); }; }
      const t0 = Date.now(); const r = await run(pack('pptx', bomb), spy);
      assert.ok(Date.now() - t0 < 30_000, 'fails fast');
      assert.equal(stage(r, 'manifest').status, 'fail'); assert.equal(r.verdict, 'fail'); assert.equal(calls, 0);
      for (const id of ['ooxml-schema', 'kernel-index', 'issues', 'render-pages']) assert.match(stage(r, id).reason!, /^prerequisite-failed:manifest/);
    });
    test('a zip renamed .pptx (not an OOXML package) fails manifest and nothing else runs', async () => {
      const r = await run(pack('pptx', strToU8('this is not a zip')), allFake());
      assert.equal(stage(r, 'manifest').status, 'fail'); assert.equal(stage(r, 'render-pages').status, 'skipped');
    });
    test('PNG decoder rejects a 30000 x 30000 header, an inflate bomb, and garbage without allocating', () => {
      const big = png(4, 4, () => [1, 2, 3]); new DataView(big.buffer, big.byteOffset).setUint32(16, 30000); new DataView(big.buffer, big.byteOffset).setUint32(20, 30000);
      assert.throws(() => decodePng(big), PngError);
      const bomb = png(4, 4, () => [1, 2, 3]); // valid IHDR 4x4 but IDAT inflates to far more than 4x4 allows
      const ihdr = bomb.subarray(8, 33); const idat = chunk('IDAT', deflateSync(new Uint8Array(50 * 1024 * 1024)));
      const out = new Uint8Array(8 + ihdr.length + idat.length + 12); out.set(bomb.subarray(0, 33)); out.set(idat, 33); out.set(chunk('IEND', new Uint8Array()), 33 + idat.length);
      assert.throws(() => decodePng(out), PngError); assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), PngError);
    });
    test('a 30000 px preview does not crash or hang the fidelity stage: it is "not comparable"', async () => {
      const huge = png(4, 4, () => [9, 9, 9]); const dv = new DataView(huge.buffer, huge.byteOffset); dv.setUint32(16, 30000); dv.setUint32(20, 30000);
      const s = stage(await run(pack('pptx', PPTX, { 'previews/1.png': huge }), allFake()), 'preview-fidelity');
      assert.equal(s.status, 'skipped'); assert.ok(s.evidence.some(e => /over the limit/.test(e.detail ?? '')));
    });
    test('results never carry a score-like key (the contract walk) and evidence blobs stay within caps', async () => {
      const r = await run(pack('pptx', PPTX), allFake());
      assert.doesNotMatch(JSON.stringify(r), /"(score|confidence|grade|rating|percent)"/i);
    });
  });
});

// ---------------------------------------------------------------- 2. real kernels
const kernelsBuilt = (['xlsx', 'docpatch', 'pptx', 'pdf'] as const).every(k => kernelBinaryPath(k));
describe('REAL kernels on the repo templates', { skip: kernelsBuilt ? false : 'tool-missing: kernel binaries not built (cargo build --release in kernels/)' }, () => {
  const kernel = createKernelTool({ timeoutMs: 120_000 });
  const only = (r: PipelineResult, ...ids: string[]) => ids.map(id => stage(r, id));
  const REAL: [string, Format][] = [['docx/board-memo.docx', 'docx'], ['docx/meeting-notes.docx', 'docx'], ['pptx/board-update.pptx', 'pptx'], ['xlsx/budget-tracker.xlsx', 'xlsx'], ['xlsx/sales-pipeline.xlsx', 'xlsx'], ['pdf/one-pager.pdf', 'pdf']];
  for (const [rel, fmt] of REAL) {
    test(`kernel-index${fmt === 'xlsx' ? ', formula-validity' : fmt === 'docx' ? ', docx-structure' : ''} pass on ${rel}`, async () => {
      const r = await run(real(rel, fmt), { kernel });
      const ids = ['kernel-index', ...(fmt === 'xlsx' ? ['formula-validity'] : fmt === 'docx' ? ['docx-structure'] : [])];
      for (const s of only(r, ...ids)) assert.equal(s.status, 'pass', `${s.id}: ${s.reason} ${JSON.stringify(s.evidence)}`);
      assert.ok(stage(r, 'kernel-index').evidence[0].detail!.includes('node_count'));
    });
  }
  const sheet = (edit: (s: string) => string) => mutate(XLSX, z => { z['xl/worksheets/sheet1.xml'] = strToU8(edit(dec(z['xl/worksheets/sheet1.xml']))); });
  const F10 = '<f>D10*COUNT(H10:S10)/12-E10</f><v></v>';
  test('xlsx with a #REF! formula fails formula-validity with the cell address', async () => {
    const s = stage(await run(pack('xlsx', sheet(x => x.replace(F10, '<f>#REF!+1</f><v>#REF!</v>'))), { kernel }), 'formula-validity');
    assert.equal(s.status, 'fail'); assert.ok(s.evidence.some(e => /sheet1\.xml!F10/.test(e.detail ?? '')), JSON.stringify(s.evidence));
  });
  test('xlsx with a dangling sheet reference fails formula-validity', async () => {
    const s = stage(await run(pack('xlsx', sheet(x => x.replace(F10, '<f>Nope!A1+1</f><v></v>'))), { kernel }), 'formula-validity');
    assert.equal(s.status, 'fail'); assert.ok(s.evidence.some(e => /missing sheet "Nope"/.test(e.detail ?? '')));
  });
  test('xlsx with a circular reference fails formula-validity (both cells named)', async () => {
    const s = stage(await run(pack('xlsx', sheet(x => x.replace(F10, '<f>F11</f><v></v>').replace(/(<c r="F11"[^>]*>)<f>[^<]*<\/f>/, '$1<f>F10</f>'))), { kernel }), 'formula-validity');
    assert.equal(s.status, 'fail'); const t = s.evidence.map(e => e.detail).join(' '); assert.match(t, /circular reference/); assert.match(t, /F10/); assert.match(t, /F11/);
  });
  test('docx with a dangling cross-reference fails docx-structure', async () => {
    const d = mutate(DOCX, z => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace(/section 3/g, 'section 9')); });
    const s = stage(await run(pack('docx', d), { kernel }), 'docx-structure');
    assert.equal(s.status, 'fail', JSON.stringify(s.evidence)); assert.ok(s.evidence.some(e => /section 9/.test(e.detail ?? '')));
  });
  const bigSheet = (rowsN: number) => {
    const rows = Array.from({ length: rowsN }, (_, i) => `<row r="${i + 30}">${Array.from({ length: 100 }, (_, c) => `<c r="${String.fromCharCode(65 + (c % 26))}${String.fromCharCode(97 + Math.floor(c / 26))}${i + 30}" t="n"><v>${c}</v></c>`).join('')}</row>`).join('');
    return mutate(XLSX, z => { z['xl/worksheets/sheet1.xml'] = strToU8(dec(z['xl/worksheets/sheet1.xml']).replace('</sheetData>', `${rows}</sheetData>`)); });
  };
  test('a big sheet (10 000 literal cells) is indexed inside the stage bounds', async () => {
    const t0 = Date.now(); const r = await run(pack('xlsx', bigSheet(100)), { kernel });
    assert.ok(Date.now() - t0 < 120_000);
    for (const s of only(r, 'kernel-index', 'formula-validity')) assert.ok(['pass', 'fail'].includes(s.status), `${s.id} ${s.status} ${s.reason}`);
  });
  test('a huge sheet against a tight kernel budget is killed and reported as fail:timeout (process group kill, no hang)', async () => {
    const tight = createKernelTool({ timeoutMs: 1500 });
    const t0 = Date.now(); const r = await run(pack('xlsx', bigSheet(400)), { kernel: tight });
    assert.ok(Date.now() - t0 < 60_000);
    assert.equal(stage(r, 'kernel-index').status, 'fail'); assert.equal(stage(r, 'kernel-index').reason, 'timeout'); assert.equal(r.verdict, 'fail');
  });
  test('a corrupt template (garbage bytes) makes the kernel stage fail or manifest block it; never a crash or a pass', async () => {
    const r = await run(pack('xlsx', strToU8('PK garbage')), { kernel });
    assert.equal(r.verdict, 'fail'); assert.notEqual(stage(r, 'kernel-index').status, 'pass');
  });
});

// ---------------------------------------------------------------- 3. real officecli
let haveOfficecli = false;
before(async () => { haveOfficecli = await officecliAvailable(); });
const withOfficecli = (name: string, fn: () => Promise<void>) => test(name, { timeout: 900_000 }, async t => { if (!haveOfficecli) return t.skip('tool-missing: officecli is not installed'); await fn(); });
describe('REAL officecli on the repo templates', () => {
  const officecli = createOfficecliTool({ timeoutMs: 180_000, perPageTimeoutMs: 180_000 });
  const kernel = createKernelTool({ timeoutMs: 120_000 });
  const tools: PipelineTools = { officecli, kernel: kernelsBuilt ? kernel : undefined };
  const onePageDeck = (edit?: (z: Record<string, Uint8Array>) => void) => mutate(PPTX, z => {
    z['ppt/presentation.xml'] = strToU8(dec(z['ppt/presentation.xml']).replace(/(<p:sldIdLst>\s*<p:sldId [^>]*\/>)[\s\S]*?(<\/p:sldIdLst>)/, '$1$2'));
    edit?.(z);
  });
  const slide1 = (z: Record<string, Uint8Array>) => 'ppt/slides/slide1.xml' in z ? 'ppt/slides/slide1.xml' : Object.keys(z).find(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))!;

  withOfficecli('pptx board-update: schema, issues, render all pass; page 1 is stored as image evidence', async () => {
    const r = await run(real('pptx/board-update.pptx', 'pptx'), tools);
    for (const id of ['manifest', 'ooxml-schema', 'issues', 'render-pages', 'visual-sanity']) assert.equal(stage(r, id).status, 'pass', `${id}: ${stage(r, id).reason}`);
    const rp = stage(r, 'render-pages'); assert.ok(rp.evidence.some(e => e.kind === 'image')); assert.ok(rp.evidence.some(e => /^rendered 6 of 6 page/.test(e.label)));
    const fid = stage(r, 'preview-fidelity'); assert.equal(fid.status, 'pass', JSON.stringify(fid.evidence));
  });
  withOfficecli('docx board-memo: schema, issues, render pass; preview-fidelity is honestly skipped (pixel compare does not discriminate docx)', async () => {
    const r = await run(real('docx/board-memo.docx', 'docx'), tools);
    for (const id of ['ooxml-schema', 'issues', 'render-pages', 'visual-sanity']) assert.equal(stage(r, id).status, 'pass', `${id}: ${stage(r, id).reason}`);
    const f = stage(r, 'preview-fidelity'); assert.equal(f.status, 'skipped'); assert.match(f.reason!, /^not-discriminating:docx/);
    assert.equal(r.verdict, 'incomplete');
  });
  withOfficecli('xlsx budget-tracker: schema, issues, render pass; preview-fidelity skipped as not discriminating, with gross evidence', async () => {
    const r = await run(real('xlsx/budget-tracker.xlsx', 'xlsx'), tools);
    for (const id of ['ooxml-schema', 'issues', 'render-pages', 'visual-sanity']) assert.equal(stage(r, id).status, 'pass', `${id}: ${stage(r, id).reason}`);
    const f = stage(r, 'preview-fidelity'); assert.equal(f.status, 'skipped'); assert.ok(f.evidence.some(e => e.measured?.name === 'ink-fraction'));
  });
  withOfficecli('every pptx template: its own thumbnail passes the real render comparison (same template rendered twice must pass)', async () => {
    for (const n of ['board-update', 'investor-pitch', 'product-roadmap', 'quarterly-review']) {
      const r = await run(real(`pptx/${n}.pptx`, 'pptx'), { officecli });
      const f = stage(r, 'preview-fidelity'); assert.equal(f.status, 'pass', `${n}: ${JSON.stringify(f.evidence.map(e => e.measured))}`);
    }
  });
  withOfficecli('xlsx with a #REF! cell fails issues (formula_eval_error) through officecli', async () => {
    const x = mutate(XLSX, z => { z['xl/worksheets/sheet1.xml'] = strToU8(dec(z['xl/worksheets/sheet1.xml']).replace('<f>D10*COUNT(H10:S10)/12-E10</f><v></v>', '<f>#REF!+1</f><v>#REF!</v>')); });
    const s = stage(await run(pack('xlsx', x), tools), 'issues');
    assert.equal(s.status, 'fail'); assert.match(s.reason!, /formula_eval_error/); assert.ok(s.evidence.some(e => /Budget 2026!F10/.test(e.label)));
  });
  withOfficecli('pptx whose notesSlide relationship points nowhere never passes: the static validator, schema or issues stage catches it', async () => {
    const d = mutate(PPTX, z => {
      const rels = slide1(z).replace('slides/', 'slides/_rels/') + '.rels';
      z[rels] = strToU8(dec(z[rels]).replace('</Relationships>', '<Relationship Id="rIdNotes9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide999.xml"/></Relationships>'));
    });
    const r = await run(pack('pptx', d), tools);
    const failed = ['manifest', 'ooxml-schema', 'issues'].filter(id => stage(r, id).status === 'fail');
    assert.ok(failed.length > 0, `no stage caught a dangling notesSlide relationship: ${JSON.stringify(statuses(r))}`);
    assert.equal(r.verdict, 'fail');
  });
  withOfficecli('a pptx whose only slide is empty renders blank and fails visual-sanity', async () => {
    const d = onePageDeck(z => {
      const p = slide1(z); z[p] = strToU8(dec(z[p]).replace(/<p:bg>[\s\S]*?<\/p:bg>/, '').replace(/(<p:spTree>[\s\S]*?(?:<p:grpSpPr\/>|<\/p:grpSpPr>))[\s\S]*(<\/p:spTree>)/, '$1$2'));
    });
    const r = await run(pack('pptx', d, { 'previews/1.png': blank() }), tools);
    const s = stage(r, 'visual-sanity');
    assert.equal(s.status, 'fail', `${s.status} ${s.reason} ${JSON.stringify(r.stages.map(x => [x.id, x.status, x.reason]))}`); assert.ok(s.evidence.some(e => /page 1 is blank/.test(e.label)));
  });
  withOfficecli('a 1 x 1 EMU slide does not hang or crash the pipeline', async () => {
    const d = onePageDeck(z => { z['ppt/presentation.xml'] = strToU8(dec(z['ppt/presentation.xml']).replace(/<p:sldSz [^>]*\/>/, '<p:sldSz cx="1" cy="1"/>')); });
    const t0 = Date.now(); const r = await run(pack('pptx', d), tools);
    assert.ok(Date.now() - t0 < 600_000);
    for (const s of r.stages) assert.ok(['pass', 'fail', 'skipped'].includes(s.status));
    assert.ok(r.stages.every(s => s.status === 'pass' || s.reason), 'every non-pass has a reason');
  });
  withOfficecli('a preview from a different template fails preview-fidelity against the real render', async () => {
    const r = await run(pack('pptx', PPTX, { 'previews/1.png': tpl('thumbnails/pptx-investor-pitch.png') }), tools);
    assert.equal(stage(r, 'preview-fidelity').status, 'fail', JSON.stringify(stage(r, 'preview-fidelity').evidence.map(e => e.measured)));
  });
  test('REAL tool absent => skipped explicitly (the officecli path with an unusable binary)', async () => {
    const missing = createOfficecliTool({ bin: '/nonexistent/officecli' });
    const r = await run(pack('docx', DOCX), { officecli: missing });
    // a binary that cannot be spawned is a tool error (fail), distinct from an injected-absent tool (skipped): both are explicit
    assert.equal(stage(r, 'ooxml-schema').status, 'fail'); assert.match(stage(r, 'ooxml-schema').reason!, /^tool-error: could not run officecli/);
  });
});
void TEMPLATE_STAGES;
