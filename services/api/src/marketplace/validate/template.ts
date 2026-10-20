// Template validator (type 'template'). Hand-written checks; every check runs even if an earlier one failed, except
// those that depend on a failed one, which are reported `skipped` with a reason. Must not import ./index.ts (cycle):
// the registry imports this module and registers createTemplateValidator().
import { UnpackError, readZipFiles } from '../artifacts.ts';
import type { UnpackedPackage, ValidationCheck } from '../types.ts';
import type { OfficeRenderer } from './officecli.ts';

export interface TemplateValidatorOptions { officecli?: OfficeRenderer }

const FORMATS = ['docx', 'pptx', 'xlsx', 'pdf'] as const;
type Format = typeof FORMATS[number];
const MAIN_PART: Record<string, string> = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' };
const MAX_PREVIEW = 2 * 1024 * 1024;
const MAX_TEMPLATE_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_LIST = 12; // how many offenders a detail string lists

const ok = (name: string, extra: Partial<ValidationCheck> = {}): ValidationCheck => ({ name, ok: true, ...extra });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const skip = (name: string, why: string): ValidationCheck => ({ name, ok: true, skipped: true, detail: `skipped: ${why}` });
const list = (xs: string[]) => xs.slice(0, MAX_LIST).join('; ') + (xs.length > MAX_LIST ? `; ... and ${xs.length - MAX_LIST} more` : '');
const q = (s: string) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + '...' : s);

// ------------------------------------------------------------------ XML well-formedness

class XmlError extends Error {}
const NAME_START = /[A-Za-z_:À-￿]/, NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;

function decodeXml(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) throw new XmlError('UTF-16BE is not supported');
  const s = new TextDecoder('utf-8', { fatal: true }).decode(b);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * A small non-validating well-formedness checker: balanced tags, a single root, quoted unique attributes, legal
 * references. It does NO entity or DTD processing at all: any DOCTYPE is rejected (OOXML parts never carry one), so
 * no entity can ever be expanded. Throws XmlError with a short reason.
 */
export function assertWellFormedXml(bytes: Uint8Array): void {
  let s: string;
  try { s = decodeXml(bytes); } catch (e) { throw e instanceof XmlError ? e : new XmlError('not valid UTF-8/UTF-16 text'); }
  const n = s.length;
  let i = 0, roots = 0;
  const stack: string[] = [];
  const readName = (): string => {
    const st = i;
    if (i >= n || !NAME_START.test(s[i])) throw new XmlError(`invalid name at offset ${i}`);
    while (i < n && NAME_CHAR.test(s[i])) i++;
    return s.slice(st, i);
  };
  const skipWs = () => { while (i < n && /[ \t\r\n]/.test(s[i])) i++; };
  const checkText = (t: string) => {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)) throw new XmlError('illegal control character');
    for (const m of t.matchAll(/&([^;&<\s]*)(;?)/g)) {
      if (m[2] !== ';' || !/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(m[1])) throw new XmlError(`illegal or unknown entity reference &${m[1]}`);
    }
    if (/&(?![^;&<\s]*;)/.test(t)) throw new XmlError('bare & in text');
  };
  if (s.startsWith('<?xml')) {
    const e = s.indexOf('?>');
    if (e < 0) throw new XmlError('unterminated XML declaration');
    i = e + 2;
  }
  while (i < n) {
    if (s[i] !== '<') {
      const e = s.indexOf('<', i), t = s.slice(i, e < 0 ? n : e);
      if (stack.length === 0 && t.trim() !== '') throw new XmlError(roots ? 'content after the root element' : 'text before the root element');
      checkText(t);
      i = e < 0 ? n : e;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      if (e < 0) throw new XmlError('unterminated comment');
      if (s.slice(i + 4, e).includes('--')) throw new XmlError('"--" inside a comment');
      i = e + 3;
    } else if (s.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) throw new XmlError('CDATA outside the root element');
      const e = s.indexOf(']]>', i);
      if (e < 0) throw new XmlError('unterminated CDATA');
      i = e + 3;
    } else if (s.startsWith('<?', i)) {
      const e = s.indexOf('?>', i);
      if (e < 0) throw new XmlError('unterminated processing instruction');
      i = e + 2;
    } else if (s.startsWith('<!', i)) {
      throw new XmlError(/<!DOCTYPE/i.test(s.slice(i, i + 9)) ? 'DOCTYPE/DTD is not allowed (no entity processing)' : 'unsupported markup declaration');
    } else if (s.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipWs();
      if (s[i] !== '>') throw new XmlError(`malformed end tag </${name}`);
      i++;
      if (stack.pop() !== name) throw new XmlError(`mismatched end tag </${name}>`);
    } else {
      i++;
      const name = readName();
      const seen = new Set<string>();
      for (;;) {
        const before = i;
        skipWs();
        if (s[i] === '>' || s.startsWith('/>', i)) break;
        if (i === before) throw new XmlError(`malformed start tag <${name}`);
        const an = readName();
        if (seen.has(an)) throw new XmlError(`duplicate attribute ${an} on <${name}>`);
        seen.add(an);
        skipWs();
        if (s[i++] !== '=') throw new XmlError(`attribute ${an} has no value`);
        skipWs();
        const quote = s[i++];
        if (quote !== '"' && quote !== "'") throw new XmlError(`attribute ${an} is not quoted`);
        const e = s.indexOf(quote, i);
        if (e < 0) throw new XmlError('unterminated attribute value');
        const v = s.slice(i, e);
        if (v.includes('<')) throw new XmlError(`"<" in attribute ${an}`);
        checkText(v);
        i = e + 1;
      }
      if (stack.length === 0) { if (roots++ > 0) throw new XmlError('more than one root element'); }
      if (s[i] === '/') { i += 2; } else { i++; stack.push(name); }
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1]}>`);
  if (!roots) throw new XmlError('no root element');
}

const xmlProblem = (bytes: Uint8Array): string | undefined => {
  try { assertWellFormedXml(bytes); return undefined; } catch (e) { return e instanceof XmlError ? e.message : String(e); }
};

// ------------------------------------------------------------------ checks

function payloadShape(p: Record<string, unknown>): { check: ValidationCheck; format?: Format; file?: string; previews?: string[] } {
  const bad: string[] = [];
  const known = new Set(['format', 'file', 'previews']);
  for (const k of Object.keys(p)) if (!known.has(k)) bad.push(`payload.${k}: unknown field`);
  if (typeof p.format !== 'string' || !(FORMATS as readonly string[]).includes(p.format)) bad.push(`payload.format: must be one of ${FORMATS.join(', ')}`);
  if (typeof p.file !== 'string' || p.file === '') bad.push('payload.file: must be a non-empty string');
  const pv = p.previews;
  if (!Array.isArray(pv) || pv.length < 1 || pv.length > 20 || !pv.every((x) => typeof x === 'string' && x !== '')) bad.push('payload.previews: must be an array of 1..20 non-empty path strings');
  else if (new Set(pv).size !== pv.length) bad.push('payload.previews: duplicate path');
  if (bad.length) return { check: fail('payload-shape', bad.join('; ')) };
  return { check: ok('payload-shape'), format: p.format as Format, file: p.file as string, previews: pv as string[] };
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)?.slice(1).find((x) => x !== undefined);
const tags = (xml: string, el: string): string[] => [...xml.matchAll(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${el}\\b[^>]*>`, 'g'))].map((m) => m[0]);
const dec = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

