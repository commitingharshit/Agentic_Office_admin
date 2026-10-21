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
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types', NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAIN_CT: Record<string, RegExp> = { docx: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.(document|template)\.main\+xml$/, pptx: /^application\/vnd\.openxmlformats-officedocument\.presentationml\.(presentation|template|slideshow)\.main\+xml$/, xlsx: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.(sheet|template)\.main\+xml$/ };
const MAX_PREVIEW = 2 * 1024 * 1024;
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
export interface XmlHooks { text?: (element: string, text: string) => void; pi?: (target: string, data: string) => void; deadline?: number }
const MAX_XML_DEPTH = 256;
export function parseXml(bytes: Uint8Array, onTag?: (name: string, attrs: Map<string, string>) => void, hooks: XmlHooks = {}): void {
  let s: string;
  try { s = decodeXml(bytes); } catch (e) { throw e instanceof XmlError ? e : new XmlError('not valid UTF-8/UTF-16 text'); }
  const n = s.length;
  let i = 0, roots = 0;
  const stack: string[] = [];
  let ticks = 0;
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
  if (/^<\?xml[ \t\r\n]/.test(s)) {
    const e = s.indexOf('?>');
    if (e < 0) throw new XmlError('unterminated XML declaration');
    const enc = /encoding\s*=\s*["']([^"']*)["']/i.exec(s.slice(0, e))?.[1];
    if (enc !== undefined && !/^utf-(8|16)$/i.test(enc)) throw new XmlError(`unsupported encoding "${enc}" in the XML declaration`);
    i = e + 2;
  }
  while (i < n) {
    if ((++ticks & 1023) === 0 && hooks.deadline !== undefined && Date.now() > hooks.deadline) throw new XmlError('time budget exceeded while parsing');
    if (s[i] !== '<') {
      const e = s.indexOf('<', i), t = s.slice(i, e < 0 ? n : e);
      if (stack.length === 0 && t.trim() !== '') throw new XmlError(roots ? 'content after the root element' : 'text before the root element');
      checkText(t);
      if (stack.length && hooks.text) hooks.text(stack[stack.length - 1], t.replace(/&(amp|lt|gt|quot|apos);/g, (_, r: string) => ENT[r]));
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
      if (hooks.text) hooks.text(stack[stack.length - 1], s.slice(i + 9, e));
      i = e + 3;
    } else if (s.startsWith('<?', i)) {
      const e = s.indexOf('?>', i);
      if (e < 0) throw new XmlError('unterminated processing instruction');
      if (hooks.pi) { const body = s.slice(i + 2, e), m = /^(\S+)\s*([\s\S]*)$/.exec(body); if (m) hooks.pi(m[1], m[2]); }
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
      const seenLower = new Set<string>();
      for (;;) {
        const before = i;
        skipWs();
        if (s[i] === '>' || s.startsWith('/>', i)) break;
        if (i === before) throw new XmlError(`malformed start tag <${name}`);
        const an = readName();
        if (attrs.has(an)) throw new XmlError(`duplicate attribute ${an} on <${name}>`);
        if (seenLower.has(an.toLowerCase())) throw new XmlError(`attributes on <${name}> collide case-insensitively: ${an}`);
        seenLower.add(an.toLowerCase());
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
        const decoded = v.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, r: string) => {
          if (ENT[r] !== undefined) return ENT[r];
          const cp = r[1] === 'x' ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10);
          if (!Number.isInteger(cp) || cp > 0x10ffff || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0xd800 && cp <= 0xdfff)) throw new XmlError(`illegal character reference &${r};`);
          return String.fromCodePoint(cp);
        });
        attrs.set(an, decoded);
        i = e + 1;
      }
      if (stack.length === 0) { if (roots++ > 0) throw new XmlError('more than one root element'); }
      onTag?.(name, attrs);
      if (s[i] === '/') { i += 2; } else { i++; stack.push(name); if (stack.length > MAX_XML_DEPTH) throw new XmlError(`nesting deeper than ${MAX_XML_DEPTH} levels`); }
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1]}>`);
  if (!roots) throw new XmlError('no root element');
}

export const assertWellFormedXml = (bytes: Uint8Array): void => parseXml(bytes);

/** Parses a part through the one tokenizer (UTF-8/UTF-16 aware), collecting start/empty tags, optionally element text and PIs. */
interface Scanned { tags: { name: string; attrs: Map<string, string> }[]; texts: { el: string; text: string }[]; pis: { target: string; data: string }[] }
function readTags(bytes: Uint8Array, collect = false): Scanned | { problem: string } {
  const out: Scanned = { tags: [], texts: [], pis: [] };
  try {
    parseXml(bytes, (name, attrs) => out.tags.push({ name: name.replace(/^.*:/, ''), attrs }), collect ? { text: (el, text) => out.texts.push({ el: el.replace(/^.*:/, ''), text }), pi: (target, data) => out.pis.push({ target, data }) } : { pi: (target, data) => out.pis.push({ target, data }) });
    return out;
  } catch (e) { return { problem: e instanceof XmlError ? e.message : String(e) }; }
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

const ACTIVE_CT = /macroenabled|vbaproject|activex|macrosheet|dialogsheet|\.macro\b|ms-office\.vba|webextension|svg\+xml|spreadsheetml\.(connections|externallink|querytable)|customui|controlproperties|attachedtemplate/i;

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** OPC consumers read exact-case attribute names; the tokenizer already rejects case-colliding duplicates. */
const attrCI = (attrs: Map<string, string>, name: string): string | undefined => attrs.get(name);
/** Relationship type by its last path segment, ignoring a trailing '/' or '#fragment', lowercased. */
const relKind = (type: string): string => type.replace(/[#?].*$/, '').replace(/\/+$/, '').replace(/^.*\//, '').toLowerCase();
const ACTIVE_KINDS = new Set(['oleobject', 'olelink', 'package', 'vbaproject', 'activexcontrol', 'activexcontrolbinary', 'macrosheet', 'dialogsheet']);
const MACRO_EXT = /\.(xlsm|dotm|docm|pptm|xlam|xltm|potm|ppam|sldm)$/i;
const EXEC_MAGIC = (b: Uint8Array) => b.length >= 2 && ((b[0] === 0x4d && b[1] === 0x5a) || (b.length >= 4 && ((b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)
  || (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) || (b[3] === 0xfe && b[2] === 0xed && b[1] === 0xfa && (b[0] === 0xce || b[0] === 0xcf))
  || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe))));
/** Resolved part name, or null when the target climbs above the package root (never clamped: a clamped path would hide the escape). */
function resolvePart(relsName: string, target: string): string | null {
  const base = relsName.replace(/_rels\/[^/]*$/, '');
  const segs = (target.startsWith('/') ? target.slice(1) : base + target).split('/'), res: string[] = [];
  for (const sg of segs) { if (sg === '..') { if (!res.length) return null; res.pop(); } else if (sg !== '.' && sg !== '') res.push(sg); }
  return res.join('/');
}

/** Chart workbooks: resolved targets of a chart part's internal `package` relationship that are a .xlsx/.docx/.pptx directly under embeddings/ and exist in the package. */
function chartPackageTargets(parts: Map<string, Uint8Array>): Set<string> {
  const out = new Set<string>();
  for (const [name, b] of parts) {
    if (!/(^|\/)charts\/_rels\/[^/]+\.rels$/i.test(name)) continue;
    const r = readTags(b);
    if ('problem' in r) continue;
    for (const t of r.tags) {
      if (t.name !== 'Relationship' || relKind(t.attrs.get('Type') ?? '') !== 'package') continue;
      if ((t.attrs.get('TargetMode') ?? '').toLowerCase() === 'external') continue;
      const res = resolvePart(name, (t.attrs.get('Target') ?? '').trim());
      if (res !== null && /(^|\/)embeddings\/[^/]+\.(xlsx|docx|pptx)$/i.test(res) && parts.has(res)) out.add(res);
    }
  }
  return out;
}

/** One budget shared by the outer file and every nested workbook (inflated bytes, nested count, wall clock). */
interface Budget { remaining: number; deadline: number; nested: number }
const MAX_TOTAL_INFLATED = 128 * 1024 * 1024;
const MAX_NESTED = 4;
const VALIDATION_MS = 10_000;
const sumSizes = (m: Map<string, Uint8Array>) => { let t = 0; for (const b of m.values()) t += b.length; return t; };

// Relationship kinds that fetch remote data, attach code/templates, or run something. (`externalLink` etc. have no place in a template.)
const DENY_REL_KINDS = new Set(['webextension', 'connections', 'querytable', 'externallink', 'externallinkpath', 'afchunk',
  'attachedtemplate', 'mailmergesource', 'mailmergeheadersource', 'datasource', 'headersource', 'frame', 'slideupdateinfo', 'slideupdateurl', 'subdocument',
  'control', 'ctrlprop', 'xmlmaps', 'vbaprojectsignature', 'vbaprojectsignatureagile', 'vbaprojectsignaturev3', 'extensibility']);
// Executable, scriptable or markup file extensions. SVG is rejected: it is an active format (script, external references) and templates ship raster media only.
const SCRIPT_EXT = /\.(hta|sh|bat|cmd|ps1|vbs|vbe|jse|js|jar|lnk|svg|svgz|html?|xhtml|mhtml?|wsf|wsh|sct|scr|exe|dll|com|pif|msi|reg|jnlp|url|swf|xsl|xslt|chm|iqy|slk|php|py|rb|pl|app|dmg|so|dylib)$/i;
// Part locations that only exist to reach out (data connections, external workbooks, ribbon callbacks, web add-ins).
const DENY_PART = /^xl\/(connections\.xml|externallinks\/|querytables\/|ctrlprops\/)|(^|\/)(customui|webextensions?)\//;
// Field instructions (first word) that include remote or external content, run a command or a macro.
const FIELD_DENY = new Set(['DDE', 'DDEAUTO', 'INCLUDETEXT', 'INCLUDEPICTURE', 'IMPORT', 'LINK', 'MACROBUTTON', 'DATABASE', 'ADDIN', 'RD']);
const FORMULA_BAD = /^\s*=?\s*[+\-@]?\s*(cmd|powershell|mshta|wscript|cscript|msexcel|excel)\s*\||(^|[^A-Za-z0-9_.])DDE(AUTO)?\s*\(|^\s*=?\s*DDE(AUTO)?\b|\|\s*['"!]/i;
const FORMULA_EL = new Set(['f', 'formula', 'formula1', 'formula2', 'definedname', 'calculatedcolumnformula', 'totalsrowformula']);
const DENY_ELEMENT = new Set(['script', 'svg', 'foreignobject', 'iframe', 'svgblip', 'ddelink', 'dde', 'externalreference', 'webextension']);
const URL_ATTR = new Set(['href', 'src']);
const MAX_XML_PART = 32 * 1024 * 1024; // largest real XML part seen in the repo templates is ~0.9 MB (styles); 32 MiB is a hard cap, not a target
const PART_MS = 5_000;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.\-]*:/;
const stripInvisible = (s: string) => s.replace(/[\p{Cc}\p{Cf}\s]/gu, '');

/** Percent-decoded (up to three rounds, so %252e is seen) and NFKC-folded form of a part name: what a lenient consumer may resolve it to. */
function foldName(name: string): string {
  let cur = name;
  for (let i = 0; i < 3; i++) { const d = safeDecode(cur); if (d === cur) break; cur = d; }
  return cur.normalize('NFKC');
}
/** Identity of a part for collision and lookup: folded, lowercased, trailing dots/spaces of each segment dropped. */
const nameKey = (name: string): string => foldName(name).toLowerCase().split('/').map((s) => s.replace(/[. ]+$/, '')).join('/');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/, INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
function nameProblem(name: string): string | undefined {
  if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.split('/').includes('.')) return 'unsafe part name';
  const f = foldName(name);
  if (CONTROL.test(name) || CONTROL.test(f)) return 'control character in the part name';
  if (INVISIBLE.test(name)) return 'invisible or bidi-control character in the part name';
  if (name.split('/').some((sg) => /[. ]$/.test(sg))) return 'a path segment ends in a dot or space (stripped by Windows)';
  if (f.includes('\\') || f.includes(':') || name.includes(':')) return 'backslash or colon (encoded or compatibility form) in the part name';
  const segs = f.split('/');
  if (segs.length !== name.split('/').length || segs.some((sg) => sg === '' || sg === '.' || sg === '..')) return 'encoded or compatibility-form path separator or dot segment';
  return undefined;
}

/** Instruction of one Word field -> a finding, or undefined. First word decides the field type; HYPERLINK may only target https. */
function fieldProblem(instr: string): string | undefined {
  const t = instr.replace(/[\p{Cc}\s]+/gu, ' ').replace(/\p{Cf}/gu, '').trim();
  const m = /^[\s"'(){}=+\-@\\]*([A-Za-z][A-Za-z0-9_.]*)/.exec(t);
  if (!m) return undefined;
  const word = m[1].toUpperCase();
  if (FIELD_DENY.has(word)) return `field ${word} (DDE/include/link/macro/database fields are not allowed)`;
  if (word === 'HYPERLINK') {
    const rest = t.slice(m[0].length).trim();
    let url: string | undefined;
    if (rest.startsWith('"')) url = rest.slice(1).split('"')[0];
    else if (rest && !rest.startsWith('\\')) url = rest.split(/\s/)[0];
    if (url !== undefined) {
      const c = stripInvisible(url);
      if (!(/^https:\/\//i.test(c) || c.startsWith('#'))) return `field HYPERLINK to a non-https target ${q(url)}`;
    }
  }
  return undefined;
}

/** One streaming pass over an XML part: well-formedness plus every active-content rule that applies to any OOXML part. */
function scanXml(name: string, bytes: Uint8Array, budget: Budget): string[] {
  const out: string[] = [];
  if (bytes.length > MAX_XML_PART) return [`XML part ${name} is ${bytes.length} bytes, over the ${MAX_XML_PART} byte cap`];
  const add = (m: string) => { if (out.length < 50) out.push(`${name}: ${m}`); };
  const stack: string[] = [];
  let loose = '', pendingEl = '', pending = '';
  const flush = () => { if (pending && FORMULA_BAD.test(pending)) add(`DDE/command formula ${q(pending)}`); pending = ''; pendingEl = ''; };
  const field = (instr: string) => { const p = fieldProblem(instr); if (p) add(p); };
  const onTag = (tag: string, attrs: Map<string, string>) => {
    flush();
    const local = tag.replace(/^.*:/, '').toLowerCase();
    if (DENY_ELEMENT.has(local)) add(`active or remote element <${tag}>`);
    for (const [k, v] of attrs) {
      const kl = k.replace(/^.*:/, '').toLowerCase();
      if (URL_ATTR.has(kl)) { const c = stripInvisible(v); if (SCHEME.test(c) || c.startsWith('//') || v.includes('\\')) add(`remote or UNC ${k} attribute ${q(v)} on <${tag}>`); }
    }
    if (local === 'fldchar') {
      const t = [...attrs].find(([k]) => /(^|:)fldchartype$/i.test(k))?.[1];
      if (t === 'begin') stack.push('');
      else if (t === 'end') { const i = stack.pop(); if (i !== undefined) field(i); }
    } else if (local === 'fldsimple') {
      field([...attrs].find(([k]) => /(^|:)instr$/i.test(k))?.[1] ?? '');
    }
  };
  const text = (el: string, t: string) => {
    const local = el.replace(/^.*:/, '').toLowerCase();
    if (local === 'instrtext' || local === 'delinstrtext') { if (stack.length) stack[stack.length - 1] += t; else loose += t; }
    else if (FORMULA_EL.has(local)) { if (pendingEl !== local) flush(); pendingEl = local; pending += t; }
  };
  try {
    parseXml(bytes, onTag, { text, pi: (target) => add(`processing instruction <?${target}?> (OOXML parts carry none)`), deadline: Math.min(budget.deadline, Date.now() + PART_MS) });
  } catch (e) { add(`is not well-formed XML: ${e instanceof XmlError ? e.message : String(e)}`); return out; }
  flush();
  for (const i of stack) field(i);
  if (loose) field(loose);
  return out;
}

const MARKUP_HEAD = /^\s*(<\?xml[^>]*\?>\s*)?(<svg\b|<script\b|<html\b|<!doctype\s+html|<\?php)/i;
const looksXml = (bytes: Uint8Array) => (bytes.length >= 5 && bytes[0] === 0x3c && bytes[1] === 0x3f && bytes[2] === 0x78 && bytes[3] === 0x6d && bytes[4] === 0x6c) || (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe);

/** Everything that makes a package carry executable / remote content. Parsed with the real tokenizer only; undecodable => fail closed. */
function scanActive(parts: Map<string, Uint8Array>, depth: number, budget: Budget): string[] {
  const act: string[] = [];
  const chartPackages = depth === 0 ? chartPackageTargets(parts) : new Set<string>();
  const partKeys = new Set<string>();
  for (const k of parts.keys()) partKeys.add(nameKey(k));
  const ctOverride = new Map<string, string>(), ctDefault = new Map<string, string>();
  const ct = parts.get('[Content_Types].xml');
  if (ct) {
    const r = readTags(ct);
    if ('problem' in r) act.push(`[Content_Types].xml cannot be inspected: ${r.problem}`);
    else {
      for (const t of r.tags) {
        if (t.name !== 'Override' && t.name !== 'Default') continue;
        const c = attrCI(t.attrs, 'ContentType') ?? '';
        if (ACTIVE_CT.test(c)) act.push(`macro/ActiveX/remote content type ${q(c)}`);
        if (t.name === 'Override') ctOverride.set(nameKey((attrCI(t.attrs, 'PartName') ?? '').replace(/^\//, '')), c);
        else ctDefault.set((attrCI(t.attrs, 'Extension') ?? '').toLowerCase(), c);
      }
    }
  }
  const xmlCt = (c: string | undefined) => !!c && /(\+xml|\/xml)$/i.test(c.split(';')[0].trim());
  for (const [name, bytes] of parts) {
    if (Date.now() > budget.deadline) { act.push('validation time budget exceeded'); return act; }
    const np = nameProblem(name);
    if (np) act.push(`${np}: ${q(name)}`);
    const n = nameKey(name);
    if (/(^|\/)vbaproject(signature)?\.bin$/.test(n) || /(^|\/)vbadata\.xml$/.test(n)) act.push(`macro part ${name}`);
    else if (/(^|\/)(macrosheets|dialogsheets)\//.test(n)) act.push(`Excel 4.0 macro/dialog sheet ${name}`);
    else if (DENY_PART.test(n)) act.push(`remote-data / ribbon-callback / web-add-in part ${name}`);
    else if (chartPackages.has(name)) {
      // A chart's data workbook (reached only via a chart part's `package` relationship) is legitimate; it is scanned
      // recursively (one level) under the SAME shared budget and must itself be free of active content.
      if (budget.nested >= MAX_NESTED) { act.push(`more than ${MAX_NESTED} embedded workbooks (${name})`); continue; }
      budget.nested++;
      let inner: Map<string, Uint8Array> | undefined;
      try {
        inner = readZipFiles(bytes, { maxTotal: budget.remaining, deadline: budget.deadline });
        budget.remaining -= sumSizes(inner);
      } catch (e) { act.push(`embedded package ${name} cannot be read within budget: ${e instanceof Error ? e.message : String(e)}`); }
      if (inner) for (const a of scanActive(inner, 1, budget)) act.push(`${name}: ${a}`);
      continue;
    }
    else if (/(^|\/)embeddings\/[^/]*\.(bin|ole|docm|xlsm|pptm|docx|xlsx|pptx|dotm|xltm|potm)$/.test(n) || /(^|\/)oleobject[^/]*\.bin$/.test(n)) act.push(`embedded OLE/package ${name}`);
    else if (MACRO_EXT.test(n)) act.push(`macro-enabled document part ${name}`);
    else if (SCRIPT_EXT.test(n)) act.push(`script/executable/SVG/markup part ${name}`);
    else if (!/\.(xml|rels)$/.test(n) && EXEC_MAGIC(bytes)) act.push(`executable binary (MZ/ELF/Mach-O) ${name}`);
    else if (/(^|\/)activex\//.test(n)) act.push(`ActiveX part ${name}`);

    const ext = /\.([^./]+)$/.exec(n)?.[1] ?? '';
    const isXml = ext === 'xml' || ext === 'rels' || ext === 'vml' || xmlCt(ctOverride.get(n) ?? ctDefault.get(ext)) || looksXml(bytes);
    if (isXml) act.push(...scanXml(name, bytes, budget));
    else if (MARKUP_HEAD.test(new TextDecoder('latin1').decode(bytes.subarray(0, 512)))) act.push(`${name}: SVG/HTML/script markup under a non-markup name`);
  }
  for (const [name, b] of parts) {
    if (!name.toLowerCase().endsWith('.rels')) continue;
    const r = readTags(b);
    if ('problem' in r) continue; // already reported by scanXml
    for (const t of r.tags) {
      if (t.name !== 'Relationship') continue;
      const raw = attrCI(t.attrs, 'Target') ?? '';
      const cleaned = raw.replace(/[\p{Cc}\s]/gu, ''); // what a lenient consumer would see after dropping tabs/newlines/spaces
      const type = attrCI(t.attrs, 'Type') ?? '';
      const external = (attrCI(t.attrs, 'TargetMode') ?? '').toLowerCase() === 'external';
      const where = `${name} (${q(type.replace(/^.*\//, ''))} -> ${q(raw)})`;
      const kind = relKind(type);
      const resolved = external ? null : resolvePart(name, raw.trim());
      const chartPkg = !external && kind === 'package' && /(^|\/)charts\/_rels\//i.test(name) && resolved !== null && chartPackages.has(resolved);
      if ((ACTIVE_KINDS.has(kind) || DENY_REL_KINDS.has(kind)) && !chartPkg) { act.push(`active-content relationship in ${where}`); continue; }
      if (raw.includes('\\')) { act.push(`backslash in target of ${where}`); continue; }
      const scheme = SCHEME.test(cleaned) || SCHEME.test(stripInvisible(safeDecode(raw)));
      if (external) {
        if (!(kind === 'hyperlink' && /^https:\/\//i.test(cleaned) && raw.trim() === cleaned)) act.push(`external relationship in ${where}: only https hyperlinks are allowed`);
        continue;
      }
      if (scheme || /^\/\//.test(cleaned)) { act.push(`absolute/remote target in ${where}`); continue; }
      if (cleaned.startsWith('#')) { if (kind !== 'hyperlink') act.push(`fragment-only target in ${where}`); continue; }
      if (chartPkg) continue;
      let dec: string;
      try { dec = decodeURIComponent(raw.trim().replace(/[#?].*$/, '')); } catch { act.push(`undecodable target in ${where}`); continue; }
      if (/%(2e|2f|5c|00)/i.test(dec) || dec.includes('\\') || foldName(dec).includes('\\')) { act.push(`encoded traversal or separator in target of ${where}`); continue; }
      const res = resolvePart(name, foldName(dec) === dec ? dec : foldName(dec));
      if (res === null) { act.push(`target climbs above the package root in ${where}`); continue; }
      if (!partKeys.has(nameKey(res))) act.push(`internal target resolves to no part in ${where}`);
    }
  }
  return act;
}

function ooxmlChecks(format: string, bytes: Uint8Array): { zip: ValidationCheck; active: ValidationCheck } {
  let parts: Map<string, Uint8Array>;
  const budget: Budget = { remaining: MAX_TOTAL_INFLATED, deadline: Date.now() + VALIDATION_MS, nested: 0 };
  try { parts = readZipFiles(bytes, { maxTotal: budget.remaining, deadline: budget.deadline }); budget.remaining -= sumSizes(parts); }
  catch (e) {
    const msg = e instanceof UnpackError ? e.message : String(e);
    return { zip: fail('ooxml-zip', `not a valid zip archive: ${msg}`), active: skip('no-active-content', 'the file is not a readable zip') };
  }
  const problems: string[] = [];
  const lower = new Map<string, string>(); // lowercased name -> real name
  for (const name of parts.keys()) {
    const k = nameKey(name);
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
  for (const [name, b] of parts) {
    if (!name.toLowerCase().endsWith('.rels')) continue;
    const r = readTags(b);
    if ('problem' in r) continue;
    if (r.tags[0]?.name !== 'Relationships') problems.push(`${name} root must be <Relationships>, not <${r.tags[0]?.name}>`);
    else if (r.tags[0].attrs.get('xmlns') !== NS_RELS) problems.push(`${name} root namespace must be ${NS_RELS}`);
    const ids = new Set<string>(), dupIds: string[] = [], odd: string[] = [], incomplete: string[] = [];
    for (const t of r.tags.slice(1)) {
      if (t.name !== 'Relationship') { odd.push(t.name); continue; }
      const id = attrCI(t.attrs, 'Id');
      if (id === undefined || attrCI(t.attrs, 'Type') === undefined || attrCI(t.attrs, 'Target') === undefined) incomplete.push(id ?? '(no Id)');
      else if (ids.has(id)) dupIds.push(id); else ids.add(id);
    }
    if (odd.length) problems.push(`${name} has unknown child element(s): ${list(odd)}`);
    if (dupIds.length) problems.push(`${name}: duplicate relationship id(s) ${list(dupIds)}`);
    if (incomplete.length) problems.push(`${name}: relationship(s) missing Id, Type or Target: ${list(incomplete)}`);
  }
  if (ctBytes) {
    const r = readTags(ctBytes);
    if (!('problem' in r)) {
      if (r.tags[0]?.name !== 'Types') problems.push(`[Content_Types].xml root must be <Types>, not <${r.tags[0]?.name}>`);
      else if (r.tags[0].attrs.get('xmlns') !== NS_CT) problems.push(`[Content_Types].xml root namespace must be ${NS_CT}`);
      const oddCt = r.tags.slice(1).filter((t) => t.name !== 'Default' && t.name !== 'Override').map((t) => t.name);
      if (oddCt.length) problems.push(`[Content_Types].xml has unknown child element(s): ${list(oddCt)}`);
      const RELS_CT = 'application/vnd.openxmlformats-package.relationships+xml';
      const overrides = new Map<string, string>(), defaults = new Map<string, string>();
      for (const t of r.tags) {
        if (t.name === 'Override') overrides.set(nameKey((attrCI(t.attrs, 'PartName') ?? '').replace(/^\//, '')), (attrCI(t.attrs, 'ContentType') ?? '').trim().toLowerCase());
        if (t.name === 'Default') defaults.set((attrCI(t.attrs, 'Extension') ?? '').toLowerCase(), (attrCI(t.attrs, 'ContentType') ?? '').trim().toLowerCase());
      }
      if (overrides.has('[content_types].xml')) problems.push('[Content_Types].xml cannot have an Override for itself');
      const effective = (n: string) => overrides.get(nameKey(n)) ?? defaults.get((/\.([^./]+)$/.exec(n)?.[1] ?? '').toLowerCase());
      for (const n of parts.keys()) if (n.toLowerCase().endsWith('.rels') && effective(n) !== RELS_CT) problems.push(`relationship part ${q(n)} must have the relationships content type (is ${q(effective(n) ?? 'none')})`);
      const mainCt = effective(main);
      if (mainCt !== undefined && !MAIN_CT[format].test(mainCt)) problems.push(`main part ${main} has content type ${q(mainCt)}, not a ${format} main type`);
      const missing: string[] = [], seenPn = new Set<string>(), seenExt = new Set<string>(), dups: string[] = [];
      for (const t of r.tags) {
        // OPC: at most one content type per part name and per extension (OfficeCLI refuses the package otherwise).
        if (t.name === 'Override') { const k = nameKey((attrCI(t.attrs, 'PartName') ?? '').replace(/^\//, '')); if (seenPn.has(k)) dups.push(k); seenPn.add(k); }
        if (t.name === 'Default') { const k = (attrCI(t.attrs, 'Extension') ?? '').toLowerCase(); if (seenExt.has(k)) dups.push(`.${k}`); seenExt.add(k); }
        const pn = t.name === 'Override' ? attrCI(t.attrs, 'PartName') : undefined;
        if (pn && !lower.has(nameKey(pn.replace(/^\//, '')))) missing.push(pn);
      }
      if (missing.length) problems.push(`content types name parts that do not exist: ${list(missing)}`);
      if (dups.length) problems.push(`duplicate content type declarations: ${list(dups)}`);
    }
  }
  const act = scanActive(parts, 0, budget);
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
