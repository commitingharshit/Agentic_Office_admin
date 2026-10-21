// Real PipelineTools.kernel: runs a Rust kernel CLI against package bytes. Every call maps the file into a throwaway SQLite
// index first (`<kernel> map <file> --out <db>`), then runs the requested subcommand with `{db}` / `{doc}` / `{file}`
// substituted into args. A missing binary resolves { code: 127, stderr: 'tool-missing:<bin>' } so a stage can skip.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBounded, withSpawnSlot } from '../../validate/officecli.ts';
import { findRepoRoot } from '../../validate/skillsGuard.ts';
import type { PipelineTools } from '../types.ts';

type Kernel = NonNullable<PipelineTools['kernel']>;
export const KERNEL_BINARY: Record<'xlsx' | 'docpatch' | 'pptx' | 'pdf', string> = { xlsx: 'xlsx-context', docpatch: 'docpatch', pptx: 'pptx-context', pdf: 'pdf-context' };
const EXT: Record<string, string> = { xlsx: 'xlsx', docpatch: 'docx', pptx: 'pptx', pdf: 'pdf' };
const MAX_JSON = 1024 * 1024;

export function defaultKernelDir(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.VERIFY_KERNEL_DIR) return env.VERIFY_KERNEL_DIR;
  try { return join(findRepoRoot(), 'kernels', 'target', 'release'); } catch { return undefined; }
}

export function kernelBinaryPath(kernel: keyof typeof KERNEL_BINARY, dir = defaultKernelDir()): string | undefined {
  if (!dir) return undefined;
  const p = join(dir, KERNEL_BINARY[kernel]);
  return existsSync(p) ? p : undefined;
}

export function createKernelTool(opts: { dir?: string; timeoutMs?: number } = {}): Kernel {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async run(kernel, args, file) {
      const bin = kernelBinaryPath(kernel, opts.dir ?? defaultKernelDir());
      if (!bin) return { code: 127, stderr: `tool-missing:${KERNEL_BINARY[kernel]}` };
      return withSpawnSlot(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mkt-verify-k-'));
        try {
          const input = join(dir, `in.${EXT[kernel]}`), db = join(dir, 'index.db');
          await writeFile(input, file);
          const call = async (a: string[]) => {
            const r = await spawnBounded(bin, a, { cwd: dir, timeoutMs, maxStdout: MAX_JSON });
            let json: unknown;
            try { json = JSON.parse(r.stdout); } catch { /* not JSON: stderr explains */ }
            const stderr = r.error ? `could not run ${KERNEL_BINARY[kernel]}: ${r.error}` : r.timedOut ? `timeout: ${KERNEL_BINARY[kernel]} did not finish within ${timeoutMs} ms` : r.stderr;
            return { code: r.code ?? (r.timedOut ? 124 : 1), json, stderr: stderr.slice(0, 2000) };
          };
          const mapped = await call(['map', input, '--out', db]);
          if (args[0] === 'map') return mapped;
          if (mapped.code !== 0) return { code: mapped.code, stderr: `map failed: ${mapped.stderr}` };
          const doc = String((mapped.json as { doc_id?: unknown } | undefined)?.doc_id ?? input);
          return await call(args.map(a => a === '{db}' ? db : a === '{doc}' ? doc : a === '{file}' ? input : a));
        } finally { await rm(dir, { recursive: true, force: true }); }
      });
    },
  };
}
