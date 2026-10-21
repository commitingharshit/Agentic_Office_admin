// Deterministic zip corpus generator for the three-reader differential (marketplace Plan 4, Task 9).
// Pure node: no network, no fflate, erasable TypeScript only (the differential script imports this file with node's
// type stripping). The same seed always yields byte-identical zips. Nothing is written to the repo: callers write the
// corpus into a temp dir (writeCorpus).
//
// Each case carries `expect`, the verdict a CORRECT reader must give:
//   'reject' = unsafe or invalid in a way no reader may accept,  'accept' = a well formed package every reader must take,
//   'any'    = implementation-defined structure (readers may differ; the comparator then only enforces agreement on content).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

export type Expect = 'accept' | 'reject' | 'any';
export interface FuzzCase { id: string; cls: string; expect: Expect; note: string; bytes: Uint8Array }

export interface Ent {
  name: string | Uint8Array; localName?: string | Uint8Array; data: Uint8Array;
  method?: number; raw?: Uint8Array; flags?: number; lflags?: number;
  crc?: number; lcrc?: number; usize?: number; lusize?: number; csize?: number; lcsize?: number;
  mode?: number; attrs?: number; extra?: Uint8Array; lextra?: Uint8Array; nameLen?: number; dd?: Uint8Array;
  lho?: number; made?: number;
}
export interface ZipOpts {
  comment?: Uint8Array; commentLen?: number; prefix?: Uint8Array; prefixAdjust?: boolean; suffix?: Uint8Array;
  count?: number; total?: number; cdSize?: number; cdOff?: number; disk?: number; cdDisk?: number;
  zip64?: { count: number; cdSize: number; cdOff: number } | 'locator-only'; noEocd?: boolean;
}
export interface Layout { locals: [number, number][]; cd: [number, number]; eocd: [number, number] }

const te = new TextEncoder();
const bytes = (s: string | Uint8Array) => (typeof s === 'string' ? te.encode(s) : s);
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function buildZipLayout(ents: Ent[], o: ZipOpts = {}): { bytes: Uint8Array; layout: Layout } {
  const pre = o.prefix ?? new Uint8Array(0), adj = o.prefixAdjust ? pre.length : 0;
  const out: number[][] = [];
  const parts: Uint8Array[] = [pre];
  let pos = pre.length;
  const locals: [number, number][] = [], cds: Uint8Array[] = [];
  for (const e of ents) {
    const nb = bytes(e.name), lnb = e.localName === undefined ? nb : bytes(e.localName), method = e.method ?? 0;
    const payload = e.raw ?? (method === 8 ? deflateRawSync(e.data) : e.data);
    const crc = e.crc ?? crc32(e.data), usize = e.usize ?? e.data.length, csize = e.csize ?? payload.length;
    const dd = e.dd !== undefined;
    const flags = e.flags ?? (0x800 | (dd ? 8 : 0)), lflags = e.lflags ?? flags;
    const lh = new Uint8Array(30 + lnb.length + (e.lextra?.length ?? 0)), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, lflags, true); lv.setUint16(8, method, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, e.lcrc ?? (dd ? 0 : crc), true); lv.setUint32(18, e.lcsize ?? (dd ? 0 : csize), true); lv.setUint32(22, e.lusize ?? (dd ? 0 : usize), true);
    lv.setUint16(26, lnb.length, true); lv.setUint16(28, e.lextra?.length ?? 0, true);
    lh.set(lnb, 30); if (e.lextra) lh.set(e.lextra, 30 + lnb.length);
    const start = pos;
    parts.push(lh, payload); pos += lh.length + payload.length;
    if (e.dd) { parts.push(e.dd); pos += e.dd.length; }
    locals.push([start, pos]);
    const cd = new Uint8Array(46 + nb.length + (e.extra?.length ?? 0)), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, e.made ?? ((3 << 8) | 20), true); cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, method, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, csize, true); cv.setUint32(24, usize, true);
    cv.setUint16(28, e.nameLen ?? nb.length, true); cv.setUint16(30, e.extra?.length ?? 0, true);
    cv.setUint32(38, e.attrs ?? (((e.mode ?? 0o100644) << 16) >>> 0), true); cv.setUint32(42, e.lho ?? (start - pre.length + adj), true);
    cd.set(nb, 46); if (e.extra) cd.set(e.extra, 46 + nb.length);
    cds.push(cd);
  }
  void out;
  const cdStart = pos, cdLen = cds.reduce((n, c) => n + c.length, 0);
  parts.push(...cds); pos += cdLen;
  if (o.zip64) {
    const rec = new Uint8Array(56), rv = new DataView(rec.buffer);
    const z = o.zip64 === 'locator-only' ? { count: ents.length, cdSize: cdLen, cdOff: cdStart - pre.length + adj } : o.zip64;
    if (o.zip64 !== 'locator-only') {
      rv.setUint32(0, 0x06064b50, true); rv.setBigUint64(4, 44n, true); rv.setUint16(12, 45, true); rv.setUint16(14, 45, true);
      rv.setBigUint64(24, BigInt(z.count), true); rv.setBigUint64(32, BigInt(z.count), true);
      rv.setBigUint64(40, BigInt(z.cdSize), true); rv.setBigUint64(48, BigInt(z.cdOff), true);
      parts.push(rec); pos += 56;
    }
    const loc = new Uint8Array(20), v = new DataView(loc.buffer);
    v.setUint32(0, 0x07064b50, true); v.setBigUint64(8, BigInt(cdStart + cdLen - pre.length + adj), true); v.setUint32(16, 1, true);
    parts.push(loc); pos += 20;
  }
  const eocdStart = pos;
  const comment = o.comment ?? new Uint8Array(0);
  if (!o.noEocd) {
    const ec = new Uint8Array(22), ev = new DataView(ec.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, o.disk ?? 0, true); ev.setUint16(6, o.cdDisk ?? 0, true);
    ev.setUint16(8, o.count ?? ents.length, true); ev.setUint16(10, o.total ?? o.count ?? ents.length, true);
    ev.setUint32(12, o.cdSize ?? cdLen, true); ev.setUint32(16, o.cdOff ?? (cdStart - pre.length + adj), true);
    ev.setUint16(20, o.commentLen ?? comment.length, true);
    parts.push(ec, comment); pos += 22 + comment.length;
  }
  if (o.suffix) { parts.push(o.suffix); pos += o.suffix.length; }
  const res = new Uint8Array(pos); let p = 0;
  for (const part of parts) { res.set(part, p); p += part.length; }
  return { bytes: res, layout: { locals, cd: [cdStart, cdStart + cdLen], eocd: [eocdStart, eocdStart + (o.noEocd ? 0 : 22)] } };
}
export const buildZip = (ents: Ent[], o: ZipOpts = {}) => buildZipLayout(ents, o).bytes;

