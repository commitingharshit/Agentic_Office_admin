// Skill validator (type 'skill'): an agentskills.io-style SKILL.md package. Every check runs even if an earlier one
// failed, except those that depend on a failed one, which are reported `skipped` with a reason. The security scan is
// injected (see skillsGuard.ts) and is REQUIRED: with no scanner it is `skipped` + `required`, so the report is never
// `verified`. Must not import ./index.ts (cycle): the registry imports this module and registers createSkillValidator().
import type { UnpackedPackage, ValidationCheck } from '../types.ts';

export interface SkillScanFinding { category: string; severity: string; file: string; line?: number; match?: string }
export interface SkillScanResult { verdict: 'safe' | 'caution' | 'dangerous'; findings: SkillScanFinding[] }
export type SkillScanner = (files: Map<string, Uint8Array>, name: string) => Promise<SkillScanResult>;
export interface SkillValidatorOptions { scanner?: SkillScanner }

const MAX_LIST = 12;
const MAX_SKILL_MD = 256 * 1024, MAX_FILES = 500, MAX_FILE = 5 * 1024 * 1024;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STANDARD_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const EXEC_EXT = /\.(sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd|vbs|exe|dll|so|dylib|jar|bin|com|msi|app|command)$/i;
const SCAN_IGNORE = /(^|\/)\.(skill|clawhub)ignore$/;

const ok = (name: string, extra: Partial<ValidationCheck> = {}): ValidationCheck => ({ name, ok: true, ...extra });
const fail = (name: string, detail: string): ValidationCheck => ({ name, ok: false, detail });
const skip = (name: string, why: string, extra: Partial<ValidationCheck> = {}): ValidationCheck => ({ name, ok: true, skipped: true, detail: `skipped: ${why}`, ...extra });
const list = (xs: string[]) => xs.slice(0, MAX_LIST).join('; ') + (xs.length > MAX_LIST ? `; ... and ${xs.length - MAX_LIST} more` : '');
const q = (s: string) => JSON.stringify(s.length > 120 ? s.slice(0, 120) + '...' : s);

// ------------------------------------------------------------------ frontmatter: a tiny YAML subset

export type Yaml = string | Yaml[] | { [k: string]: Yaml };
class YamlError extends Error {}
const MAX_DEPTH = 6;

const indentOf = (l: string) => l.length - l.trimStart().length;
const isBlank = (l: string) => l.trim() === '' || l.trimStart().startsWith('#');

function unquote(s: string): { v: string; rest: string } {
  const quote = s[0];
  let out = '', i = 1;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"' && ch === '\\') {
      const n = s[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ' };
      if (n === undefined || !(n in map)) throw new YamlError(`unsupported escape in ${q(s)}`);
      out += map[n];
    } else if (quote === "'" && ch === "'" && s[i + 1] === "'") { out += "'"; i++; }
    else if (ch === quote) return { v: out, rest: s.slice(i + 1) };
    else out += ch;
  }
  throw new YamlError(`unterminated quoted string ${q(s)}`);
}

