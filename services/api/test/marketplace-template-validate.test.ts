import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { unzipSync, zipSync, strToU8, type Zippable } from 'fflate';
import { registerValidator, validateArtifact } from '../src/marketplace/validate/index.ts';
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
  test('a required skipped check makes the report unverified (through validateArtifact)', async () => {
    registerValidator('template', () => [{ name: 'x-req', ok: true, skipped: true, required: true, detail: 'skipped: nope' }]);
    try {
      const r = await run(pkgOf('pptx', PPTX));
      assert.equal(r.ok, true);
      assert.equal(r.verified, false);
    } finally { registerValidator('template', createTemplateValidator()); }
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

describe('no-active-content: parser-based hardening (review round 1)', () => {
  const R = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
  const T = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
  const rel = (type: string, target: string, mode = ' TargetMode="External"', id = 'rIdX') => `<Relationship Id="${id}" Type="${T(type)}" Target="${target}"${mode}/>`;
  const withRels = (path: string, xml: string | Uint8Array, fmt: 'docx' | 'pptx' = 'docx') =>
    pkgOf(fmt, mutate(fmt === 'docx' ? DOCX : PPTX, z => { z[path] = typeof xml === 'string' ? strToU8(xml) : xml; }));
  const active = async (p: UnpackedPackage) => get(await run(p), 'no-active-content')!;
  const utf16 = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) { b[2 + 2 * i] = s.charCodeAt(i) & 255; b[3 + 2 * i] = s.charCodeAt(i) >> 8; } return b; };

  test('1: ">" inside an attribute value does not truncate the tag', async () => {
    assert.equal((await active(withRels('word/_rels/x.rels', R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="file:///c:/x>" TargetMode="External"/>`)))).ok, false);
    const p = pkgOf('docx', mutate(DOCX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('</Types>', '<Override PartName="/a>" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
    }));
    assert.equal((await active(p)).ok, false);
  });
  test('2: attribute injection cannot hide TargetMode', async () => {
    const x = R(`<Relationship Id=' TargetMode="Internal"' Type="${T('hyperlink')}" Target="file:///x" TargetMode="External"/>`);
    assert.equal((await active(withRels('word/_rels/x.rels', x))).ok, false);
  });
  test('3: UTF-16LE rels with a file: external target are caught', async () => {
    const c = await active(withRels('word/_rels/x.rels', utf16(R(rel('hyperlink', 'file:///etc/passwd')))));
    assert.equal(c.ok, false);
  });
  test('3b: undecodable rels fails closed', async () => {
    const r = await run(withRels('word/_rels/x.rels', new Uint8Array([0xff, 0xff, 0xfe, 0x80])));
    assert.equal(get(r, 'ooxml-zip')!.ok, false);
  });
  test('3c: UTF-16 [Content_Types].xml with macro type is caught', async () => {
    const p = pkgOf('docx', mutate(DOCX, z => {
      z['[Content_Types].xml'] = utf16('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>');
    }));
    assert.equal((await active(p)).ok, false);
  });
  test('nested rels (ppt/_rels/slide1.xml.rels style) are scanned', async () => {
    assert.equal((await active(withRels('ppt/slides/_rels/slide1.xml.rels', R(rel('image', 'file:///x.png')), 'pptx'))).ok, false);
  });
  test('4: https attachedTemplate rejected, https hyperlink accepted', async () => {
    assert.equal((await active(withRels('word/_rels/x.rels', R(rel('attachedTemplate', 'https://example.com/t.dotm'))))).ok, false);
    assert.equal((await active(withRels('word/_rels/x.rels', R(rel('image', 'https://example.com/i.png'))))).ok, false);
    assert.equal((await active(withRels('word/_rels/x.rels', R(rel('hyperlink', 'https://example.com/'))))).ok, true);
  });
  test('4: uppercase scheme, //host, UNC and single quotes, even without TargetMode', async () => {
    for (const t of ['HTTP://x.example/a', 'http://x.example/a', 'FILE:///etc/passwd', '//host/share', '\\\\host\\share'])
      assert.equal((await active(withRels('word/_rels/x.rels', R(rel('hyperlink', t, ''))))).ok, false, t);
    assert.equal((await active(withRels('word/_rels/x.rels', R(`<Relationship Id='a' Type='${T('hyperlink')}' Target='HTTP://e.example/' TargetMode='External'/>`)))).ok, false);
  });
  test('4: oleObject / package / vbaProject relationships with internal targets are rejected', async () => {
    for (const t of ['oleObject', 'package', 'vbaProject'])
      assert.equal((await active(withRels('word/_rels/x.rels', R(rel(t, 'embeddings/a.dat', ''))))).ok, false, t);
  });
  test('5: macrosheet content type, macrosheet/dialogsheet parts, embedded packages, case-insensitive types', async () => {
    const ctWith = (c: string) => pkgOf('docx', mutate(DOCX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('</Types>', `<Override PartName="/word/document.xml" ContentType="${c}"/></Types>`));
    }));
    assert.equal((await active(ctWith('application/vnd.ms-excel.macrosheet+xml'))).ok, false);
    assert.equal((await active(ctWith('application/vnd.ms-word.document.MACROENABLED.main+xml'))).ok, false);
    for (const part of ['xl/macrosheets/sheet1.xml', 'xl/dialogsheets/sheet1.xml', 'word/embeddings/evil.docm', 'ppt/embeddings/a.xlsm', 'word/embeddings/x.docx', 'word/embeddings/x.ole', 'word/ActiveX/a.xml'])
      assert.equal((await active(pkgOf('docx', mutate(DOCX, z => { z[part] = strToU8('<a/>'); })))).ok, false, part);
  });
  test('minor: Override existence is case-insensitive and percent-decoded; case-colliding part names rejected', async () => {
    const p = pkgOf('docx', mutate(DOCX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('</Types>', '<Override PartName="/WORD/Document.xml" ContentType="application/xml"/><Override PartName="/word/doc%75ment.xml" ContentType="application/xml"/></Types>'));
    }));
    assert.equal(get(await run(p), 'ooxml-zip')!.ok, true);
    const q2 = pkgOf('docx', mutate(DOCX, z => { z['word/Document.xml'] = strToU8('<a/>'); }));
    assert.equal(get(await run(q2), 'ooxml-zip')!.ok, false);
  });
});

describe('chart-embedded workbooks', () => {
  test('a macro inside a chart workbook is rejected; the untouched workbook passes', async () => {
    const p = pkgOf('pptx', mutate(PPTX, z => {
      const k = Object.keys(z).find(n => /embeddings\/.*\.xlsx$/.test(n))!;
      z[k] = zipSync({ ...unzipSync(z[k]), 'xl/vbaProject.bin': new Uint8Array([1]) } as Zippable);
    }));
    const c = get(await run(p), 'no-active-content')!;
    assert.equal(c.ok, false); assert.match(c.detail!, /vbaProject/);
  });
});

describe('officecli renderer hardening', () => {
  const fake = (body: string) => {
    const d = mkdtempSync(join(tmpdir(), 'fakecli-')); const f = join(d, 'fake.sh');
    writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f;
  };
  test('timeout returns promptly even when a grandchild holds stderr open', async () => {
    const bin = fake('sleep 30 &\nsleep 30');
    const t0 = Date.now();
    const r = await officecliRenderer({ bin, timeoutMs: 500 })(PPTX, 'pptx');
    assert.equal(r.ok, false);
    assert.match(r.detail!, /timed out/);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  });
  test('child does not inherit server secrets', async () => {
    process.env.MKT_TEST_SECRET = 's3cret';
    try {
      const bin = fake('if [ -n "$MKT_TEST_SECRET" ]; then echo leaked >&2; exit 3; fi\nexit 4');
      const r = await officecliRenderer({ bin, timeoutMs: 5000 })(PPTX, 'pptx');
      assert.doesNotMatch(r.detail!, /leaked/);
      assert.match(r.detail!, /exited 4/);
    } finally { delete process.env.MKT_TEST_SECRET; }
  });
});

describe('round 2: exact-case attributes, chart package binding, macro extensions, magic bytes', () => {
  const T = (t: string) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;
  const R = (inner: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;
  const active = async (p: UnpackedPackage) => get(await run(p), 'no-active-content')!;
  const rejected = async (p: UnpackedPackage) => { const r = await run(p); return !r.ok; };
  const withRels = (xml: string, path = 'word/_rels/x.rels') => pkgOf('docx', mutate(DOCX, z => { z[path] = strToU8(xml); }));

  test('NEW-1: case-variant duplicate attributes are rejected (rels)', async () => {
    for (const x of [
      `<Relationship Id="a" target="https://ok" Type="${T('hyperlink')}" Target="file:///x" TargetMode="External"/>`,
      `<Relationship Id="a" type="${T('hyperlink')}" Type="${T('oleObject')}" Target="x"/>`,
      `<Relationship Id="a" Type="${T('hyperlink')}" targetmode="Internal" Target="file:///x" TargetMode="External"/>`,
    ]) assert.equal(await rejected(withRels(R(x))), true, x);
  });
  test('NEW-1: case-variant ContentType decoy is rejected', async () => {
    const p = pkgOf('docx', mutate(DOCX, z => {
      const ct = new TextDecoder().decode(z['[Content_Types].xml']);
      z['[Content_Types].xml'] = strToU8(ct.replace('</Types>', '<Default Extension="bin" contenttype="text/plain" ContentType="application/vnd.ms-office.vbaProject"/></Types>'));
    }));
    assert.equal(await rejected(p), true);
  });
  test('NEW-1: decoy inside a chart-reached embedded workbook is rejected', async () => {
    const p = pkgOf('pptx', mutate(PPTX, z => {
      const k = Object.keys(z).find(n => /embeddings\/.*\.xlsx$/.test(n))!;
      const inner = unzipSync(z[k]);
      inner['xl/_rels/x.rels'] = strToU8(R(`<Relationship Id="a" target="https://ok" Type="${T('hyperlink')}" Target="file:///x" TargetMode="External"/>`));
      z[k] = zipSync(inner as Zippable);
    }));
    assert.equal((await active(p)).ok, false);
  });

  const chartPkg = (target: string, partName: string, bytes: Uint8Array) => pkgOf('pptx', mutate(PPTX, z => {
    const rk = Object.keys(z).find(n => /charts\/_rels\/.*\.rels$/.test(n))!;
    z[rk] = strToU8(R(`<Relationship Id="rId1" Type="${T('package')}" Target="${target}"/>`));
    z[partName] = bytes;
  }));
  test('NEW-2: chart package pointing anywhere but a scanned embeddings workbook is rejected', async () => {
    const MZ = strToU8('MZ\x90\x00');
    for (const [t, n] of [['../media/p.xlsm', 'ppt/media/p.xlsm'], ['../media/p.exe', 'ppt/media/p.exe'], ['../x/p.bin', 'ppt/x/p.bin'], ['../embeddings/s/p.xlsm', 'ppt/embeddings/s/p.xlsm'], ['../embeddings/p.bin', 'ppt/embeddings/p.bin']] as const)
      assert.equal((await active(chartPkg(t, n, MZ))).ok, false, t);
  });
  test('NEW-2: chart package that resolves to a missing file is not exempt', async () => {
    assert.equal((await active(chartPkg('../embeddings/ghost.xlsx', 'ppt/other.txt', strToU8('x')))).ok, false);
  });
  test('NEW-2: macro-extension parts at any path are rejected, even via an internal absolute attachedTemplate', async () => {
    for (const n of ['word/x/a.dotm', 'xl/a.xlam', 'xl/media/a.xlsm', 'ppt/a.sldm', 'ppt/a.ppam'])
      assert.equal((await active(pkgOf('docx', mutate(DOCX, z => { z[n] = strToU8('x'); z['word/_rels/x.rels'] = strToU8(R(`<Relationship Id="z" Type="${T('attachedTemplate')}" Target="/${n}"/>`)); })))).ok, false, n);
  });
  test('NEW-2: executable magic in any non-XML part is rejected', async () => {
    for (const [n, b] of [['word/media/p.exe', [0x4d, 0x5a, 0x90, 0]], ['word/media/p.png', [0x7f, 0x45, 0x4c, 0x46]], ['word/media/q.dat', [0xcf, 0xfa, 0xed, 0xfe]]] as const)
      assert.equal((await active(pkgOf('docx', mutate(DOCX, z => { z[n] = new Uint8Array(b); })))).ok, false, n);
  });
  test('quick win: relationship Type is matched by last segment, ignoring trailing slash / fragment', async () => {
    for (const ty of [T('oleObject') + '/', T('oleObject') + '#x', T('OLEOBJECT')])
      assert.equal(await rejected(withRels(R(`<Relationship Id="a" Type="${ty}" Target="embeddings/a.dat"/>`))), true, ty);
  });
  test('quick win: control characters smuggled via character references in attributes are rejected', async () => {
    assert.equal(await rejected(withRels(R(`<Relationship Id="a" Type="${T('hyperlink')}" Target="https://x&#1;y" TargetMode="External"/>`))), true);
  });
});

describe('officecli: slot is released when mkdtemp fails', () => {
  test('bad TMPDIR does not leak the concurrency slot', async () => {
    const old = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent-dir-for-test';
    try {
      const r = officecliRenderer({ bin: '/bin/true', timeoutMs: 1000 });
      for (let i = 0; i < 4; i++) await assert.rejects(() => r(PPTX, 'pptx'));
    } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
  });
});

const BIN =  process.env.OFFICECLI_BIN ?? '/Users/harshitverma/.local/bin/officecli';
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
