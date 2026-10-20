import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { unzipSync, zipSync, strToU8, type Zippable } from 'fflate';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { createTemplateValidator } from '../src/marketplace/validate/template.ts';
import { officecliRenderer } from '../src/marketplace/validate/officecli.ts';
import { sha256Hex } from '../src/marketplace/artifacts.ts';
import type { ManifestV1, UnpackedPackage, ValidationCheck } from '../src/marketplace/types.ts';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/marketplace/${n}`, import.meta.url)));
const PPTX = fx('board-update.pptx'), DOCX = fx('board-memo.docx'), XLSX = fx('budget-tracker.xlsx'), PDF = fx('invoice.pdf');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function pkgOf(format: string, file: Uint8Array, over: { previews?: Record<string, Uint8Array>; payload?: Record<string, unknown> } = {}): UnpackedPackage {
  const previews = over.previews ?? { 'previews/1.png': PNG };
  const files = new Map<string, Uint8Array>([[`template.${format}`, file], ...Object.entries(previews)]);
  const manifest: ManifestV1 = {
    schema: 'agentic.marketplace/1', id: 'acme/tpl', type: 'template', version: '1.0.0', title: 'T', summary: 'S', license: 'MIT',
    compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })),
    payload: { format, file: `template.${format}`, previews: Object.keys(previews), ...over.payload },
  };
  return { files, manifest };
}
const run = async (pkg: UnpackedPackage) => validateArtifact('template', pkg);
const get = (r: { checks: ValidationCheck[] }, name: string) => r.checks.find(c => c.name === name);
const failed = (r: { checks: ValidationCheck[] }) => r.checks.filter(c => !c.ok).map(c => c.name);
/** Rewrites an OOXML fixture: `edit` receives the unzipped parts and may add/replace/delete. */
const mutate = (b: Uint8Array, edit: (z: Record<string, Uint8Array>) => void): Uint8Array => {
  const z = unzipSync(b); edit(z); return zipSync(z as Zippable);
};

describe('template validator: real fixtures', () => {
  for (const [fmt, bytes] of [['pptx', PPTX], ['docx', DOCX], ['xlsx', XLSX]] as const) {
    test(`${fmt} fixture passes every check`, async () => {
      const r = await run(pkgOf(fmt, bytes));
      assert.deepEqual(failed(r), [], JSON.stringify(r.checks.filter(c => !c.ok)));
      assert.equal(r.ok, true);
      for (const n of ['payload-shape', 'file-present', 'ooxml-zip', 'no-active-content', 'preview-images']) assert.equal(get(r, n)?.ok, true, n);
    });
  }
  test('registration runs common checks first, then template checks', async () => {
    const r = await run(pkgOf('pptx', PPTX));
    const names = r.checks.map(c => c.name);
    assert.ok(names.indexOf('files-match-hashes') < names.indexOf('payload-shape'));
  });
  test('officecli-open is reported skipped (never verified) by default, and is not required', async () => {
    const r = await run(pkgOf('pptx', PPTX));
    const c = get(r, 'officecli-open')!;
    assert.deepEqual({ ok: c.ok, skipped: c.skipped, detail: c.detail }, { ok: true, skipped: true, detail: 'skipped: no renderer configured' });
    assert.equal(r.verified, true);
  });
  test('a required skipped check makes the report unverified', async () => {
    const v = createTemplateValidator();
    const checks = await v(pkgOf('pptx', PPTX));
    assert.ok(checks.every(c => !(c.skipped && c.required)));
  });
  test('injected renderer failure fails officecli-open; success is not skipped', async () => {
    const bad = createTemplateValidator({ officecli: async () => ({ ok: false, detail: 'boom' }) });
    const c1 = (await bad(pkgOf('pptx', PPTX))).find(c => c.name === 'officecli-open')!;
    assert.equal(c1.ok, false); assert.match(c1.detail!, /boom/);
    const good = createTemplateValidator({ officecli: async () => ({ ok: true }) });
    const c2 = (await good(pkgOf('pptx', PPTX))).find(c => c.name === 'officecli-open')!;
    assert.equal(c2.ok, true); assert.notEqual(c2.skipped, true);
  });
  test('renderer is not run on a file that already failed structural checks', async () => {
    let called = false;
    const v = createTemplateValidator({ officecli: async () => { called = true; return { ok: true }; } });
    const cs = await v(pkgOf('pptx', strToU8('nope')));
    assert.equal(called, false);
    assert.equal(cs.find(c => c.name === 'officecli-open')!.skipped, true);
  });
});

describe('template validator: ooxml-zip', () => {
  test('a zip renamed .pptx that is not OOXML fails', async () => {
    const r = await run(pkgOf('pptx', zipSync({ 'hello.txt': strToU8('hi') })));
    assert.equal(get(r, 'ooxml-zip')!.ok, false);
    assert.match(get(r, 'ooxml-zip')!.detail!, /\[Content_Types\]\.xml/);
  });
  test('plain text is not a zip', async () => {
    const r = await run(pkgOf('docx', strToU8('not a zip')));
    assert.equal(get(r, 'ooxml-zip')!.ok, false);
  });
  test('truncated file fails', async () => {
    const r = await run(pkgOf('pptx', PPTX.slice(0, Math.floor(PPTX.length / 2))));
    assert.equal(get(r, 'ooxml-zip')!.ok, false);
  });
  test('missing [Content_Types].xml fails', async () => {
    const r = await run(pkgOf('pptx', mutate(PPTX, z => { delete z['[Content_Types].xml']; })));
    assert.equal(get(r, 'ooxml-zip')!.ok, false);
  });
  test('missing main part fails', async () => {
    const r = await run(pkgOf('xlsx', mutate(XLSX, z => { delete z['xl/workbook.xml']; })));
    assert.match(get(r, 'ooxml-zip')!.detail!, /xl\/workbook\.xml/);
  });
  test('Override naming a missing part fails', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('</Types>', '<Override PartName="/word/ghost.xml" ContentType="application/xml"/></Types>'));
    })));
    assert.match(get(r, 'ooxml-zip')!.detail!, /ghost\.xml/);
  });
  test('malformed main part XML fails', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/document.xml'] = strToU8('<w:document><w:body></w:document>'); })));
    assert.match(get(r, 'ooxml-zip')!.detail!, /document\.xml/);
  });
  test('DOCTYPE with ENTITY is rejected without expansion', async () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>';
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/document.xml'] = strToU8(evil); })));
    const c = get(r, 'ooxml-zip')!;
    assert.equal(c.ok, false);
    assert.match(c.detail!, /DOCTYPE/);
    assert.doesNotMatch(c.detail!, /root:/);
  });
});

describe('template validator: no-active-content', () => {
  test('vbaProject.bin fails', async () => {
    const r = await run(pkgOf('pptx', mutate(PPTX, z => { z['ppt/vbaProject.bin'] = new Uint8Array([1, 2, 3]); })));
    assert.equal(get(r, 'no-active-content')!.ok, false);
    assert.match(get(r, 'no-active-content')!.detail!, /vbaProject/);
  });
  test('macroEnabled content type fails', async () => {
    const r = await run(pkgOf('pptx', mutate(PPTX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('presentation.main+xml', 'presentation.macroEnabled.main+xml'));
    })));
    assert.equal(get(r, 'no-active-content')!.ok, false);
  });
  test('embedded OLE .bin fails', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/embeddings/oleObject1.bin'] = new Uint8Array([1]); })));
    assert.equal(get(r, 'no-active-content')!.ok, false);
  });
  const rels = (target: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`;
  test('external http:// relationship fails, listing it', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/_rels/extra.rels'] = strToU8(rels('http://evil.example/x')); })));
    assert.equal(get(r, 'no-active-content')!.ok, false);
    assert.match(get(r, 'no-active-content')!.detail!, /http:\/\/evil\.example\/x/);
  });
  test('external file: relationship fails', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/_rels/extra.rels'] = strToU8(rels('file:///etc/passwd')); })));
    assert.equal(get(r, 'no-active-content')!.ok, false);
  });
  test('external https:// relationship passes', async () => {
    const r = await run(pkgOf('docx', mutate(DOCX, z => { z['word/_rels/extra.rels'] = strToU8(rels('https://example.com/x')); })));
    assert.equal(get(r, 'no-active-content')!.ok, true);
  });
});

