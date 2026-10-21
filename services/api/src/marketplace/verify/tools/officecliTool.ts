// Real PipelineTools.officecli: validate / view issues / per-page screenshots, all through the shared spawnBounded helper
// (argument arrays, own process group, minimal env, stdout capped, timeouts). Input is untrusted: it is written to a private
// temp dir that is removed afterwards. Rendering is page by page (a multi-page --page range returns ONE stitched, cropped PNG).
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnBounded, withSpawnSlot } from '../../validate/officecli.ts';
import type { PipelineTools } from '../types.ts';

type Officecli = NonNullable<PipelineTools['officecli']>;
const FORMATS = new Set(['docx', 'pptx', 'xlsx']);
const MAX_PNG = 8 * 1024 * 1024;
const MAX_ISSUES = 500;

export class OfficecliError extends Error { constructor(msg: string) { super(msg); this.name = 'OfficecliError'; } }

/** The spawned child runs with a minimal PATH, so a bare name is resolved here against the parent's PATH (plus ~/.local/bin). */
export function resolveBin(name: string): string {
  if (name.includes('/')) return name;
  for (const d of [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]) { if (d && existsSync(join(d, name))) return join(d, name); }
  return name;
}

export function createOfficecliTool(opts: { bin?: string; timeoutMs?: number; perPageTimeoutMs?: number } = {}): Officecli {
  const bin = resolveBin(opts.bin ?? process.env.OFFICECLI_BIN ?? 'officecli');
  const timeoutMs = opts.timeoutMs ?? 90_000, perPage = opts.perPageTimeoutMs ?? 90_000; // generous: officecli needs seconds per call and far more on a loaded host
  const withFile = async <T>(file: Uint8Array, fmt: string, fn: (dir: string, input: string) => Promise<T>): Promise<T> => {
    if (!FORMATS.has(fmt)) throw new OfficecliError(`unsupported format ${fmt}`);
    return withSpawnSlot(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mkt-verify-oc-'));
      try { const input = join(dir, `in.${fmt}`); await writeFile(input, file); return await fn(dir, input); }
      finally { await rm(dir, { recursive: true, force: true }); }
    });
  };
  const run = async (dir: string, args: string[], t: number, signal?: AbortSignal) => {
    const r = await spawnBounded(bin, args, { cwd: dir, timeoutMs: t, maxStdout: 256 * 1024, signal });
    if (r.error) throw new OfficecliError(`could not run officecli: ${r.error}`);
    if (r.timedOut) throw new OfficecliError(`timeout: officecli did not finish within ${t} ms`);
    return r;
  };
  const jsonOf = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };
  return {
    async validate(file, fmt) {
      return withFile(file, fmt, async (dir, input) => {
        const r = await run(dir, ['validate', input, '--json'], timeoutMs);
        const j = jsonOf(r.stdout);
        const text = typeof j?.data === 'string' ? j.data : (j?.message ?? (r.stdout || r.stderr)).toString();
        return { ok: r.code === 0 && j?.success === true && /^validation passed/i.test(String(j.data ?? j.message ?? '')), output: text.slice(0, 16 * 1024) };
      });
    },
    async issues(file, fmt, types) {
      return withFile(file, fmt, async (dir, input) => {
        const r = await run(dir, ['view', input, 'issues', '--json', '--limit', String(MAX_ISSUES)], timeoutMs);
        const j = jsonOf(r.stdout);
        if (r.code !== 0 || !j?.success) throw new OfficecliError(`officecli view issues failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
        const list: unknown[] = Array.isArray(j.data?.issues) ? j.data.issues : [];
        const want = types ? new Set(types) : undefined;
        const out: { type: string; message: string; path?: string }[] = [];
        for (const i of list as Record<string, unknown>[]) {
          const type = String(i.subtype ?? i.type ?? 'unknown');
          if (want && !want.has(type)) continue;
          out.push({ type, message: String(i.message ?? '').slice(0, 300), ...(typeof i.path === 'string' ? { path: i.path.slice(0, 200) } : {}) });
        }
        return out;
      });
    },
    async renderPages(file, fmt, o) {
      return withFile(file, fmt, async (dir, input) => {
        const w = String(Math.min(Math.max(o.width ?? 900, 200), 1600)), h = String(Math.min(Math.max(o.height ?? 700, 200), 2400));
        const pages: { png: Uint8Array; page: number }[] = [];
        let total = 1;
        for (let page = 1; page <= Math.max(1, o.maxPages); page++) {
          if (o.signal?.aborted) throw new OfficecliError('timeout: render aborted');
          const out = join(dir, `page${page}.png`);
          const r = await run(dir, ['view', input, 'screenshot', '--page', String(page), '--out', out, '--screenshot-width', w, '--screenshot-height', h], perPage, o.signal);
          if (r.code !== 0) throw new OfficecliError(`officecli exited ${r.code} on page ${page}: ${r.stderr.trim().slice(0, 200)}`);
          const m = /\[pages\] total=(\d+)/.exec(r.stderr + r.stdout);
          if (m) total = Math.max(1, Math.min(Number(m[1]), 100_000));
          let size: number;
          try { size = (await stat(out)).size; } catch { throw new OfficecliError(`officecli produced no screenshot for page ${page}`); }
          if (size > MAX_PNG) throw new OfficecliError(`page ${page} screenshot is over the ${MAX_PNG} byte cap`);
          const png = new Uint8Array(await readFile(out));
          if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new OfficecliError(`page ${page} output is not a PNG`);
          pages.push({ png, page });
          if (page >= total) break; // docx/xlsx do not report a page count: their html render is one viewport, so page 1 is all there is
        }
        return { pages, totalPages: total };
      });
    },
  };
}

/** officecli available on this machine? (binary resolves and answers --version). Used by tests and defaultTools. */
export async function officecliAvailable(name = process.env.OFFICECLI_BIN ?? 'officecli'): Promise<boolean> {
  const bin = resolveBin(name);
  const dir = tmpdir();
  const r = await spawnBounded(bin, ['--version'], { cwd: dir, timeoutMs: 15_000, maxStdout: 256 });
  return !r.error && !r.timedOut && r.code === 0;
}
