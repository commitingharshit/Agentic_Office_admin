// File-level comparison of two unpacked packages, with a small unified diff for text files. Pure: no I/O.
import { sha256Hex } from './artifacts.ts';

export const MAX_DIFF_FILE = 64 * 1024;    // text files up to this size get a line diff
export const MAX_DIFF_CHARS = 20_000;      // a diff string is cut at this length
const MAX_CELLS = 4_000_000;               // LCS table cap; beyond it the changed block is shown as replaced
export const MAX_DIFFED_FILES = 50;        // text diffs per comparison
export const CELL_BUDGET = 8_000_000;      // LCS cells across one whole comparison

type Op = { k: ' ' | '-' | '+'; s: string };

function lines(s: string): string[] {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Line edit script: common prefix/suffix trimmed, LCS on the middle (or a plain replace when it is too large). */
/** `budget.left` is reduced by the LCS cells used; null when the middle block would not fit in what is left. */
function editScript(a: string[], b: string[], budget?: { left: number }): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  const ops: Op[] = a.slice(0, pre).map((s) => ({ k: ' ', s }));
  const n = am.length, m = bm.length;
  if (budget && n * m <= MAX_CELLS && n * m > budget.left) return null;
  if (n * m > MAX_CELLS || n === 0 || m === 0) {
    for (const s of am) ops.push({ k: '-', s });
    for (const s of bm) ops.push({ k: '+', s });
  } else {
    if (budget) budget.left -= n * m;
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
export function unifiedDiff(a: string, b: string, context = 3, budget?: { left: number }): string | null {
  const ops = editScript(lines(a), lines(b), budget);
  if (!ops) return null;
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
  /** A unified diff for a text file; null when none was computed (see `reason`); absent for binary files. */
  diff?: string | null; diffTruncated?: boolean;
  /** Why `diff` is null: 'budget' (too many files or too much work in this comparison) or 'too-large' (over 64 KB). */
  reason?: 'budget' | 'too-large';
  /** True when the file is not text: only hashes are reported. */
  binary?: boolean;
}

function asText(b: Uint8Array): string | undefined {
  if (b.includes(0)) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return undefined; }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Per-file status, hashes and (for small text files) a line diff. Bounded per comparison: at most MAX_DIFFED_FILES text
 * diffs, CELL_BUDGET LCS cells in total, nothing over 64 KB; the rest report hashes and sizes with `diff: null` and a
 * reason. The event loop is yielded to between files, so a big comparison cannot monopolise the process.
 */
export async function comparePackages(base: Map<string, Uint8Array>, head: Map<string, Uint8Array>): Promise<{ files: FileChange[]; unchanged: number; budgetLimited: boolean }> {
  const files: FileChange[] = [];
  let unchanged = 0, diffed = 0, budgetLimited = false;
  const budget = { left: CELL_BUDGET };
  const side = (b: Uint8Array): FileSide => ({ sha256: sha256Hex(b), size: b.length });
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    await tick();
    const a = base.get(path), b = head.get(path);
    const ch: FileChange = { path, status: a && b ? 'changed' : a ? 'removed' : 'added' };
    if (a) ch.base = side(a);
    if (b) ch.head = side(b);
    if (a && b && ch.base!.sha256 === ch.head!.sha256) { unchanged++; continue; }
    const big = (a?.length ?? 0) > MAX_DIFF_FILE || (b?.length ?? 0) > MAX_DIFF_FILE;
    const ta = a && !big ? asText(a) : a ? undefined : '', tb = b && !big ? asText(b) : b ? undefined : '';
    if (!big && (ta === undefined || tb === undefined)) ch.binary = true;
    else if (big) {
      // large: binary if either side is not text, else a text file we choose not to diff
      const isText = (x: Uint8Array | undefined) => !x || asText(x) !== undefined;
      if (isText(a) && isText(b)) { ch.diff = null; ch.reason = 'too-large'; } else ch.binary = true;
    } else if (diffed >= MAX_DIFFED_FILES) { ch.diff = null; ch.reason = 'budget'; budgetLimited = true; }
    else {
      const d = unifiedDiff(ta!, tb!, 3, budget);
      if (d === null) { ch.diff = null; ch.reason = 'budget'; budgetLimited = true; }
      else { diffed++; if (d.length > MAX_DIFF_CHARS) { ch.diff = d.slice(0, MAX_DIFF_CHARS); ch.diffTruncated = true; } else ch.diff = d; }
    }
    files.push(ch);
  }
  return { files, unchanged, budgetLimited };
}