describe('template validator: pdf', () => {
  test('pdf fixture passes pdf-header', async () => {
    const r = await run(pkgOf('pdf', PDF));
    assert.deepEqual(failed(r), []);
    assert.equal(get(r, 'pdf-header')!.ok, true);
    assert.equal(get(r, 'ooxml-zip'), undefined);
  });
  const pdfWith = (extra: string) => new Uint8Array([...PDF.slice(0, PDF.length - 6), ...strToU8(`\n${extra}\n`), ...PDF.slice(PDF.length - 6)]);
  test('/JavaScript fails', async () => {
    const r = await run(pkgOf('pdf', strToU8('%PDF-1.4\n1 0 obj<</S/JavaScript /JS (app.alert(1))>>endobj\n%%EOF\n')));
    assert.equal(get(r, 'pdf-header')!.ok, false);
    assert.match(get(r, 'pdf-header')!.detail!, /JavaScript/);
  });
  test('name-escaped /J#61vaScript still fails', async () => {
    const r = await run(pkgOf('pdf', strToU8('%PDF-1.4\n<</S/J#61vaScript>>\n%%EOF\n')));
    assert.equal(get(r, 'pdf-header')!.ok, false);
  });
  test('/Launch fails', async () => {
    assert.equal(get(await run(pkgOf('pdf', pdfWith('<</S/Launch>>'))), 'pdf-header')!.ok, false);
  });
  test('bad header and missing EOF fail', async () => {
    assert.equal(get(await run(pkgOf('pdf', strToU8('hello %%EOF'))), 'pdf-header')!.ok, false);
    assert.equal(get(await run(pkgOf('pdf', PDF.slice(0, 200))), 'pdf-header')!.ok, false);
  });
});

