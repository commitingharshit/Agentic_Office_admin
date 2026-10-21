// Corpus of the verification-pipeline eval (Plan 4 Task 7). Three groups, every case labelled with its EXPECTED outcome before it is run:
//   benign   real templates with their own thumbnails as previews: the pipeline must never end in `fail`;
//   hostile  the template-validator corpus (52 hostile or malformed packages): must end in `fail` (or be refused at unpack);
//   broken   valid-OOXML-but-broken packages that only the pipeline's tool stages catch (xlsx #REF!, circular reference, dangling docx
//            cross-reference, pptx dangling notes relationship, a preview swapped from another template, a blank slide deck).
//            Each names the stage(s) that must catch it and the tools it needs; with a tool missing the case is SKIPPED (counted, printed).
import { crc32, deflateSync } from 'node:zlib';
import { strToU8 } from 'fflate';
import { cases as hostileCases, dec, mutate, pack, tpl, PPTX, DOCX, XLSX } from '../template-corpus.ts';

export type Tool = 'officecli' | 'kernel';
export interface VCase { id: string; label: 'benign' | 'hostile' | 'broken'; note: string; /** stages of which at least one must fail (broken) */ catches?: string[]; needs: Tool[]; build(): Uint8Array }

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0); return out;
};
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y), o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
const blank = () => png(96, 54, () => [255, 255, 255]);
const real = (rel: string, format: 'pptx' | 'docx' | 'xlsx' | 'pdf') => pack(format, tpl(rel), { 'previews/1.png': tpl(`thumbnails/${rel.replace('/', '-').replace(/\.[a-z]+$/, '')}.png`) });
const slide1 = (z: Record<string, Uint8Array>) => Object.keys(z).find((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))!;
const onePageDeck = (edit?: (z: Record<string, Uint8Array>) => void) => mutate(PPTX, (z) => {
  z['ppt/presentation.xml'] = strToU8(dec(z['ppt/presentation.xml']).replace(/(<p:sldIdLst>\s*<p:sldId [^>]*\/>)[\s\S]*?(<\/p:sldIdLst>)/, '$1$2'));
  edit?.(z);
});
const F10 = '<f>D10*COUNT(H10:S10)/12-E10</f><v></v>';
const sheet = (edit: (s: string) => string) => mutate(XLSX, (z) => { z['xl/worksheets/sheet1.xml'] = strToU8(edit(dec(z['xl/worksheets/sheet1.xml']))); });

export const BENIGN: [string, 'pptx' | 'docx' | 'xlsx' | 'pdf', string][] = [
  ['pptx/board-update.pptx', 'pptx', 'real deck'], ['pptx/investor-pitch.pptx', 'pptx', 'real deck'], ['pptx/product-roadmap.pptx', 'pptx', 'real deck'], ['pptx/quarterly-review.pptx', 'pptx', 'real deck'],
  ['docx/board-memo.docx', 'docx', 'real document'], ['docx/meeting-notes.docx', 'docx', 'real document'], ['xlsx/budget-tracker.xlsx', 'xlsx', 'real workbook'], ['xlsx/sales-pipeline.xlsx', 'xlsx', 'real workbook'], ['pdf/one-pager.pdf', 'pdf', 'real PDF'],
];

export const vcases: VCase[] = [
  ...BENIGN.map(([rel, fmt, note], i): VCase => ({ id: `b${String(i + 1).padStart(2, '0')}-${rel.replace(/[/.]/g, '-')}`, label: 'benign', note: `${note}: templates/${rel} with its own thumbnail`, needs: [], build: () => real(rel, fmt) })),
  // the template-validator corpus: same packages, same labels, now through the whole pipeline
  ...hostileCases.filter((c) => c.label === 'malicious').map((c): VCase => ({ id: `h-${c.id}`, label: 'hostile', note: c.note, needs: [], build: () => c.build() as Uint8Array })),
  { id: 'v01-xlsx-ref-error', label: 'broken', note: 'a formula that evaluates to #REF! in an otherwise valid workbook', catches: ['issues', 'formula-validity'], needs: ['officecli'], build: () => pack('xlsx', sheet((x) => x.replace(F10, '<f>#REF!+1</f><v>#REF!</v>'))) },
  { id: 'v02-xlsx-circular', label: 'broken', note: 'F10 and F11 reference each other', catches: ['formula-validity'], needs: ['kernel'], build: () => pack('xlsx', sheet((x) => x.replace(F10, '<f>F11</f><v></v>').replace(/(<c r="F11"[^>]*>)<f>[^<]*<\/f>/, '$1<f>F10</f>'))) },
  { id: 'v03-docx-dangling-xref', label: 'broken', note: 'a cross-reference to "section 9" in a document that has no such heading', catches: ['docx-structure'], needs: ['kernel'], build: () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace(/section 3/g, 'section 9')); })) },
  { id: 'v04-pptx-dangling-notes', label: 'broken', note: 'a slide relationship to a notesSlide part that does not exist', catches: ['manifest', 'ooxml-schema', 'issues'], needs: ['officecli'], build: () => pack('pptx', mutate(PPTX, (z) => {
    const rels = slide1(z).replace('slides/', 'slides/_rels/') + '.rels';
    z[rels] = strToU8(dec(z[rels]).replace('</Relationships>', '<Relationship Id="rIdNotes9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide999.xml"/></Relationships>'));
  })) },
  { id: 'v05-preview-swapped', label: 'broken', note: 'board-update with the thumbnail of investor-pitch (bait and switch)', catches: ['preview-fidelity'], needs: ['officecli'], build: () => pack('pptx', PPTX, { 'previews/1.png': tpl('thumbnails/pptx-investor-pitch.png') }) },
  { id: 'v06-pptx-blank-deck', label: 'broken', note: 'a one-slide deck whose slide has no content, with a blank preview', catches: ['visual-sanity'], needs: ['officecli'], build: () => pack('pptx', onePageDeck((z) => {
    const p = slide1(z); z[p] = strToU8(dec(z[p]).replace(/<p:bg>[\s\S]*?<\/p:bg>/, '').replace(/(<p:spTree>[\s\S]*?(?:<p:grpSpPr\/>|<\/p:grpSpPr>))[\s\S]*(<\/p:spTree>)/, '$1$2'));
  }), { 'previews/1.png': blank() }) },
];
