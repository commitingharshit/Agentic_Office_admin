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
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
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
export function parseXml(bytes: Uint8Array, onTag?: (name: string, attrs: Map<string, string>) => void): void {
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
      const attrs = new Map<string, string>();
      for (;;) {
        const before = i;
        skipWs();
        if (s[i] === '>' || s.startsWith('/>', i)) break;
        if (i === before) throw new XmlError(`malformed start tag <${name}`);
        const an = readName();
        if (attrs.has(an)) throw new XmlError(`duplicate attribute ${an} on <${name}>`);
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
        attrs.set(an, v.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, r: string) => ENT[r] ?? (r[1] === 'x' ? String.fromCodePoint(parseInt(r.slice(2), 16)) : String.fromCodePoint(parseInt(r.slice(1), 10)))));
        i = e + 1;
      }
      if (stack.length === 0) { if (roots++ > 0) throw new XmlError('more than one root element'); }
      onTag?.(name, attrs);
      if (s[i] === '/') { i += 2; } else { i++; stack.push(name); }
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1]}>`);
  if (!roots) throw new XmlError('no root element');
}

export const assertWellFormedXml = (bytes: Uint8Array): void => parseXml(bytes);

/** Parses a part through the one tokenizer (UTF-8/UTF-16 aware), collecting start/empty tags. Returns a problem string on failure. */
function readTags(bytes: Uint8Array): { tags: { name: string; attrs: Map<string, string> }[] } | { problem: string } {
  const tags: { name: string; attrs: Map<string, string> }[] = [];
  try { parseXml(bytes, (name, attrs) => tags.push({ name: name.replace(/^.*:/, ''), attrs })); return { tags }; }
  catch (e) { return { problem: e instanceof XmlError ? e.message : String(e) }; }
}
const xmlProblem = (bytes: Uint8Array): string | undefined => {
  const r = readTags(bytes);
  return 'problem' in r ? r.problem : undefined;
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

const ACTIVE_CT = /macroenabled|vbaproject|activex|macrosheet|dialogsheet|\.macro\b|ms-office\.vba/i;
const ACTIVE_REL_TYPE = /\/(oleObject|oleLink|package|vbaProject|activeXControl|activeXControlBinary|macroSheet|dialogSheet)$/i;
const EXTERNAL_OK_TYPE = /\/hyperlink$/i;

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const attrCI = (attrs: Map<string, string>, name: string): string | undefined => {
  for (const [k, v] of attrs) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
};

/** Chart parts reach their data workbook through a `package` relationship; returns those targets (resolved part names). */
function chartPackageTargets(parts: Map<string, Uint8Array>): Set<string> {
  const out = new Set<string>();
  for (const [name, b] of parts) {
    if (!/(^|\/)charts\/_rels\/[^/]+\.rels$/i.test(name)) continue;
    const r = readTags(b);
    if ('problem' in r) continue;
    const base = name.replace(/_rels\/[^/]+$/, '');
    for (const t of r.tags) {
      if (t.name !== 'Relationship' || !/\/package$/i.test(attrCI(t.attrs, 'Type') ?? '')) continue;
      if ((attrCI(t.attrs, 'TargetMode') ?? '').toLowerCase() === 'external') continue;
      const tgt = attrCI(t.attrs, 'Target') ?? '';
      const segs = (tgt.startsWith('/') ? tgt.slice(1) : base + tgt).split('/'), res: string[] = [];
      for (const sg of segs) { if (sg === '..') res.pop(); else if (sg !== '.' && sg !== '') res.push(sg); }
      out.add(res.join('/'));
    }
  }
  return out;
}

/** Everything that makes a package carry executable / remote content. Parsed with the real tokenizer only; undecodable => fail closed. */
function scanActive(parts: Map<string, Uint8Array>, depth: number): string[] {
  const act: string[] = [];
  const chartPackages = depth === 0 ? chartPackageTargets(parts) : new Set<string>();
  const ct = parts.get('[Content_Types].xml');
  if (ct) {
    const r = readTags(ct);
    if ('problem' in r) act.push(`[Content_Types].xml cannot be inspected: ${r.problem}`);
    else for (const t of r.tags) {
      if (t.name !== 'Override' && t.name !== 'Default') continue;
      const c = attrCI(t.attrs, 'ContentType') ?? '';
      if (ACTIVE_CT.test(c)) act.push(`macro/ActiveX content type ${q(c)}`);
    }
  }
  for (const name of parts.keys()) {
    const n = name.toLowerCase();
    if (/(^|\/)vbaproject(signature)?\.bin$/.test(n) || /(^|\/)vbadata\.xml$/.test(n)) act.push(`macro part ${name}`);
    else if (/(^|\/)(macrosheets|dialogsheets)\//.test(n)) act.push(`Excel 4.0 macro/dialog sheet ${name}`);
    else if (/(^|\/)embeddings\/[^/]*\.(docx|xlsx|pptx)$/.test(n) && chartPackages.has(name)) {
      // A chart's data workbook (reached only via a chart part's `package` relationship) is legitimate; it is scanned
      // recursively (one level) and must itself be free of active content.
      let inner: Map<string, Uint8Array> | undefined;
      try { inner = readZipFiles(parts.get(name)!, { maxTotal: MAX_TEMPLATE_UNCOMPRESSED }); } catch { act.push(`embedded package ${name} is not a readable zip`); }
      if (inner) for (const a of scanActive(inner, 1)) act.push(`${name}: ${a}`);
    }
    else if (/(^|\/)embeddings\/[^/]*\.(bin|ole|docm|xlsm|pptm|docx|xlsx|pptx|dotm|xltm|potm)$/.test(n) || /(^|\/)oleobject[^/]*\.bin$/.test(n)) act.push(`embedded OLE/package ${name}`);
    else if (/(^|\/)activex\//.test(n)) act.push(`ActiveX part ${name}`);
  }
  for (const [name, b] of parts) {
    if (!name.toLowerCase().endsWith('.rels')) continue;
    const r = readTags(b);
    if ('problem' in r) { act.push(`${name} cannot be inspected: ${r.problem}`); continue; }
    for (const t of r.tags) {
      if (t.name !== 'Relationship') continue;
      const target = (attrCI(t.attrs, 'Target') ?? '').trim();
      const type = attrCI(t.attrs, 'Type') ?? '';
      const external = (attrCI(t.attrs, 'TargetMode') ?? '').toLowerCase() === 'external';
      const where = `${name} (${q(type.replace(/^.*\//, ''))} -> ${q(target)})`;
      const chartPkg = !external && /\/package$/i.test(type) && /(^|\/)charts\/_rels\//i.test(name);
      if (ACTIVE_REL_TYPE.test(type) && !chartPkg) act.push(`active-content relationship in ${where}`);
      else if (external && !(EXTERNAL_OK_TYPE.test(type) && /^https:\/\//i.test(target))) act.push(`external relationship in ${where}: only https hyperlinks are allowed`);
      else if (!external && (/^(https?|file|ftp):/i.test(target) || /^[\\/]{2}/.test(target) || target.startsWith('\\'))) act.push(`absolute/remote target in ${where}`);
    }
  }
  return act;
}

function ooxmlChecks(format: string, bytes: Uint8Array): { zip: ValidationCheck; active: ValidationCheck } {
  let parts: Map<string, Uint8Array>;
  try { parts = readZipFiles(bytes, { maxTotal: MAX_TEMPLATE_UNCOMPRESSED }); }
  catch (e) {
    const msg = e instanceof UnpackError ? e.message : String(e);
    return { zip: fail('ooxml-zip', `not a valid zip archive: ${msg}`), active: skip('no-active-content', 'the file is not a readable zip') };
  }
  const problems: string[] = [];
  const lower = new Map<string, string>(); // lowercased name -> real name
  for (const name of parts.keys()) {
    const k = name.toLowerCase();
    if (lower.has(k)) problems.push(`part names differ only by case: ${q(lower.get(k)!)} and ${q(name)}`);
    else lower.set(k, name);
  }
  const ctBytes = parts.get('[Content_Types].xml');
  if (!ctBytes) problems.push('missing [Content_Types].xml');
  if (!parts.has('_rels/.rels')) problems.push('missing _rels/.rels');
  const main = MAIN_PART[format];
  if (!parts.has(main)) problems.push(`missing main part ${main}`);
  for (const [name, b] of parts) {
    if (name !== '[Content_Types].xml' && name !== main && !name.toLowerCase().endsWith('.rels')) continue;
    const p = xmlProblem(b);
    if (p) problems.push(`${name} is not well-formed XML: ${p}`);
  }
  if (ctBytes) {
    const r = readTags(ctBytes);
    if (!('problem' in r)) {
      const missing: string[] = [];
      for (const t of r.tags) {
        const pn = t.name === 'Override' ? attrCI(t.attrs, 'PartName') : undefined;
        if (pn && !lower.has(safeDecode(pn).replace(/^\//, '').toLowerCase()) && !lower.has(pn.replace(/^\//, '').toLowerCase())) missing.push(pn);
      }
      if (missing.length) problems.push(`content types name parts that do not exist: ${list(missing)}`);
    }
  }
  const act = scanActive(parts, 0);
  return {
    zip: problems.length ? fail('ooxml-zip', list(problems)) : ok('ooxml-zip'),
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
