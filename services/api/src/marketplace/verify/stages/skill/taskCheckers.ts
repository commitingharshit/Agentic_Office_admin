// Deterministic checkers over the files a task run produced (Plan 4 Task 6). The outputs are produced by untrusted code, so
// every read is bounded: safe relative names only, per-file and total caps, zip entry/size/ratio limits checked from the
// central directory BEFORE inflating anything, and only the parts a check needs are inflated. No LLM judge, no score.
import { unzipSync } from 'fflate';
import { parseXml } from '../../../validate/template.ts';
import type { Evidence, PipelineTools } from '../../types.ts';
import { decodePng, inkFraction, meanLuma, PngError } from '../template/png.ts';
import { BLACK_LUMA, INK_FLOOR } from '../template/visualSanity.ts';
import { safeRelPath, type TaskCheck, type TaskRun } from './taskSchema.ts';

export const MAX_OUTPUT_FILES = 40;
export const MAX_OUTPUT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_PART_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_RATIO = 200;
const MAX_TEXT_CHARS = 2_000_000;

export type CheckVerdict = { status: 'pass' | 'fail' | 'skipped'; label: string; detail?: string; evidence?: Evidence[] };
export interface SafeOutputs { files: Map<string, Uint8Array>; problems: string[] }

/** Keeps only well-formed outputs; everything refused is recorded as a (bounded) problem string. */
export function sanitizeOutputs(run: TaskRun): SafeOutputs {
  const files = new Map<string, Uint8Array>(), problems: string[] = [];
  let total = 0;
  const note = (m: string) => { if (problems.length < 10) problems.push(m.slice(0, 160)); };
  const outs = Array.isArray(run.outputs) ? run.outputs : [];
  for (const o of outs.slice(0, 10_000)) {
    const p = (o as { path?: unknown })?.path, b = (o as { bytes?: unknown })?.bytes;
    if (!safeRelPath(p) || !(b instanceof Uint8Array)) { note(`refused output name ${JSON.stringify(String(p)).slice(0, 60)}`); continue; }
    if (files.has(p)) { note(`duplicate output ${p}`); continue; }
    if (files.size >= MAX_OUTPUT_FILES) { note(`more than ${MAX_OUTPUT_FILES} output files`); break; }
    if (b.byteLength > MAX_OUTPUT_FILE_BYTES) { note(`output ${p} is over ${MAX_OUTPUT_FILE_BYTES} bytes`); continue; }
    if (total + b.byteLength > MAX_OUTPUT_TOTAL_BYTES) { note('outputs over the total size cap'); break; }
    total += b.byteLength; files.set(p, b);
  }
  return { files, problems };
}

class OutputError extends Error { constructor(m: string) { super(m); this.name = 'OutputError'; } }

const isZip = (b: Uint8Array) => b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
const FORMAT_BY_EXT: Record<string, 'docx' | 'xlsx' | 'pptx'> = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };
export const formatOf = (path: string): 'docx' | 'xlsx' | 'pptx' | undefined => FORMAT_BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];

