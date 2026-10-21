// File-level comparison of two unpacked packages, with a small unified diff for text files. Pure: no I/O.
import { sha256Hex } from './artifacts.ts';

export const MAX_DIFF_FILE = 256 * 1024;   // text files up to this size get a line diff
export const MAX_DIFF_CHARS = 20_000;      // a diff string is cut at this length
const MAX_CELLS = 4_000_000;               // LCS table cap; beyond it the changed block is shown as replaced

type Op = { k: ' ' | '-' | '+'; s: string };

function lines(s: string): string[] {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Line edit script: common prefix/suffix trimmed, LCS on the middle (or a plain replace when it is too large). */
function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((s) => ({ k: ' ', s }));
  const n = am.length, m = bm.length;
  if (n * m > MAX_CELLS || n === 0 || m === 0) {
    for (const s of am) ops.push({ k: '-', s });
    for (const s of bm) ops.push({ k: '+', s });
  } else {
    const w = m + 1, t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ k: ' ', s: am[i] }); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ k: '-', s: am[i++] });
      else ops.push({ k: '+', s: bm[j++] });
    }
    while (i < n) ops.push({ k: '-', s: am[i++] });
    while (j < m) ops.push({ k: '+', s: bm[j++] });
  }
  for (const s of a.slice(a.length - suf)) ops.push({ k: ' ', s });
  return ops;
}

/** A unified diff (3 lines of context). Empty string when the texts are equal. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  const ops = editScript(lines(a), lines(b));
  const ai: number[] = [], bi: number[] = [];   // line numbers (0-based) before each op
  let x = 0, y = 0;
  for (const o of ops) { ai.push(x); bi.push(y); if (o.k !== '+') x++; if (o.k !== '-') y++; }
  const changed = ops.map((o, i) => (o.k === ' ' ? -1 : i)).filter((i) => i >= 0);
  const out: string[] = [];
  let g = 0;
  while (g < changed.length) {
    let h = g;
    while (h + 1 < changed.length && changed[h + 1] - changed[h] <= 2 * context + 1) h++;
    const from = Math.max(0, changed[g] - context), to = Math.min(ops.length - 1, changed[h] + context);
    let ac = 0, bc = 0;
    for (let i = from; i <= to; i++) { if (ops[i].k !== '+') ac++; if (ops[i].k !== '-') bc++; }
    out.push(`@@ -${ac ? ai[from] + 1 : ai[from]},${ac} +${bc ? bi[from] + 1 : bi[from]},${bc} @@`);
    for (let i = from; i <= to; i++) out.push(ops[i].k + ops[i].s);
    g = h + 1;
  }
  return out.join('\n');
}

export interface FileSide { sha256: string; size: number }
export interface FileChange {
  path: string; status: 'added' | 'removed' | 'changed';
  base?: FileSide; head?: FileSide;
  /** Only for text files up to 256 KB that changed or were added/removed. */
  diff?: string; diffTruncated?: boolean;
  /** True when the file is not text (or too big): only hashes are reported. */
  binary?: boolean;
}

function asText(b: Uint8Array): string | undefined {
  if (b.length > MAX_DIFF_FILE || b.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return undefined; }
}

export function comparePackages(base: Map<string, Uint8Array>, head: Map<string, Uint8Array>): { files: FileChange[]; unchanged: number } {
  const files: FileChange[] = [];
  let unchanged = 0;
  const side = (b: Uint8Array): FileSide => ({ sha256: sha256Hex(b), size: b.length });
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const a = base.get(path), b = head.get(path);
    const ch: FileChange = { path, status: a && b ? 'changed' : a ? 'removed' : 'added' };
    if (a) ch.base = side(a);
    if (b) ch.head = side(b);
    if (a && b && ch.base!.sha256 === ch.head!.sha256) { unchanged++; continue; }
    const ta = a ? asText(a) : '', tb = b ? asText(b) : '';
    if (ta === undefined || tb === undefined) ch.binary = true;
    else {
      const d = unifiedDiff(ta, tb);
      if (d.length > MAX_DIFF_CHARS) { ch.diff = d.slice(0, MAX_DIFF_CHARS); ch.diffTruncated = true; } else ch.diff = d;
    }
    files.push(ch);
  }
  return { files, unchanged };
}