// ---------------------------------------------------------------- valid packages

export const SKILL_MD = '---\nname: demo-skill\ndescription: A demo skill\n---\n\n# Demo\n\nHello.\n';
export const SKILL_ID = 'u-test/demo-skill', SKILL_VERSION = '1.0.0';
const MANIFEST = 'agentic.marketplace.json';
export type Files = [string, Uint8Array][];
const tb = (s: string) => te.encode(s);
export const baseSkillFiles = (): Files => [['SKILL.md', tb(SKILL_MD)], ['references/a.md', tb('reference a\n')], ['scripts/run.py', tb('print(1)\n')]];
export const baseTemplateFiles = (): Files => [['template.docx', tb('PK fake docx bytes for the zip differential\n')], ['README.md', tb('readme\n')]];

export function manifestFor(type: 'skill' | 'template', files: Files, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'agentic.marketplace/1', id: type === 'skill' ? SKILL_ID : 'u-test/demo-template', type, version: SKILL_VERSION,
    title: 'Demo', summary: 'A demo package', license: 'MIT', compat: { app: '>=0.1.0' }, dependencies: [], permissions: [],
    files: files.map(([path, b]) => ({ path, sha256: sha256(b), size: b.length })),
    payload: type === 'skill' ? { name: 'demo-skill', entry: 'SKILL.md' } : { file: 'template.docx' }, ...over,
  };
}
export interface PkgOpts { type?: 'skill' | 'template'; method?: 0 | 8; manifest?: Record<string, unknown>; manifestRaw?: Uint8Array; manifestName?: string; noManifest?: boolean; manifestLast?: boolean }
export function pkgEnts(files: Files, o: PkgOpts = {}): Ent[] {
  const type = o.type ?? 'skill', method = o.method ?? 0;
  const body = files.map(([name, data]): Ent => ({ name, data, method }));
  if (o.noManifest) return body;
  const mdata = o.manifestRaw ?? tb(JSON.stringify(o.manifest ?? manifestFor(type, files), null, 2));
  const m: Ent = { name: o.manifestName ?? MANIFEST, data: mdata, method };
  return o.manifestLast ? [...body, m] : [m, ...body];
}
export const validSkill = (o: PkgOpts = {}, files = baseSkillFiles()) => buildZip(pkgEnts(files, o));

// ---------------------------------------------------------------- PRNG

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] };
}

// ---------------------------------------------------------------- hand-written structural cases

export const NASTY_NAMES: [string, string][] = [
  ['dotdot', '../x.md'], ['dotdot-mid', 'a/../../x.md'], ['dotdot-only', '..'], ['dot', '.'], ['dot-seg', 'a/./b.md'], ['empty-seg', 'a//b.md'],
  ['absolute', '/abs.md'], ['backslash', 'a\\b.md'], ['backslash-dotdot', '..\\x.md'], ['drive', 'C:x.md'], ['drive-abs', 'c:/x.md'], ['unc', '//srv/share/x.md'],
  ['colon', 'a:b.md'], ['ads', 'SKILL.md:stream'], ['reserved-con', 'con.md'], ['reserved-nul', 'NUL'], ['reserved-com1', 'dir/COM1.txt'], ['reserved-lpt9', 'lpt9.md'],
  ['git', '.git/config'], ['git-upper', '.GIT/x.md'], ['git-nested', 'dir/.git/x.md'], ['trailing-dot', 'trailing.'], ['trailing-space', 'trailing '], ['leading-space', ' lead.md'],
  ['ctl-01', 'ctl\x01.md'], ['ctl-7f', 'x\x7f.md'], ['nul-byte', 'a\x00b.md'], ['newline', 'a\nb.md'], ['too-long', `${'a'.repeat(300)}.md`], ['empty', ''],
  ['dir-dotdot', '../'], ['trailing-slash-file', 'x.md/'],
];

const NFC_E = '\u00e9.md', NFD_E = 'e\u0301.md';