/** Inflates only the wanted parts, after the central directory passed the entry/size/ratio limits. Throws OutputError. */
export function readParts(bytes: Uint8Array, want: (name: string) => boolean): Map<string, Uint8Array> {
  if (!isZip(bytes)) throw new OutputError('not a zip container');
  let entries = 0, declared = 0, bad: string | undefined;
  const parts = new Map<string, Uint8Array>();
  try {
    const all = unzipSync(bytes, {
      filter: (f) => {
        entries++; declared += f.originalSize;
        if (entries > MAX_ZIP_ENTRIES) bad ??= `more than ${MAX_ZIP_ENTRIES} entries`;
        else if (f.originalSize > MAX_ZIP_PART_BYTES) bad ??= `entry ${String(f.name).slice(0, 60)} declares ${f.originalSize} bytes`;
        else if (declared > MAX_ZIP_TOTAL_BYTES) bad ??= `declared uncompressed size over ${MAX_ZIP_TOTAL_BYTES}`;
        else if (f.size > 0 && f.originalSize / f.size > MAX_ZIP_RATIO && f.originalSize > 1024 * 1024) bad ??= `entry ${String(f.name).slice(0, 60)} has a compression ratio over ${MAX_ZIP_RATIO}`;
        return !bad && want(f.name);
      },
    });
    if (bad) throw new OutputError(`archive refused: ${bad}`);
    for (const [k, v] of Object.entries(all)) parts.set(k, v);
  } catch (e) {
    if (e instanceof OutputError) throw e;
    if (bad) throw new OutputError(`archive refused: ${bad}`);
    throw new OutputError(`unreadable archive: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
  return parts;
}

const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const unent = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d{1,6});/g, (_, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }).replace(/&amp;/g, '&');
function runsOf(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'); let m, s = '';
  while ((m = re.exec(xml)) && s.length < MAX_TEXT_CHARS) s += unent(m[1]);
  return s;
}

/** Visible text of an output: docx paragraphs, pptx slide text, xlsx strings; any other file is decoded as UTF-8 text. */
export function textOf(path: string, bytes: Uint8Array): string {
  const f = formatOf(path);
  if (!f) return dec(bytes.subarray(0, MAX_TEXT_CHARS));
  if (f === 'docx') {
    const p = readParts(bytes, (n) => n === 'word/document.xml').get('word/document.xml');
    if (!p) throw new OutputError('word/document.xml is missing');
    return dec(p).split(/<\/w:p>/).map((para) => runsOf(para, 'w:t')).join('\n').slice(0, MAX_TEXT_CHARS);
  }
  if (f === 'pptx') {
    const parts = readParts(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    return [...parts.keys()].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).map((k) => dec(parts.get(k)!).split(/<\/a:p>/).map((p) => runsOf(p, 'a:t')).join('\n')).join('\n\n').slice(0, MAX_TEXT_CHARS);
  }
  const parts = readParts(bytes, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const ss = parts.get('xl/sharedStrings.xml');
  return (ss ? dec(ss).split(/<\/si>/).map((s) => runsOf(s, 't')).join('\n') : '').slice(0, MAX_TEXT_CHARS);
}

/** Value of one cell of the first worksheet: cached formula results are read as written, nothing is recalculated here. */
export function cellOf(bytes: Uint8Array, cell: string): string | undefined {
  const parts = readParts(bytes, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/worksheets/sheet1.xml');
  const sheet = parts.get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new OutputError('xl/worksheets/sheet1.xml is missing');
  const xml = dec(sheet);
  const m = new RegExp(`<c\\s([^>]*\\br="${cell}"[^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
  if (!m) return undefined;
  const type = /\bt="([^"]*)"/.exec(m[1])?.[1], inner = m[2] ?? '';
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  if (type === 's' && v !== undefined) {
    const ss = parts.get('xl/sharedStrings.xml');
    if (!ss) throw new OutputError('shared string table is missing');
    const items = dec(ss).split(/<\/si>/); return runsOf(items[Number(v)] ?? '', 't');
  }
  if (type === 'inlineStr') return runsOf(inner, 't');
  return v === undefined ? undefined : unent(v);
}

// ------------------------------------------------------------------ the checks

const label = (c: TaskCheck) => c.kind === 'regression' ? 'regression' : `${c.kind}:${c.file}`;
const fail = (c: TaskCheck, detail: string, evidence?: Evidence[]): CheckVerdict => ({ status: 'fail', label: label(c), detail: detail.slice(0, 600), ...(evidence ? { evidence } : {}) });
const pass = (c: TaskCheck, detail?: string, evidence?: Evidence[]): CheckVerdict => ({ status: 'pass', label: label(c), ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });
const skip = (c: TaskCheck, why: string): CheckVerdict => ({ status: 'skipped', label: label(c), detail: why });

/** Structural validity: a safe zip with the container parts, every XML part we can reach well-formed (no DOCTYPE/entities), then officecli validate when present. */
export async function integrity(c: Extract<TaskCheck, { kind: 'integrity' }>, bytes: Uint8Array, tools: PipelineTools): Promise<CheckVerdict> {
  const f = formatOf(c.file);
  if (!f) return fail(c, 'integrity is defined for docx, xlsx and pptx outputs');
  try {
    const main = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[f];
    const parts = readParts(bytes, (n) => n === '[Content_Types].xml' || n === main || n === '_rels/.rels');
    for (const need of ['[Content_Types].xml', '_rels/.rels', main]) if (!parts.has(need)) return fail(c, `required part ${need} is missing`);
    for (const [n, b] of parts) { try { parseXml(b); } catch (e) { return fail(c, `${n} is not well-formed: ${String((e as Error).message).slice(0, 120)}`); } }
  } catch (e) { return fail(c, (e as Error).message); }
  if (!tools.officecli) return { status: 'pass', label: label(c), detail: 'structure ok; officecli validate not run (tool-missing:officecli)' };
  try {
    const r = await tools.officecli.validate(bytes, f);
    return r.ok ? pass(c, 'structure ok; officecli validate passed') : fail(c, `officecli validate: ${r.output.split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'errors'}`);
  } catch (e) { return fail(c, `officecli validate could not run: ${String((e as Error).message).slice(0, 160)}`); }
}

export function functional(c: Extract<TaskCheck, { kind: 'functional' }>, bytes: Uint8Array): CheckVerdict {
  const a = c.assert;
  try {
    if (a.cell !== undefined) {
      const got = cellOf(bytes, a.cell);
      if (got === undefined) return fail(c, `cell ${a.cell} is empty or missing`);
      const want = a.value!;
      const ok = typeof want === 'number' ? Number.isFinite(Number(got)) && Math.abs(Number(got) - want) <= 1e-9 * Math.max(1, Math.abs(want)) : got === want;
      if (!ok) return fail(c, `cell ${a.cell} is ${JSON.stringify(got.slice(0, 80))}, expected ${JSON.stringify(want)}`);
    }
    if (a.textContains?.length || a.textExcludes?.length) {
      const t = textOf(c.file, bytes);
      for (const s of a.textContains ?? []) if (!t.includes(s)) return fail(c, `text does not contain ${JSON.stringify(s.slice(0, 80))}`);
      for (const s of a.textExcludes ?? []) if (t.includes(s)) return fail(c, `text contains the excluded ${JSON.stringify(s.slice(0, 80))}`);
    }
    return pass(c);
  } catch (e) { return fail(c, (e as Error).message); }
}

/** Line-wise comparison of visible text against the expected file, within a declared tolerance of differing lines. */
export function diff(c: Extract<TaskCheck, { kind: 'diff' }>, bytes: Uint8Array, expected: Uint8Array): CheckVerdict {
  try {
    const lines = (p: string, b: Uint8Array) => textOf(p, b).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1 && a[i - 1] !== ''));
    const got = lines(c.file, bytes), want = lines(c.expected, expected);
    const n = Math.max(got.length, want.length);
    let differing = 0, first: string | undefined;
    for (let i = 0; i < n; i++) if (got[i] !== want[i]) { differing++; first ??= `line ${i + 1}: got ${JSON.stringify((got[i] ?? '<missing>').slice(0, 80))}, expected ${JSON.stringify((want[i] ?? '<missing>').slice(0, 80))}`; }
    const tol = c.maxDifferingLines ?? 0;
    const ev: Evidence = { kind: 'check', label: 'differing lines', measured: { name: 'differing-lines', value: differing, threshold: tol, op: '<=' }, ...(first ? { detail: first } : {}) };
    return differing <= tol ? pass(c, undefined, [ev]) : fail(c, first ?? 'differs', [ev]);
  } catch (e) { return fail(c, (e as Error).message); }
}