describe('template validator: previews and payload', () => {
  test('jpeg preview passes', async () => {
    assert.equal(get(await run(pkgOf('pptx', PPTX, { previews: { 'p/a.jpg': JPG } })), 'preview-images')!.ok, true);
  });
  test('text named .png fails', async () => {
    const r = await run(pkgOf('pptx', PPTX, { previews: { 'previews/1.png': strToU8('hello') } }));
    assert.equal(get(r, 'preview-images')!.ok, false);
  });
  test('3 MiB preview fails', async () => {
    const big = new Uint8Array(3 * 1024 * 1024); big.set(PNG);
    assert.equal(get(await run(pkgOf('pptx', PPTX, { previews: { 'previews/1.png': big } })), 'preview-images')!.ok, false);
  });
  test('previews missing from package, empty, and >20 fail', async () => {
    assert.equal(get(await run(pkgOf('pptx', PPTX, { payload: { previews: ['nope.png'] } })), 'preview-images')!.ok, false);
    assert.equal(get(await run(pkgOf('pptx', PPTX, { payload: { previews: [] } })), 'payload-shape')!.ok, false);
    assert.equal(get(await run(pkgOf('pptx', PPTX, { payload: { previews: Array.from({ length: 21 }, (_, i) => `p${i}.png`) } })), 'payload-shape')!.ok, false);
  });
  test('payload.file not in package fails file-present; dependents are skipped', async () => {
    const r = await run(pkgOf('pptx', PPTX, { payload: { file: 'other.pptx' } }));
    assert.equal(get(r, 'file-present')!.ok, false);
    assert.equal(get(r, 'ooxml-zip')!.skipped, true);
    assert.equal(get(r, 'preview-images')!.ok, true); // independent checks still run
  });
  test('unsupported format fails payload-shape', async () => {
    const r = await run(pkgOf('pptx', PPTX, { payload: { format: 'odt' } }));
    assert.equal(get(r, 'payload-shape')!.ok, false);
    assert.equal(r.ok, false);
  });
  test('non-object payload fields fail payload-shape', async () => {
    assert.equal(get(await run(pkgOf('pptx', PPTX, { payload: { file: 5 } })), 'payload-shape')!.ok, false);
  });
});

const BIN = process.env.OFFICECLI_BIN ?? '/Users/harshitverma/.local/bin/officecli';
describe('officecli integration', { skip: !existsSync(BIN) && 'officecli binary not installed' }, () => {
  test('renders templates/pptx/board-update.pptx', async () => {
    const r = await officecliRenderer({ bin: BIN })(PPTX, 'pptx');
    assert.equal(r.ok, true, r.detail);
  });
  test('rejects garbage', async () => {
    const r = await officecliRenderer({ bin: BIN })(strToU8('garbage'), 'pptx');
    assert.equal(r.ok, false);
  });
});