function splitFlow(s: string): string[] {
  const parts: string[] = [];
  let cur = '', quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { cur += ch; if (ch === '\\' && quote === '"') cur += s[++i] ?? ''; else if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === ',') { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (quote) throw new YamlError('unterminated quote in a flow collection');
  if (cur.trim() !== '' || parts.length) parts.push(cur);
  return parts;
}

function scalar(raw: string): Yaml {
  const s = raw.trim();
  if (s[0] === '"' || s[0] === "'") {
    const { v, rest } = unquote(s);
    if (rest.trim() !== '' && !rest.trim().startsWith('#')) throw new YamlError(`unexpected text after quoted string: ${q(rest.trim())}`);
    return v;
  }
  if (s[0] === '[') {
    if (!s.endsWith(']')) throw new YamlError(`unterminated flow list ${q(s)}`);
    return splitFlow(s.slice(1, -1)).map((x) => { const v = scalar(x); if (typeof v !== 'string') throw new YamlError('nested flow collections are not supported'); return v; });
  }
  if (s[0] === '{') {
    if (!s.endsWith('}')) throw new YamlError(`unterminated flow map ${q(s)}`);
    const out: Record<string, Yaml> = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const m = /^\s*("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:\s*(.*)$/.exec(part);
      if (!m) throw new YamlError(`bad flow map entry ${q(part)}`);
      const k = m[1][0] === '"' || m[1][0] === "'" ? m[1].slice(1, -1) : m[1];
      if (k in out) throw new YamlError(`duplicate key ${q(k)}`);
      const v = scalar(m[2]);
      if (typeof v !== 'string') throw new YamlError('nested flow collections are not supported');
      out[k] = v;
    }
    return out;
  }
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') throw new YamlError('YAML anchors, aliases and tags are not supported');
  return s.replace(/\s+#.*$/, '');
}

const KEY_RE = /^("[^"]*"|'[^']*'|[^\s:#\-?][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

function parseBlock(lines: string[], pos: { i: number }, ind: number, depth: number): Yaml {
  if (depth > MAX_DEPTH) throw new YamlError('nesting is too deep');
  while (pos.i < lines.length && isBlank(lines[pos.i])) pos.i++;
  if (pos.i >= lines.length) return '';
  if (/^-(\s|$)/.test(lines[pos.i].trimStart())) return parseList(lines, pos, ind, depth);
  return parseMap(lines, pos, ind, depth);
}

function parseList(lines: string[], pos: { i: number }, ind: number, depth: number): Yaml[] {
  const out: Yaml[] = [];
  while (pos.i < lines.length) {
    const l = lines[pos.i];
    if (isBlank(l)) { pos.i++; continue; }
    if (indentOf(l) < ind) break;
    if (indentOf(l) > ind) throw new YamlError(`unexpected indentation at ${q(l.trim())}`);
    const m = /^-(?:\s+(.*))?$/.exec(l.trimStart());
    if (!m) break;
    pos.i++;
    const item = m[1] ?? '';
    if (item === '') throw new YamlError('empty list items are not supported');
    if (KEY_RE.test(item) && !/^["'[{]/.test(item)) throw new YamlError('maps inside lists are not supported');
    const v = scalar(item);
    if (typeof v !== 'string') throw new YamlError('collections inside lists are not supported');
    out.push(v);
  }
  return out;
}

function blockScalar(lines: string[], pos: { i: number }, ind: number, header: string): string {
  const m = /^([|>])([+-]?)(\d?)$/.exec(header);
  if (!m) throw new YamlError(`unsupported block scalar header ${q(header)}`);
  const body: string[] = [];
  while (pos.i < lines.length && (lines[pos.i].trim() === '' || indentOf(lines[pos.i]) > ind)) body.push(lines[pos.i++]);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const base = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf), Infinity);
  const text = body.map((l) => (l.trim() === '' ? '' : l.slice(base === Infinity ? 0 : base)));
  let out: string;
  if (m[1] === '|') out = text.join('\n');
  else {
    // folded: single newlines become spaces, blank lines become newlines
    out = ''; let prevBlank = false;
    text.forEach((l, idx) => {
      if (l === '') { out += '\n'; prevBlank = true; }
      else { if (idx > 0 && !prevBlank) out += ' '; out += l; prevBlank = false; }
    });
  }
  return m[2] === '-' || text.length === 0 ? out : out + '\n';
}

function parseMap(lines: string[], pos: { i: number }, ind: number, depth: number): { [k: string]: Yaml } {
  const out: { [k: string]: Yaml } = {};
  while (pos.i < lines.length) {
    const l = lines[pos.i];
    if (isBlank(l)) { pos.i++; continue; }
    if (/^\s*\t/.test(l)) throw new YamlError('tabs are not allowed for indentation');
    const cur = indentOf(l);
    if (cur < ind) break;
    if (cur > ind) throw new YamlError(`unexpected indentation at ${q(l.trim())}`);
    const m = KEY_RE.exec(l.trimStart());
    if (!m) throw new YamlError(`cannot parse line ${q(l.trim())}`);
    const key = m[1][0] === '"' || m[1][0] === "'" ? m[1].slice(1, -1) : m[1].trim();
    if (key in out) throw new YamlError(`duplicate key ${q(key)}`);
    pos.i++;
    const rest = (m[2] ?? '').trim();
    if (/^[|>]/.test(rest)) out[key] = blockScalar(lines, pos, ind, rest.replace(/\s+#.*$/, ''));
    else if (rest === '' || rest.startsWith('#')) {
      let j = pos.i;
      while (j < lines.length && isBlank(lines[j])) j++;
      const nextInd = j < lines.length ? indentOf(lines[j]) : -1;
      if (j < lines.length && (nextInd > ind || (nextInd === ind && /^-(\s|$)/.test(lines[j].trimStart())))) { pos.i = j; out[key] = parseBlock(lines, pos, nextInd, depth + 1); }
      else out[key] = '';
    } else out[key] = scalar(rest);
  }
  return out;
}

/** Splits `---` delimited YAML frontmatter from SKILL.md text and parses it. */
export function parseFrontmatter(text: string): { fm: { [k: string]: Yaml }; body: string } | { error: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!t.startsWith('---\n')) return { error: 'SKILL.md must start with a "---" YAML frontmatter line' };
  const rest = t.slice(4);
  const end = /^---[ \t]*$/m.exec(rest);
  if (!end) return { error: 'frontmatter is not closed by a "---" line' };
  const yaml = rest.slice(0, end.index), body = rest.slice(end.index + end[0].length).replace(/^\n/, '');
  try {
    const lines = yaml.split('\n');
    const pos = { i: 0 };
    const fm = parseMap(lines, pos, 0, 0);
    while (pos.i < lines.length && isBlank(lines[pos.i])) pos.i++;
    if (pos.i < lines.length) throw new YamlError(`cannot parse line ${q(lines[pos.i].trim())}`);
    return { fm, body };
  } catch (e) {
    if (e instanceof YamlError) return { error: `frontmatter is not valid: ${e.message}` };
    throw e;
  }
}

// ------------------------------------------------------------------ checks

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const decode = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

function checkFrontmatter(text: string, payloadName: string, dir: string): { check: ValidationCheck; body?: string } {
  const parsed = parseFrontmatter(text);
  if ('error' in parsed) return { check: fail('frontmatter', parsed.error) };
  const { fm, body } = parsed;
  const bad: string[] = [];
  const name = fm.name;
  if (typeof name !== 'string' || name === '') bad.push('name: required string');
  else {
    if (name.length > 64) bad.push(`name: ${name.length} characters, at most 64`);
    if (!NAME_RE.test(name)) bad.push('name: lowercase letters, digits and single hyphens only (no leading, trailing or double hyphen)');
    if (name !== payloadName) bad.push(`name: ${q(name)} does not equal payload.name ${q(payloadName)}`);
    if (dir) { const leaf = dir.slice(dir.lastIndexOf('/') + 1); if (name !== leaf) bad.push(`name: ${q(name)} does not equal the skill directory ${q(leaf)}`); }
  }
  const d = fm.description;
  if (typeof d !== 'string' || d.trim() === '') bad.push('description: required non-empty string');
  else if (d.length > 1024) bad.push(`description: ${d.length} characters, at most 1024`);
  if (fm.license !== undefined && typeof fm.license !== 'string') bad.push('license: must be a string');
  if (fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== 'string') bad.push('compatibility: must be a string');
    else if (fm.compatibility.length > 500) bad.push(`compatibility: ${fm.compatibility.length} characters, at most 500`);
  }
  if (fm.metadata !== undefined) {
    const md = fm.metadata;
    if (typeof md !== 'object' || Array.isArray(md)) bad.push('metadata: must be a map of strings');
    else for (const [k, v] of Object.entries(md)) if (typeof v !== 'string') bad.push(`metadata.${k}: must be a string`);
  }
  const at = fm['allowed-tools'];
  if (at !== undefined && typeof at !== 'string' && !(Array.isArray(at) && at.every((x) => typeof x === 'string'))) bad.push('allowed-tools: must be a string or a list of strings');
  if (bad.length) return { check: fail('frontmatter', list(bad)) };
  const extra = Object.keys(fm).filter((k) => !STANDARD_KEYS.has(k));
  return { check: ok('frontmatter', extra.length ? { detail: `non-standard: ${extra.join(', ')}` } : {}), body };
}

/** Link targets of a markdown body, ignoring fenced code blocks. */
function linkTargets(body: string): string[] {
  const kept: string[] = [];
  let fence = '';
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = ''; continue; }
    if (!fence) kept.push(line);
  }
  const noFences = kept.join('\n');
  const out: string[] = [];
  for (const m of noFences.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)) out.push(m[1].replace(/^<|>$/g, ''));
  for (const m of noFences.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) out.push(m[1].replace(/^<|>$/g, ''));
  return out;
}