async function pagesOf(bytes: Uint8Array, f: 'docx' | 'xlsx' | 'pptx', tools: PipelineTools, signal?: AbortSignal) {
  return tools.officecli!.renderPages(bytes, f, { maxPages: 20, width: 900, height: 700, signal });
}

export async function render(c: Extract<TaskCheck, { kind: 'render' }>, bytes: Uint8Array, tools: PipelineTools, signal?: AbortSignal): Promise<CheckVerdict> {
  const f = formatOf(c.file);
  if (!f) return fail(c, 'render is defined for docx, xlsx and pptx outputs');
  if (!tools.officecli) return skip(c, 'tool-missing:officecli');
  try {
    const r = await pagesOf(bytes, f, tools, signal);
    let blank = 0;
    for (const p of r.pages) {
      try { const img = decodePng(p.png); if (meanLuma(img) < BLACK_LUMA || inkFraction(img) < INK_FLOOR) blank++; }
      catch (e) { return fail(c, `page ${p.page} is not a readable PNG${e instanceof PngError ? `: ${e.message}` : ''}`); }
    }
    const max = c.maxBlankPages ?? 0;
    const ev: Evidence = { kind: 'check', label: `${r.pages.length} page(s) rendered`, measured: { name: 'blank-pages', value: blank, threshold: max, op: '<=' } };
    return blank <= max ? pass(c, undefined, [ev]) : fail(c, `${blank} blank or black page(s) of ${r.pages.length}`, [ev]);
  } catch (e) { return fail(c, `render failed: ${String((e as Error).message).slice(0, 160)}`); }
}

export async function fidelity(c: Extract<TaskCheck, { kind: 'fidelity' }>, bytes: Uint8Array, reference: Uint8Array, tools: PipelineTools, signal?: AbortSignal): Promise<CheckVerdict> {
  const f = formatOf(c.file);
  if (!f) return fail(c, 'fidelity is defined for docx, xlsx and pptx outputs');
  if (!tools.officecli) return skip(c, 'tool-missing:officecli');
  if (!tools.visual) return skip(c, 'tool-missing:visual');
  try {
    const [a, b] = [await pagesOf(reference, f, tools, signal), await pagesOf(bytes, f, tools, signal)];
    if (!a.pages[0] || !b.pages[0]) return fail(c, 'no page rendered');
    const m = await tools.visual.compare(a.pages[0].png, b.pages[0].png, { clip: false, dino: false });
    const ev: Evidence[] = [m.pixel, m.ssim].map((x) => ({ kind: 'check' as const, label: `page 1 ${x.name}`, measured: x }));
    const ok = [m.pixel, m.ssim].every((x) => x.op === '>=' ? x.value >= x.threshold : x.op === '<=' ? x.value <= x.threshold : x.value === x.threshold);
    return ok ? pass(c, undefined, ev) : fail(c, 'page 1 differs from the reference render beyond the named thresholds', ev);
  } catch (e) { return fail(c, `fidelity failed: ${String((e as Error).message).slice(0, 160)}`); }
}