function hand(): FuzzCase[] {
  const cs: FuzzCase[] = [];
  const add = (cls: string, expect: Expect, note: string, b: Uint8Array) => cs.push({ id: `h-${String(cs.length).padStart(3, '0')}-${cls}`, cls, expect, note, bytes: b });
  const S = baseSkillFiles, T = baseTemplateFiles;

  // valid packages
  add('valid-skill-stored', 'accept', 'valid skill, stored', validSkill());
  add('valid-skill-deflate', 'accept', 'valid skill, deflate', validSkill({ method: 8 }));
  add('valid-skill-manifest-last', 'accept', 'manifest after the files', validSkill({ manifestLast: true }));
  add('valid-template-stored', 'any', 'valid template (Hermes reads skills only)', validSkill({ type: 'template' }, T()));
  add('valid-template-deflate', 'any', 'valid template, deflate', validSkill({ type: 'template', method: 8 }, T()));
  add('valid-empty-file', 'accept', 'a zero-byte file', validSkill({}, [...S(), ['references/empty.md', new Uint8Array(0)]]));
  add('valid-empty-file-deflate', 'accept', 'a zero-byte deflated file', validSkill({ method: 8 }, [...S(), ['references/empty.md', new Uint8Array(0)]]));
  add('valid-utf8-name', 'accept', 'non-ASCII name with the UTF-8 flag', validSkill({}, [...S(), ['references/caf\u00e9.md', tb('x\n')]]));
  add('valid-zip-comment', 'accept', 'archive comment', buildZip(pkgEnts(S()), { comment: tb('hello comment') }));
  add('valid-dir-entry', 'accept', 'explicit directory entries', buildZip([...pkgEnts(S()), { name: 'references/', data: new Uint8Array(0), mode: 0o040755 }]));
  add('valid-prefix-adjusted', 'any', 'SFX-style prefix with offsets adjusted', buildZip(pkgEnts(S()), { prefix: tb('#!/bin/sh\nexit\n'), prefixAdjust: true }));
  add('valid-extra-field', 'accept', 'benign extra field', buildZip(pkgEnts(S()).map((e) => ({ ...e, extra: Uint8Array.of(0x55, 0x58, 4, 0, 1, 2, 3, 4), lextra: Uint8Array.of(0x55, 0x58, 4, 0, 1, 2, 3, 4) }))));
  add('valid-dd-honest', 'accept', 'data descriptor flag, honest descriptor', buildZip(pkgEnts(S()).map((e) => {
    const d = new Uint8Array(16), v = new DataView(d.buffer); v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc32(e.data), true);
    const c = deflateRawSync(e.data).length; void c; v.setUint32(8, e.data.length, true); v.setUint32(12, e.data.length, true);
    return { ...e, dd: d };
  })));
  add('valid-30-files', 'accept', '30 small files', validSkill({}, [...S(), ...Array.from({ length: 27 }, (_, i): [string, Uint8Array] => [`references/f${i}.md`, tb(`f${i}\n`)])]));

  // the zip-slip / unsafe-name table, listed in the manifest (name rules decide)
  for (const [label, name] of NASTY_NAMES) {
    const ex: Expect = label === 'leading-space' ? 'any' : 'reject';   // a leading space is legal on every filesystem we target
    add(`name-${label}`, ex, `unsafe name ${JSON.stringify(name)} listed in the manifest`, buildZip(pkgEnts([...S(), [name, tb('x\n')]])));
    add(`name-${label}-undeclared`, label === 'trailing-slash-file' ? 'any' : ex, `unsafe name ${JSON.stringify(name)} not listed in the manifest`, buildZip([...pkgEnts(S()), { name, data: tb('x\n') }]));
  }
  add('name-invalid-utf8-flagged', 'reject', 'bytes that are not UTF-8 with the UTF-8 flag set', buildZip([...pkgEnts(S()), { name: Uint8Array.of(0x72, 0x65, 0x66, 0x73, 0x2f, 0xff, 0xfe, 0x2e, 0x6d, 0x64), data: tb('x\n') }]));
  add('name-nonascii-noflag', 'reject', 'non-ASCII UTF-8 bytes without the UTF-8 flag', buildZip([...pkgEnts(S()), { name: tb('references/caf\u00e9.md'), data: tb('x\n'), flags: 0 }]));
  add('name-cp437-noflag', 'reject', 'cp437 byte without the flag listed under the UTF-8 name', buildZip(pkgEnts([...S(), ['references/caf\u00e9.md', tb('x\n')]]).map((e) => (e.name === 'references/caf\u00e9.md' ? { ...e, name: Uint8Array.of(...tb('references/caf'), 0x82, ...tb('.md')), flags: 0 } : e))));
  add('name-unicode-path-extra', 'accept', 'ASCII name plus an Info-ZIP unicode path extra field naming something else (ignored by all)', buildZip(pkgEnts(S()).map((e) => (e.name === 'references/a.md'
    ? { ...e, extra: Uint8Array.of(0x75, 0x70, 12, 0, 1, 0, 0, 0, 0, ...tb('../evil')) } : e))));

  // duplicates and collisions
  const dupA = pkgEnts(S());
  add('dup-exact-central', 'reject', 'same name twice in the central directory', buildZip([...dupA, { name: 'references/a.md', data: tb('other\n') }]));
  add('dup-exact-same-bytes', 'reject', 'same name twice, same bytes', buildZip([...dupA, { name: 'references/a.md', data: tb('reference a\n') }]));
  add('dup-case', 'reject', 'case-only collision', buildZip([...dupA, { name: 'SKILL.MD', data: tb('evil\n') }]));
  add('dup-case-dir', 'reject', 'case collision in directory part', buildZip([...dupA, { name: 'References/b.md', data: tb('b\n') }, { name: 'references/b.md', data: tb('c\n') }]));
  add('dup-nfc-nfd', 'reject', 'NFC and NFD forms of the same name', buildZip(pkgEnts([...S(), [NFC_E, tb('a\n')], [NFD_E, tb('b\n')]])));
  add('dup-kelvin', 'reject', 'KELVIN SIGN vs k (lowercases to k)', buildZip(pkgEnts([...S(), ['references/\u212a.md', tb('a\n')], ['references/k.md', tb('b\n')]])));
  add('dup-sharp-s', 'any', 'sharp s vs ss (full case fold only)', buildZip(pkgEnts([...S(), ['references/stra\u00dfe.md', tb('a\n')], ['references/strasse.md', tb('b\n')]])));
  add('dup-dotless-i', 'any', 'dotless i vs I (Turkish fold only)', buildZip(pkgEnts([...S(), ['references/\u0131.md', tb('a\n')], ['references/I.md', tb('b\n')]])));
  add('dup-long-s', 'any', 'long s vs s (casefold only)', buildZip(pkgEnts([...S(), ['references/\u017f.md', tb('a\n')], ['references/s.md', tb('b\n')]])));
  add('dup-file-and-dir', 'reject', 'a is both a file and a directory prefix', buildZip(pkgEnts([...S(), ['refs', tb('x\n')], ['refs/b.md', tb('y\n')]])));
  add('dup-file-and-dir-entry', 'reject', 'file entry a and directory entry a/', buildZip([...pkgEnts(S()), { name: 'references/a.md/', data: new Uint8Array(0), mode: 0o040755 }]));

  // symlinks and special modes
  for (const [label, mode] of [['symlink', 0o120777], ['symlink-0644', 0o120644]] as const)
    add(`mode-${label}`, 'reject', 'symlink external attrs on a listed file', buildZip(pkgEnts(S()).map((e) => (e.name === 'references/a.md' ? { ...e, mode } : e))));
  add('mode-symlink-dir-name', 'reject', 'symlink mode on a directory-named entry', buildZip([...pkgEnts(S()), { name: 'link/', data: new Uint8Array(0), mode: 0o120777 }]));
  add('mode-symlink-dos-attr', 'reject', 'symlink bits with a DOS host in version-made-by', buildZip(pkgEnts(S()).map((e) => (e.name === 'references/a.md' ? { ...e, mode: 0o120777, made: 20 } : e))));
  for (const [label, mode] of [['fifo', 0o010644], ['chardev', 0o020644], ['blockdev', 0o060644], ['socket', 0o140644], ['dir-bits-on-file', 0o040755], ['setuid', 0o104755]] as const)
    add(`mode-${label}`, 'any', `special mode ${label} on a listed file (a regular file is written regardless)`, buildZip(pkgEnts(S()).map((e) => (e.name === 'references/a.md' ? { ...e, mode } : e))));

  // end-of-central-directory lies
  const base = pkgEnts(S()), n = base.length;
  for (const [label, o] of [
    ['count-plus1', { count: n + 1, total: n + 1 }], ['count-minus1', { count: n - 1, total: n - 1 }], ['count-mismatch', { count: n, total: n + 1 }],
    ['count-zero', { count: 0, total: 0 }], ['count-ffff', { count: 0xffff, total: 0xffff }], ['cdoff-ffffffff', { cdOff: 0xffffffff }],
    ['cdsize-ffffffff', { cdSize: 0xffffffff }], ['cdoff-zero', { cdOff: 0 }], ['cdoff-beyond', { cdOff: 0x7fffffff }], ['cdsize-plus1', { cdSize: -1 }],
    ['cdsize-huge', { cdSize: 100000 }], ['disk-nonzero', { disk: 1 }], ['cd-disk-nonzero', { cdDisk: 1 }], ['comment-len-plus1', { comment: tb('abc'), commentLen: 4 }],
    ['comment-len-minus1', { comment: tb('abc'), commentLen: 2 }], ['comment-len-zero', { comment: tb('abc'), commentLen: 0 }],
  ] as [string, ZipOpts][]) {
    const built = buildZipLayout(base, o.cdSize === -1 ? {} : o);
    let b = built.bytes;
    if (o.cdSize === -1) { b = new Uint8Array(b); new DataView(b.buffer).setUint32(built.layout.eocd[0] + 12, built.layout.cd[1] - built.layout.cd[0] + 1, true); }
    add(`eocd-${label}`, 'any', `EOCD field lie: ${label}`, b);
  }
  add('eocd-missing', 'reject', 'no end-of-central-directory record', buildZip(base, { noEocd: true }));
  add('eocd-empty-archive', 'reject', 'an empty archive', buildZip([]));
  add('eocd-tiny', 'reject', '21 bytes', new Uint8Array(21));
  add('eocd-sig-only', 'reject', 'just the signature', Uint8Array.of(0x50, 0x4b, 5, 6, ...new Array(18).fill(0)));
  add('zip64-locator', 'any', 'zip64 locator before EOCD (no record)', buildZip(base, { zip64: 'locator-only' }));
  add('zip64-record-forged-cd', 'reject', 'zip64 record points at the same CD, standard EOCD fields 0xffff', buildZip(base, { count: 0xffff, total: 0xffff, cdSize: 0xffffffff, cdOff: 0xffffffff, zip64: { count: n, cdSize: 0, cdOff: 0 } }));
  add('zip64-entry-markers', 'reject', 'central sizes 0xffffffff with a zip64 extra field', buildZip(pkgEnts(S()).map((e) => ({ ...e, usize: 0xffffffff, csize: 0xffffffff, lho: 0xffffffff, extra: new Uint8Array([1, 0, 24, 0, ...new Array(24).fill(0)]) }))));
  add('zip64-usize-marker-only', 'reject', 'uncompressed size 0xffffffff with small data', buildZip(pkgEnts(S()).map((e) => (e.name === 'SKILL.md' ? { ...e, usize: 0xffffffff } : e))));

  // fake EOCD inside the comment (real EOCD followed by a second archive that a "last signature wins" reader sees)
  {
    const real = buildZipLayout(pkgEnts(S()), { comment: new Uint8Array(0) });
    const evilFiles: Files = [['SKILL.md', tb(SKILL_MD.replace('Hello.', 'EVIL.'))], ['references/a.md', tb('reference a\n')], ['scripts/run.py', tb('print(1)\n')]];
    const startAbs = real.bytes.length;                       // comment starts after the real EOCD
    const evil = buildZipLayout(pkgEnts(evilFiles, { manifest: manifestFor('skill', evilFiles) }), { noEocd: true, prefix: new Uint8Array(startAbs), prefixAdjust: true });
    const evilTail = evil.bytes.subarray(startAbs);            // evil locals + evil central directory, offsets absolute
    const mk = (fakeCommentLen: number, adjustCdOff = 0) => {
      const fake = new Uint8Array(22), fv = new DataView(fake.buffer);
      fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, n, true); fv.setUint16(10, n, true);
      fv.setUint32(12, evil.layout.cd[1] - evil.layout.cd[0], true); fv.setUint32(16, evil.layout.cd[0] + adjustCdOff, true); fv.setUint16(20, fakeCommentLen, true);
      const comment = new Uint8Array(evilTail.length + 22); comment.set(evilTail, 0); comment.set(fake, evilTail.length);
      return buildZip(pkgEnts(S()), { comment });
    };
    add('fake-eocd-comment-lying-len', 'any', 'fake EOCD (comment length lie) inside the real comment: last-signature readers see a different archive', mk(7));
    add('fake-eocd-comment-honest-len', 'any', 'fake EOCD with an honest zero comment length at the very end, in the comment of the real EOCD', mk(0));
  }

  // prefix, suffix, concatenation
  add('prefix-unadjusted', 'any', 'bytes before the first local header, offsets not adjusted', buildZip(base, { prefix: tb('JUNKJUNK') }));
  add('suffix-garbage', 'any', 'trailing bytes after the EOCD', buildZip(base, { suffix: tb('trailing garbage') }));
  add('suffix-zero-bytes', 'any', 'trailing NUL padding after the EOCD', buildZip(base, { suffix: new Uint8Array(16) }));
  add('concat-two-zips', 'any', 'two valid packages concatenated', (() => { const a = validSkill(), b = validSkill({ method: 8 }); const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; })());
  add('concat-junk-then-zip', 'any', 'text then a valid package', (() => { const a = tb('not a zip at all, '), b = validSkill(); const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; })());

  // per entry header/data mismatches
  const only = (name: string, patch: Partial<Ent>) => buildZip(pkgEnts(S()).map((e) => (e.name === name ? { ...e, ...patch } : e)));
  const R = 'references/a.md', Rd = tb('reference a\n');
  add('hdr-local-name-differs', 'any', 'local header names another file than the central directory', only(R, { localName: 'references/b.md' }));
  add('hdr-local-name-evil', 'any', 'local header name is ../evil (central is fine; all readers use the central name)', only(R, { localName: '../evil.md' }));
  add('hdr-local-sizes-lie', 'any', 'local header sizes and CRC lie, central is right', only(R, { lcrc: 1, lusize: 999, lcsize: 999 }));
  add('hdr-local-flags-encrypted', 'any', 'encrypted flag only in the local header', only(R, { lflags: 0x801 }));
  add('hdr-central-encrypted', 'reject', 'encrypted flag in the central directory', only(R, { flags: 0x801 }));
  add('hdr-strong-encryption', 'any', 'strong-encryption flag (bit 6)', only(R, { flags: 0x840 }));
  add('hdr-central-crc-wrong', 'reject', 'wrong CRC (stored)', only(R, { crc: 0xdeadbeef }));
  add('hdr-deflate-crc-wrong', 'reject', 'wrong CRC (deflate)', buildZip(pkgEnts(S(), { method: 8 }).map((e) => (e.name === R ? { ...e, crc: 7 } : e))));
  add('hdr-usize-plus1-stored', 'reject', 'declared size one over (stored)', only(R, { usize: Rd.length + 1 }));
  add('hdr-usize-minus1-stored', 'reject', 'declared size one under (stored)', only(R, { usize: Rd.length - 1 }));
  add('hdr-csize-minus1-stored', 'reject', 'compressed size one under (stored)', only(R, { csize: Rd.length - 1 }));
  add('hdr-csize-plus1-stored', 'reject', 'compressed size one over (stored)', only(R, { csize: Rd.length + 1 }));
  add('hdr-usize-minus1-deflate', 'reject', 'declared size under the real inflated size (deflate)', buildZip(pkgEnts(S(), { method: 8 }).map((e) => (e.name === R ? { ...e, usize: Rd.length - 1 } : e))));
  add('hdr-usize-plus1-deflate', 'reject', 'declared size over the real inflated size (deflate)', buildZip(pkgEnts(S(), { method: 8 }).map((e) => (e.name === R ? { ...e, usize: Rd.length + 1 } : e))));
  add('hdr-csize-zero-deflate', 'reject', 'compressed size 0', buildZip(pkgEnts(S(), { method: 8 }).map((e) => (e.name === R ? { ...e, csize: 0 } : e))));
  add('hdr-method-mismatch-stored-as-deflate', 'reject', 'central says deflate, data is stored', only(R, { method: 8, raw: Rd }));
  add('hdr-method-mismatch-deflate-as-stored', 'reject', 'central says stored, data is deflated', only(R, { method: 0, raw: deflateRawSync(Rd) }));
  for (const m of [1, 6, 9, 12, 14, 93, 95, 98, 99]) add(`hdr-method-${m}`, 'reject', `compression method ${m} with a payload no reader can decode`, only(R, { method: m, raw: Rd }));
  add('hdr-method-12-valid-bzip2', 'any', 'method 12 with real bzip2 data (Python can decode it, TS readers cannot)', only(R, { method: 12, raw: Uint8Array.from(Buffer.from('425a6839314159265359d3188f5c0000055180001040002b011000200021a0c9ea10c08c7bd04445f8bb9229c2848698c47ae0', 'hex')) }));
  add('hdr-nonmonotonic-lho', 'reject', 'local header offset points past the end', only(R, { lho: 0x7fffff }));
  add('hdr-lho-into-cd', 'reject', 'local header offset points into the central directory', only(R, { lho: 0x3000 }));
  add('hdr-lho-self-twice', 'any', 'two central entries share one local header (overlap)', buildZip([...pkgEnts(S()), { name: 'references/alias.md', data: Rd, lho: 30 + 'agentic.marketplace.json'.length + 0, localName: 'references/alias.md' }]));
  add('hdr-overlap-data', 'reject', 'entry data runs into the next entry (csize too big)', only('SKILL.md', { csize: 400, usize: 400 }));
  add('hdr-nameLen-lie', 'reject', 'central name length longer than the actual name', only(R, { nameLen: R.length + 5 }));
  add('hdr-nameLen-short', 'reject', 'central name length shorter than the actual name', only(R, { nameLen: R.length - 3 }));
  add('hdr-extra-overflow', 'reject', 'central extra length reaches past the archive', buildZip(pkgEnts(S()).map((e) => (e.name === R ? { ...e, extra: Uint8Array.of(1, 2, 3, 4) } : e)), { cdSize: undefined, count: n }).slice(0, -30));
  add('hdr-local-extra-huge', 'reject', 'local extra length 0xffff', (() => { const { bytes: b, layout } = buildZipLayout(pkgEnts(S())); const o = new Uint8Array(b); new DataView(o.buffer).setUint16(layout.locals[1][0] + 28, 0xffff, true); return o; })());
  add('hdr-local-name-len-huge', 'reject', 'local name length 0xffff', (() => { const { bytes: b, layout } = buildZipLayout(pkgEnts(S())); const o = new Uint8Array(b); new DataView(o.buffer).setUint16(layout.locals[1][0] + 26, 0xffff, true); return o; })());
  add('hdr-dd-lying', 'any', 'data descriptor with lying sizes and CRC, central is right', buildZip(pkgEnts(S()).map((e) => ({ ...e, dd: Uint8Array.of(0x50, 0x4b, 7, 8, 9, 9, 9, 9, 1, 0, 0, 0, 2, 0, 0, 0) }))));
  add('hdr-dd-flag-no-descriptor', 'any', 'data descriptor flag with no descriptor bytes', buildZip(pkgEnts(S()).map((e) => ({ ...e, flags: 0x808 }))));
  add('hdr-utf8-flag-off-ascii', 'accept', 'UTF-8 flag cleared on an ASCII name', buildZip(pkgEnts(S()).map((e) => ({ ...e, flags: 0 }))));
  add('hdr-utf8-flag-local-only', 'any', 'UTF-8 flag differs between local and central', buildZip(pkgEnts(S()).map((e) => ({ ...e, lflags: 0 }))));
  add('hdr-version-made-by-dos', 'accept', 'version made by MS-DOS, mode bits ignored', buildZip(pkgEnts(S()).map((e) => ({ ...e, made: 20 }))));

  // manifest cases
  const flist = S();
  add('manifest-missing', 'reject', 'no manifest', validSkill({ noManifest: true }));
  add('manifest-in-subdir', 'reject', 'manifest in a subdirectory', validSkill({ manifestName: 'sub/agentic.marketplace.json' }));
  add('manifest-wrong-case', 'reject', 'manifest name differs by case', validSkill({ manifestName: 'Agentic.Marketplace.json' }));
  add('manifest-twice', 'reject', 'two manifests', buildZip([...pkgEnts(flist), { name: MANIFEST, data: tb(JSON.stringify(manifestFor('skill', flist))) }]));
  add('manifest-bad-json', 'reject', 'manifest is not JSON', validSkill({ manifestRaw: tb('{not json') }));
  add('manifest-bom', 'any', 'manifest with a UTF-8 BOM', validSkill({ manifestRaw: Uint8Array.of(0xef, 0xbb, 0xbf, ...tb(JSON.stringify(manifestFor('skill', flist)))) }));
  add('manifest-invalid-utf8', 'reject', 'manifest with invalid UTF-8', validSkill({ manifestRaw: Uint8Array.of(...tb('{"schema":"'), 0xff, ...tb('"}')) }));
  add('manifest-wrong-schema', 'reject', 'wrong schema string', validSkill({ manifest: manifestFor('skill', flist, { schema: 'agentic.marketplace/2' }) }));
  add('manifest-hash-wrong', 'reject', 'listed sha256 does not match', validSkill({ manifest: manifestFor('skill', flist, { files: flist.map(([path, b]) => ({ path, sha256: sha256(tb('x')), size: b.length })) }) }));
  add('manifest-size-wrong', 'reject', 'listed size does not match', validSkill({ manifest: manifestFor('skill', flist, { files: flist.map(([path, b]) => ({ path, sha256: sha256(b), size: b.length + 1 })) }) }));
  add('manifest-undeclared-file', 'reject', 'an extra file the manifest does not list', buildZip([...pkgEnts(flist), { name: 'references/extra.md', data: tb('x\n') }]));
  add('manifest-missing-file', 'reject', 'a listed file not in the archive', validSkill({ manifest: manifestFor('skill', [...flist, ['references/ghost.md', tb('g\n')]]) }));
  add('manifest-lists-itself', 'reject', 'manifest lists itself', validSkill({ manifest: manifestFor('skill', [...flist, [MANIFEST, tb('x')]]) }));
  add('manifest-dup-listing', 'reject', 'a file listed twice', validSkill({ manifest: manifestFor('skill', [...flist, flist[1]]) }));
  add('manifest-listed-path-dotdot', 'reject', 'manifest lists ../x.md', validSkill({ manifest: manifestFor('skill', [...flist, ['../x.md', tb('x')]]) }));
  add('manifest-extra-keys', 'accept', 'unknown manifest keys are ignored', validSkill({ manifest: manifestFor('skill', flist, { futureField: { a: 1 } }) }));
  add('manifest-id-bad', 'reject', 'id is not publisher/slug', validSkill({ manifest: manifestFor('skill', flist, { id: 'Not Valid' }) }));
  add('manifest-version-bad', 'reject', 'version is not semver', validSkill({ manifest: manifestFor('skill', flist, { version: '1.0' }) }));
  add('manifest-id-mismatch-listing', 'any', 'manifest id is not the listing the client asked for', validSkill({ manifest: manifestFor('skill', flist, { id: 'u-other/demo-skill' }) }));
  add('manifest-type-unknown', 'reject', 'unknown manifest type', validSkill({ manifest: manifestFor('skill', flist, { type: 'wizardry' }) }));
  add('manifest-huge', 'any', 'a 3 MiB manifest', validSkill({ manifestRaw: tb(JSON.stringify(manifestFor('skill', flist, { summary: 'x'.repeat(10) })).slice(0, -1) + `,"pad":"${'x'.repeat(3 * 1024 * 1024)}"}`) }));
  add('manifest-skill-no-entry', 'any', 'payload.entry names a missing file', validSkill({ manifest: manifestFor('skill', flist, { payload: { name: 'demo-skill', entry: 'NOPE.md' } }) }));

  // counts and sizes
  const many = (k: number): Files => [...S(), ...Array.from({ length: k }, (_, i): [string, Uint8Array] => [`references/f${i}.md`, tb(`f${i}\n`)])];
  add('count-skill-50-files', 'any', '50 body files plus the manifest (readers count the manifest differently)', validSkill({}, many(47)));
  add('count-skill-49-files', 'any', '49 body files plus the manifest', validSkill({}, many(46)));
  add('count-skill-51-files', 'reject', '51 body files, over the skill cap of 50', validSkill({}, many(48)));
  add('count-skill-52-files', 'reject', '52 body files', validSkill({}, many(49)));
  add('count-skill-300-files', 'reject', '300 files in a skill', validSkill({}, many(297)));
  add('count-template-200-files', 'any', '200 body files in a template', validSkill({ type: 'template' }, [...T(), ...Array.from({ length: 198 }, (_, i): [string, Uint8Array] => [`assets/f${i}.txt`, tb(`${i}\n`)])]));
  add('count-template-201-files', 'reject', '201 body files in a template', validSkill({ type: 'template' }, [...T(), ...Array.from({ length: 199 }, (_, i): [string, Uint8Array] => [`assets/f${i}.txt`, tb(`${i}\n`)])]));
  add('count-1001-entries', 'reject', '1001 entries', validSkill({}, many(998)));

  // size bombs (compressed payloads are tiny; nothing here is large on disk)
  const zeros = (n: number) => new Uint8Array(n);
  const MiB = 1024 * 1024;
  add('size-total-64mib-plus1', 'reject', 'one deflated file of 64 MiB + 1 byte', validSkill({ method: 8 }, [...S(), ['references/big.md', zeros(64 * MiB + 1)]]));
  add('size-total-over-two-files', 'reject', 'two deflated files of 33 MiB each', validSkill({ method: 8 }, [...S(), ['references/b1.md', zeros(33 * MiB)], ['references/b2.md', zeros(33 * MiB)]]));
  add('size-ratio-bomb-6mib', 'any', 'a 6 MiB file of zeros deflated (ratio about 1000)', validSkill({ method: 8 }, [...S(), ['references/zeros.md', zeros(6 * MiB)]]));
  add('size-lying-small-declared', 'reject', 'declares 10 bytes, inflates to 2 MiB', buildZip(pkgEnts(S(), { method: 8 }).map((e) => (e.name === R ? { ...e, raw: deflateRawSync(zeros(2 * MiB)), usize: 10 } : e))));
  add('size-declared-huge-small-data', 'reject', 'declares 0x7fffffff bytes with 12 bytes of data', only(R, { usize: 0x7fffffff, method: 8, raw: deflateRawSync(Rd) }));
  add('size-declared-sum-overflow', 'reject', 'declared sizes that overflow a 32-bit sum', buildZip(pkgEnts(S(), { method: 8 }).map((e) => ({ ...e, usize: 0xfffffff0 }))));
  add('size-dir-entry-with-data', 'any', 'a directory entry that carries data', buildZip([...pkgEnts(S()), { name: 'references/d/', data: tb('hidden payload'), mode: 0o040755 }]));
  add('size-dir-entry-huge-declared', 'any', 'a directory entry declaring 100 MiB', buildZip([...pkgEnts(S()), { name: 'references/d/', data: new Uint8Array(0), usize: 100 * MiB, mode: 0o040755 }]));
  add('name-empty-listed-dir', 'reject', 'an entry named "/" only', buildZip([...pkgEnts(S()), { name: '/', data: new Uint8Array(0), mode: 0o040755 }]));
  return cs;
}