function checkReferences(body: string, dir: string, files: Map<string, Uint8Array>): ValidationCheck {
  const problems: string[] = [];
  for (const raw of linkTargets(body)) {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || t.startsWith('//')) continue; // absolute URL (https:, mailto:, ...)
    let p = t.replace(/[?#].*$/, '');
    if (p === '') continue;
    try { p = decodeURIComponent(p); } catch { problems.push(`${q(t)}: not a valid path`); continue; }
    if (p.includes('\\') || p.startsWith('/')) { problems.push(`${q(t)}: absolute or backslash path`); continue; }
    const segs: string[] = [];
    let escapes = false;
    for (const s of p.split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') { if (segs.length === 0) { escapes = true; break; } segs.pop(); } else segs.push(s);
    }
    if (escapes) { problems.push(`${q(t)}: escapes the skill directory`); continue; }
    if (segs.length === 0) continue;
    const full = (dir ? dir + '/' : '') + segs.join('/');
    if (!files.has(full)) problems.push(`${q(t)}: no such file in the package`);
  }
  const uniq = [...new Set(problems)];
  return uniq.length ? fail('references-resolve', list(uniq)) : ok('references-resolve');
}

function checkSizes(entry: string, files: Map<string, Uint8Array>): ValidationCheck {
  const bad: string[] = [];
  const md = files.get(entry);
  if (md && md.length > MAX_SKILL_MD) bad.push(`${entry}: ${md.length} bytes is over the ${MAX_SKILL_MD} byte cap`);
  if (files.size > MAX_FILES) bad.push(`${files.size} files is over the ${MAX_FILES} file cap`);
  for (const [p, b] of files) if (b.length > MAX_FILE) bad.push(`${p}: ${b.length} bytes is over the ${MAX_FILE} byte cap`);
  return bad.length ? fail('size-limits', list(bad)) : ok('size-limits');
}

const isExecMagic = (b: Uint8Array) => b.length >= 2 && ((b[0] === 0x23 && b[1] === 0x21) || (b[0] === 0x4d && b[1] === 0x5a) || (b.length >= 4 && ((b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)
  || (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) || (b[3] === 0xfe && b[2] === 0xed && b[1] === 0xfa && (b[0] === 0xce || b[0] === 0xcf))
  || (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe))));

export function createSkillValidator(opts: SkillValidatorOptions = {}) {
  return async (pkg: UnpackedPackage): Promise<ValidationCheck[]> => {
    const checks: ValidationCheck[] = [];
    const p = (pkg.manifest.payload ?? {}) as Record<string, unknown>;
    const shape: string[] = [];
    for (const k of Object.keys(p)) if (k !== 'entry' && k !== 'name') shape.push(`payload.${k}: unknown field`);
    if (p.entry !== undefined && (typeof p.entry !== 'string' || p.entry === '')) shape.push('payload.entry: must be a non-empty path string');
    if (typeof p.name !== 'string' || p.name === '') shape.push('payload.name: must be a non-empty string');
    if (shape.length) {
      checks.push(fail('payload-shape', shape.join('; ')));
      for (const n of ['skill-md-present', 'frontmatter', 'references-resolve']) checks.push(skip(n, 'payload-shape failed'));
      checks.push(checkSizes('SKILL.md', pkg.files));
      checks.push(skip('no-hidden-executables', 'payload-shape failed'), skip('no-scan-ignore-files', 'payload-shape failed'), skip('permissions-declared', 'payload-shape failed'));
      checks.push(skip('security-scan', 'payload-shape failed', { required: true }));
      return checks;
    }
    checks.push(ok('payload-shape'));
    const entry = (p.entry as string | undefined) ?? 'SKILL.md';
    const name = p.name as string;
    const dir = dirname(entry);

    // skill-md-present
    const mdBytes = pkg.files.get(entry);
    const problems: string[] = [];
    if (!mdBytes) problems.push(`${q(entry)} is not in the package`);
    if (entry.split('/').pop() !== 'SKILL.md') problems.push('the entry file must be named SKILL.md');
    const outside = [...pkg.files.keys()].filter((f) => dir && !f.startsWith(dir + '/'));
    if (!dir) { /* root skill: everything is inside */ } else if (outside.length) problems.push(`files outside the skill directory ${q(dir)}: ${list(outside)}`);
    checks.push(problems.length ? fail('skill-md-present', problems.join('; ')) : ok('skill-md-present'));

    // frontmatter + references
    let body: string | undefined;
    if (!mdBytes) {
      checks.push(skip('frontmatter', 'skill-md-present failed'), skip('references-resolve', 'skill-md-present failed'));
    } else {
      let text: string | undefined;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(mdBytes); } catch { /* handled below */ }
      if (text === undefined) {
        checks.push(fail('frontmatter', 'SKILL.md is not valid UTF-8'), skip('references-resolve', 'frontmatter failed'));
      } else {
        const fm = checkFrontmatter(text, name, dir);
        checks.push(fm.check);
        body = fm.body ?? parseBodyAnyway(text);
        checks.push(body === undefined ? skip('references-resolve', 'frontmatter could not be split from the body') : checkReferences(body, dir, pkg.files));
      }
    }

    checks.push(checkSizes(entry, pkg.files));

    // executables and scripts
    const scriptsPrefix = (dir ? dir + '/' : '') + 'scripts/';
    const scripts = [...pkg.files.keys()].filter((f) => f.startsWith(scriptsPrefix));
    const hidden = [...pkg.files].filter(([f, b]) => !f.startsWith(scriptsPrefix) && (EXEC_EXT.test(f) || isExecMagic(b))).map(([f]) => f);
    const detail: string[] = [];
    if (scripts.length) detail.push(`scripts: ${list(scripts)}`);
    if (hidden.length) detail.push(`warning: executable-looking files outside scripts/: ${list(hidden)}`);
    checks.push(ok('no-hidden-executables', detail.length ? { detail: detail.join('; ') } : {}));
    const ignoreFiles = [...pkg.files.keys()].filter((f) => SCAN_IGNORE.test(f));
    checks.push(ignoreFiles.length ? fail('no-scan-ignore-files', `${list(ignoreFiles)}: a skill must not ship a scanner ignore file (it would hide files from the security scan)`) : ok('no-scan-ignore-files'));
    if (scripts.length && !pkg.manifest.permissions.some((x) => x.capability === 'exec.script'))
      checks.push(fail('permissions-declared', `the package ships scripts (${list(scripts)}) but the manifest does not declare the exec.script permission`));
    else checks.push(ok('permissions-declared'));

    // security-scan (required)
    if (!opts.scanner) checks.push(skip('security-scan', 'no scanner configured', { required: true }));
    else {
      try {
        const r = await opts.scanner(pkg.files, name);
        if (r.verdict === 'safe') checks.push(ok('security-scan'));
        else checks.push(fail('security-scan', `verdict ${r.verdict}; ${r.findings.length} finding(s): ` + list(r.findings.map((f) => `${f.category}/${f.severity} ${f.file}${f.line ? ':' + f.line : ''}${f.match ? ' ' + q(f.match) : ''}`))));
      } catch (e) {
        checks.push(fail('security-scan', `scanner failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    return checks;
  };
}

/** When frontmatter validation fails but the document still splits, links are still checked on the body. */
function parseBodyAnyway(text: string): string | undefined {
  const r = parseFrontmatter(text);
  return 'body' in r ? r.body : undefined;
}
