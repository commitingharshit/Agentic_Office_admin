// Differential helpers: seeded mutations of the real templates and OfficeCLI (the renderer users get) as an independent
// reference for "is this OOXML package corrupt". Pure functions are unit-tested in test/marketplace-template-differential.test.ts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

export type OfficeVerdict = { kind: 'ok' } | { kind: 'cannot-open'; detail: string } | { kind: 'invalid'; detail: string } | { kind: 'error'; detail: string };

/** Seeded PRNG (mulberry32): the same FUZZ_SEED always yields the same mutation set. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface Mutation { id: string; op: string; format: 'docx' | 'pptx' | 'xlsx'; bytes: Uint8Array }
const OPS = ['truncate', 'flip-bytes', 'xml-delete-char', 'xml-swap-tag', 'drop-part', 'garbage-part', 'rels-target', 'ct-override', 'dup-element', 'empty-part'] as const;

const isXml = (n: string) => /\.(xml|rels)$/i.test(n);
/** One deterministic mutation of a real template. `ops` limits the operator set (default all). */
export function mutateOnce(format: 'docx' | 'pptx' | 'xlsx', base: Uint8Array, rand: () => number, index: number): Mutation {
  const op = OPS[Math.floor(rand() * OPS.length)];
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const id = `m${String(index).padStart(3, '0')}-${format}-${op}`;
  if (op === 'truncate') return { id, op, format, bytes: base.slice(0, Math.max(30, Math.floor(base.length * (0.05 + rand() * 0.9)))) };
  if (op === 'flip-bytes') {
    const b = base.slice(); const n = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) b[Math.floor(rand() * b.length)] ^= 1 << Math.floor(rand() * 8);
    return { id, op, format, bytes: b };
  }
  const z = unzipSync(base) as Record<string, Uint8Array>;
  const names = Object.keys(z).sort();
  const xmls = names.filter(isXml);
  const dec = (n: string) => new TextDecoder().decode(z[n]);
  switch (op) {
    case 'xml-delete-char': { const n = pick(xmls); const s = dec(n); const at = Math.floor(rand() * s.length); z[n] = strToU8(s.slice(0, at) + s.slice(at + 1)); break; }
    case 'xml-swap-tag': { const n = pick(xmls); const s = dec(n); const tags = [...s.matchAll(/<\/([A-Za-z0-9:]+)>/g)]; if (tags.length) { const m = pick(tags); z[n] = strToU8(s.slice(0, m.index!) + `</${m[1]}x>` + s.slice(m.index! + m[0].length)); } break; }
    case 'drop-part': delete z[pick(names)]; break;
    case 'garbage-part': { const n = pick(names); z[n] = new Uint8Array(64).map(() => Math.floor(rand() * 256)); break; }
    case 'rels-target': { const n = pick(names.filter((x) => x.endsWith('.rels'))); z[n] = strToU8(dec(n).replace(/Target="[^"]*"/, `Target="missing/${Math.floor(rand() * 1000)}.xml"`)); break; }
    case 'ct-override': { z['[Content_Types].xml'] = strToU8(dec('[Content_Types].xml').replace('</Types>', `<Override PartName="/${pick(names)}" ContentType="application/xml"/></Types>`)); break; }
    case 'dup-element': { const n = pick(xmls); const s = dec(n); const m = pick([...s.matchAll(/<([A-Za-z0-9:]+)[^>]*\/>/g)]); if (m) z[n] = strToU8(s.slice(0, m.index!) + m[0] + m[0] + s.slice(m.index! + m[0].length)); break; }
    case 'empty-part': z[pick(names)] = new Uint8Array(0); break;
  }
  return { id, op, format, bytes: zipSync(z as Zippable, { mtime: new Date(Date.UTC(2000, 0, 1)) }) }; // fixed mtime: the set is byte-reproducible per seed
}

export function mutations(bases: Record<'docx' | 'pptx' | 'xlsx', Uint8Array>, count: number, seed: number): Mutation[] {
  const rand = rng(seed), fmts = ['docx', 'pptx', 'xlsx'] as const, out: Mutation[] = [];
  for (let i = 0; i < count; i++) { const f = fmts[i % 3]; out.push(mutateOnce(f, bases[f], rand, i)); }
  return out;
}

/** OfficeCLI output -> verdict. cannot-open = it refused to open the file; invalid = it opened it but reports package/schema errors. */
export function classifyOfficecli(validate: { code: number | null; out: string }, issues: { code: number | null; out: string } | undefined): OfficeVerdict {
  const first = (s: string) => s.trim().split('\n')[0].slice(0, 200);
  if (validate.code === null) return { kind: 'error', detail: 'timed out or did not run' };
  if (validate.code === 0 && (!issues || issues.code === 0)) return { kind: 'ok' };
  if (/Cannot open|corrupt|not a valid|End of Central|Archive/i.test(validate.out)) return { kind: 'cannot-open', detail: first(validate.out) };
  if (issues && issues.code !== 0 && issues.code !== null && /Cannot open|corrupt/i.test(issues.out)) return { kind: 'cannot-open', detail: first(issues.out) };
  if (/validation error/i.test(validate.out)) return { kind: 'invalid', detail: first(validate.out) + ' ' + (/\[(Package|Schema)\]/.exec(validate.out)?.[0] ?? '') };
  return { kind: 'error', detail: first(validate.out) };
}

export const officecliBin = (): string | undefined => {
  const cand = [process.env.OFFICECLI_BIN, join(process.env.HOME ?? '', '.local/bin/officecli'), '/usr/local/bin/officecli'].filter(Boolean) as string[];
  return cand.find((c) => existsSync(c));
};

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '', done = false;
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? cwd, LANG: 'C.UTF-8' };
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const fin = (code: number | null) => { if (done) return; done = true; clearTimeout(t); child.stdout?.destroy(); child.stderr?.destroy(); resolve({ code, out }); };
    const t = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } fin(null); }, timeoutMs);
    const add = (d: Buffer) => { if (out.length < 4000) out += d.toString('utf8'); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', () => fin(null)); child.on('exit', (c) => fin(c));
  });
}

/** `officecli validate` then, when that opens the file, `officecli view <f> issues`. */
export async function officecliVerdict(bin: string, file: Uint8Array, format: string, timeoutMs = 90_000): Promise<OfficeVerdict> {
  const dir = await mkdtemp(join(tmpdir(), 'mkt-diff-'));
  try {
    const f = join(dir, `in.${format}`);
    await writeFile(f, file);
    const v = await run(bin, ['validate', f], dir, timeoutMs);
    if (v.code !== 0) return classifyOfficecli(v, undefined);
    const i = await run(bin, ['view', f, 'issues'], dir, timeoutMs);
    return classifyOfficecli(v, i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Runs `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }));
  return out;
}