function ooxmlChecks(format: string, bytes: Uint8Array): { zip: ValidationCheck; active: ValidationCheck } {
  let parts: Map<string, Uint8Array>;
  try { parts = readZipFiles(bytes, { maxTotal: MAX_TEMPLATE_UNCOMPRESSED }); }
  catch (e) {
    const msg = e instanceof UnpackError ? e.message : String(e);
    return { zip: fail('ooxml-zip', `not a valid zip archive: ${msg}`), active: skip('no-active-content', 'the file is not a readable zip') };
  }
  const problems: string[] = [];
  const ct = parts.get('[Content_Types].xml');
  if (!ct) problems.push('missing [Content_Types].xml');
  if (!parts.has('_rels/.rels')) problems.push('missing _rels/.rels');
  const main = MAIN_PART[format];
  if (!parts.has(main)) problems.push(`missing main part ${main}`);
  const contentTypes = ct ? dec(ct) : '';
  if (ct) {
    const missing: string[] = [];
    for (const t of tags(contentTypes, 'Override')) {
      const pn = attr(t, 'PartName');
      if (pn && !parts.has(pn.replace(/^\//, ''))) missing.push(pn);
    }
    if (missing.length) problems.push(`content types name parts that do not exist: ${list(missing)}`);
  }
  for (const name of ['[Content_Types].xml', '_rels/.rels', main]) {
    const b = parts.get(name);
    const p = b && xmlProblem(b);
    if (p) problems.push(`${name} is not well-formed XML: ${p}`);
  }

  const act: string[] = [];
  for (const name of parts.keys()) {
    if (/(^|\/)vbaProject(Signature)?\.bin$/i.test(name) || /(^|\/)vbaData\.xml$/i.test(name)) act.push(`macro part ${name}`);
    else if (/(^|\/)embeddings\/[^/]+\.bin$/i.test(name) || /(^|\/)oleObject[^/]*\.bin$/i.test(name)) act.push(`embedded OLE binary ${name}`);
    else if (/(^|\/)activeX\//i.test(name)) act.push(`ActiveX part ${name}`);
  }
  for (const t of tags(contentTypes, 'Override').concat(tags(contentTypes, 'Default'))) {
    const c = attr(t, 'ContentType') ?? '';
    if (/macroEnabled|vbaProject|activex/i.test(c)) act.push(`macro/ActiveX content type ${c}`);
  }
  for (const [name, b] of parts) {
    if (!name.endsWith('.rels')) continue;
    for (const t of tags(dec(b), 'Relationship')) {
      if (attr(t, 'TargetMode')?.toLowerCase() !== 'external') continue;
      const target = attr(t, 'Target') ?? '';
      if (!/^https:\/\//i.test(target)) act.push(`external relationship in ${name} to ${q(target)} (only https:// is allowed)`);
    }
  }
  return {
    zip: problems.length ? fail('ooxml-zip', problems.join('; ')) : ok('ooxml-zip'),
    active: act.length ? fail('no-active-content', list(act)) : ok('no-active-content'),
  };
}

/**
 * HEURISTIC, deliberately conservative byte scan: it sees only names present as plain (or #xx-escaped) tokens in the
 * file body. Dictionaries hidden inside compressed object streams are NOT inspected, so this is a tripwire, not proof.
 */
function pdfCheck(b: Uint8Array): ValidationCheck {
  const problems: string[] = [];
  const head = new TextDecoder('latin1').decode(b.subarray(0, 8));
  if (!/^%PDF-[12]\./.test(head)) problems.push('does not start with %PDF-1. or %PDF-2.');
  const tail = new TextDecoder('latin1').decode(b.subarray(Math.max(0, b.length - 1024)));
  if (!tail.includes('%%EOF')) problems.push('no %%EOF in the last 1 KiB (truncated?)');
  const body = new TextDecoder('latin1').decode(b).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  for (const [re, label] of [[/\/JavaScript\b/, '/JavaScript'], [/\/JS\b/, '/JS'], [/\/Launch\b/, '/Launch']] as const)
    if (re.test(body)) problems.push(`contains ${label} (executable content is not allowed)`);
  return problems.length ? fail('pdf-header', problems.join('; ')) : ok('pdf-header');
}

function previewCheck(pkg: UnpackedPackage, paths: string[]): ValidationCheck {
  const bad: string[] = [];
  for (const p of paths) {
    const b = pkg.files.get(p);
    if (!b) { bad.push(`${q(p)}: not in the package`); continue; }
    if (b.length > MAX_PREVIEW) { bad.push(`${q(p)}: ${b.length} bytes is over the ${MAX_PREVIEW} byte cap`); continue; }
    const png = b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const jpg = b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (!png && !jpg) bad.push(`${q(p)}: not a PNG or JPEG (magic bytes)`);
  }
  return bad.length ? fail('preview-images', bad.join('; ')) : ok('preview-images');
}

export function createTemplateValidator(opts: TemplateValidatorOptions = {}) {
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const checks: ValidationCheck[] = [];
    const shape = payloadShape(pkg.manifest.payload as Record<string, unknown>);
    checks.push(shape.check);
    if (!shape.format) {
      checks.push(skip('file-present', 'payload-shape failed'), skip('ooxml-zip', 'payload-shape failed'), skip('no-active-content', 'payload-shape failed'),
        skip('preview-images', 'payload-shape failed'), skip('officecli-open', 'payload-shape failed'));
      return checks;
    }
    const { format, file, previews } = shape as { format: Format; file: string; previews: string[] };
    const bytes = pkg.files.get(file);
    checks.push(bytes ? ok('file-present') : fail('file-present', `payload.file ${q(file)} is not in the package`));

    let structural: boolean;
    if (!bytes) {
      checks.push(skip(format === 'pdf' ? 'pdf-header' : 'ooxml-zip', 'file-present failed'));
      if (format !== 'pdf') checks.push(skip('no-active-content', 'file-present failed'));
      structural = false;
    } else if (format === 'pdf') {
      const c = pdfCheck(bytes); checks.push(c); structural = c.ok;
    } else {
      const r = ooxmlChecks(format, bytes); checks.push(r.zip, r.active); structural = r.zip.ok && r.active.ok && !r.active.skipped;
    }

    checks.push(previewCheck(pkg, previews));

    if (!structural || !bytes) checks.push(skip('officecli-open', 'the file failed an earlier structural check'));
    else if (!opts.officecli) checks.push(skip('officecli-open', 'no renderer configured'));
    else {
      let r: { ok: boolean; detail?: string };
      try { r = await opts.officecli(bytes, format); } catch (e) { r = { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
      checks.push(r.ok ? ok('officecli-open') : fail('officecli-open', r.detail ?? 'officecli could not open or render page 1'));
    }
    return checks;
  };
}