// ---------------------------------------------------------------- seeded mutations

const FIELD_VALUES = (natural: number) => [0, 1, natural + 1, Math.max(0, natural - 1), 0xffff, 0xffffffff, 0x7fffffff, 0x80000000];
type R = ReturnType<typeof rng>;

function mutations(r: R, count: number): FuzzCase[] {
  const out: FuzzCase[] = [];
  const bases = [
    { label: 'skill-stored', ents: pkgEnts(baseSkillFiles()), type: 'skill' },
    { label: 'skill-deflate', ents: pkgEnts(baseSkillFiles(), { method: 8 }), type: 'skill' },
    { label: 'template', ents: pkgEnts(baseTemplateFiles(), { type: 'template' }), type: 'template' },
  ];
  const names = NASTY_NAMES.map(([, n]) => n).filter((x) => x !== '');
  for (let i = 0; i < count; i++) {
    const b = r.pick(bases), op = r.int(7);
    let ents = b.ents.map((e) => ({ ...e })), o: ZipOpts = {}, cls = '', note = '';
    const idx = 1 + r.int(ents.length - 1);
    if (op === 0 || op === 1) {                         // byte flips in a region of the built archive
      const { bytes: bb, layout } = buildZipLayout(ents);
      const regions: [string, [number, number]][] = [['local', layout.locals[r.int(layout.locals.length)]], ['cd', layout.cd], ['eocd', layout.eocd]];
      const [region, [s, e]] = r.pick(regions); const m = new Uint8Array(bb);
      const flips = 1 + r.int(3);
      for (let k = 0; k < flips; k++) m[s + r.int(Math.max(1, e - s))] ^= 1 << r.int(8);
      cls = `mut-flip-${region}`; note = `${flips} bit flip(s) in the ${region} region of ${b.label}`;
      out.push({ id: `m-${String(i).padStart(5, '0')}-${cls}`, cls, expect: 'any', note, bytes: m }); continue;
    }
    if (op === 2) {                                     // truncation
      const bb = buildZip(ents); const cut = r.int(4) === 0 ? bb.length - 1 - r.int(30) : r.int(bb.length);
      cls = 'mut-trunc'; note = `truncated ${b.label} to ${cut} of ${bb.length} bytes`;
      out.push({ id: `m-${String(i).padStart(5, '0')}-${cls}`, cls, expect: cut >= bb.length ? 'any' : 'reject', note, bytes: bb.subarray(0, cut) }); continue;
    }
    if (op === 3) {                                     // nasty name, listed in the manifest or central-only
      const name = r.pick(names), listed = r.int(2) === 0;
      const files = ents.slice(1).map((e) => [e.name as string, e.data] as [string, Uint8Array]); files[r.int(files.length)][0] = name;
      ents = listed ? pkgEnts(files, { type: b.type as 'skill' | 'template', method: b.label === 'skill-deflate' ? 8 : 0 }) : ents.map((e, k) => (k === idx ? { ...e, name } : e));
      cls = 'mut-name'; note = `name ${JSON.stringify(name)} ${listed ? 'listed' : 'central-only'} in ${b.label}`;
      out.push({ id: `m-${String(i).padStart(5, '0')}-${cls}`, cls, expect: 'reject', note, bytes: buildZip(ents) }); continue;
    }
    if (op === 4 || op === 5) {                         // header field edits, central or local
      const f = r.pick(['crc', 'usize', 'csize', 'method', 'flags', 'lho', 'nameLen', 'mode', 'made'] as const), side = r.pick(['c', 'l', 'c'] as const);
      const nat = f === 'crc' ? crc32(ents[idx].data) : f === 'usize' || f === 'csize' ? ents[idx].data.length : 1;
      const v = r.pick(FIELD_VALUES(nat));
      const e = ents[idx];
      if (f === 'crc') side === 'c' ? (e.crc = v) : (e.lcrc = v);
      else if (f === 'usize') side === 'c' ? (e.usize = v) : (e.lusize = v);
      else if (f === 'csize') side === 'c' ? (e.csize = v) : (e.lcsize = v);
      else if (f === 'method') e.method = r.pick([0, 8, 1, 9, 12, 14, 99]);
      else if (f === 'flags') side === 'c' ? (e.flags = r.pick([0, 1, 8, 0x800, 0x809, 0x40, 0x41, 0x2000])) : (e.lflags = r.pick([0, 1, 8, 0x800, 0x809]));
      else if (f === 'lho') e.lho = v;
      else if (f === 'nameLen') e.nameLen = v & 0xff;
      else if (f === 'mode') e.mode = r.pick([0o120777, 0o040755, 0o010644, 0o100755, 0o100000, 0o177777]);
      else e.made = r.pick([0, 20, 0x0314, 0x0a14, 0x1914]);
      cls = `mut-field-${f}-${side}`; note = `${f} (${side === 'c' ? 'central' : 'local'}) of entry ${idx} set to ${v} in ${b.label}`;
      out.push({ id: `m-${String(i).padStart(5, '0')}-${cls}`, cls, expect: 'any', note, bytes: buildZip(ents) }); continue;
    }
    {                                                   // EOCD / structure edits
      const f = r.pick(['count', 'total', 'cdSize', 'cdOff', 'disk', 'cdDisk', 'commentLen', 'comment', 'prefix', 'suffix', 'zip64'] as const), n = ents.length;
      const v = r.pick(FIELD_VALUES(n));
      if (f === 'count') o.count = v & 0xffff; else if (f === 'total') o.total = v & 0xffff;
      else if (f === 'cdSize') o.cdSize = v; else if (f === 'cdOff') o.cdOff = v;
      else if (f === 'disk') o.disk = 1 + r.int(3); else if (f === 'cdDisk') o.cdDisk = 1 + r.int(3);
      else if (f === 'commentLen') { o.comment = tb('xyz'); o.commentLen = r.pick([0, 1, 2, 4, 0xffff]); }
      else if (f === 'comment') o.comment = tb('PK\x05\x06' + 'z'.repeat(r.int(40)));
      else if (f === 'prefix') { o.prefix = tb('X'.repeat(1 + r.int(40))); o.prefixAdjust = r.int(2) === 0; }
      else if (f === 'suffix') o.suffix = tb('S'.repeat(1 + r.int(40)));
      else o.zip64 = 'locator-only';
      cls = `mut-eocd-${f}`; note = `${f} edited in ${b.label}`;
      out.push({ id: `m-${String(i).padStart(5, '0')}-${cls}`, cls, expect: 'any', note, bytes: buildZip(ents, o) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- public API

export const DEFAULT_SEED = 0x5eed2026;
export function generateCorpus(seed = DEFAULT_SEED, iters = 400): FuzzCase[] {
  const cases = [...hand(), ...mutations(rng(seed), iters)];
  const ids = new Set<string>();
  for (const c of cases) { if (ids.has(c.id)) throw new Error(`duplicate corpus id ${c.id}`); ids.add(c.id); }
  return cases;
}

/** Writes <dir>/<id>.zip and <dir>/manifest.json (the expectations manifest). Returns the manifest. */
export function writeCorpus(dir: string, cases: FuzzCase[], meta: Record<string, unknown> = {}) {
  mkdirSync(dir, { recursive: true });
  for (const c of cases) writeFileSync(join(dir, `${c.id}.zip`), c.bytes);
  const manifest = { generator: 'zipfuzz.ts', ...meta, count: cases.length, cases: cases.map((c) => ({ id: c.id, cls: c.cls, expect: c.expect, note: c.note, bytes: c.bytes.length, sha256: sha256(c.bytes) })) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}
