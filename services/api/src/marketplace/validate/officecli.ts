// Optional render check: shells out to the allowlisted `officecli view <file> screenshot` invocation the desktop
// thumbnail service uses (apps/desktop/.../officeTemplatesThumbnailService.ts). spawn with an argument array, never a shell.
// The child runs in its own process group with a minimal environment (no server secrets; HOME is the service user's own home because officecli hangs forever on an empty HOME, verified), is killed as a group on
// timeout, and the call resolves on the timeout itself (never waits for stdio to close).
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type OfficeRenderer = (file: Uint8Array, format: string) => Promise<{ ok: boolean; detail?: string }>;

const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
const TIMEOUT_MS = 30_000;
const MAX_PNG = 20 * 1024 * 1024;
const MAX_STDERR = 2000;
const MAX_CONCURRENT = 2;

let active = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((r) => waiters.push(r)); // slot is handed over directly (active stays counted)
}
function release(): void { const w = waiters.shift(); if (w) w(); else active--; }

export interface SpawnResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; error?: string }
/** The one safe-spawn helper (also used by verify/tools/*): argument array (never a shell), own process group killed as a
 *  group on timeout or abort, minimal environment, stdout/stderr captured up to a cap, resolves on the timeout itself. */
export function spawnBounded(bin: string, args: string[], o: { cwd: string; timeoutMs: number; maxStdout?: number; maxStderr?: number; signal?: AbortSignal }): Promise<SpawnResult> {
  const maxOut = o.maxStdout ?? 0, maxErr = o.maxStderr ?? MAX_STDERR;
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? o.cwd, LANG: 'C.UTF-8' };
  return new Promise<SpawnResult>((resolve) => {
    let stdout = '', stderr = '', settled = false;
    if (o.signal?.aborted) { resolve({ code: null, stdout, stderr, timedOut: true }); return; }
    const child = spawn(bin, args, { stdio: ['ignore', maxOut > 0 ? 'pipe' : 'ignore', 'pipe'], cwd: o.cwd, env, detached: true });
    const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const finish = (v: { code: number | null; timedOut?: boolean; error?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort);
      child.stderr?.destroy(); child.stdout?.destroy();
      resolve({ stdout, stderr, ...v });
    };
    const onAbort = () => { kill(); finish({ code: null, timedOut: true }); };
    const timer = setTimeout(() => { kill(); finish({ code: null, timedOut: true }); }, o.timeoutMs);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < maxOut) stdout += d.toString('utf8').slice(0, maxOut - stdout.length); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < maxErr) stderr += d.toString('utf8').slice(0, maxErr - stderr.length); });
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('exit', (code) => finish({ code }));
  });
}
/** Runs fn inside the shared concurrency cap (2 children at a time across every officecli/kernel caller). */
export async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T> { await acquire(); try { return await fn(); } finally { release(); } }

export function officecliRenderer(opts: { bin?: string; timeoutMs?: number } = {}): OfficeRenderer {
  const bin = opts.bin ?? process.env.OFFICECLI_BIN ?? 'officecli';
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return async (file, format) => {
    if (!FORMATS.has(format)) return { ok: false, detail: `unsupported format ${format}` };
    await acquire();
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'mkt-officecli-'));
      const input = join(dir, `in.${format}`), out = join(dir, 'page1.png');
      await writeFile(input, file);
      const args = ['view', input, 'screenshot', '--out', out, '--page', '1', '--screenshot-width', '900', '--screenshot-height', '700'];
      const r = await spawnBounded(bin, args, { cwd: dir, timeoutMs, maxStdout: 0 });
      if (r.error) return { ok: false, detail: `could not run officecli: ${r.error}` };
      if (r.timedOut) return { ok: false, detail: `officecli timed out after ${timeoutMs} ms` };
      if (r.code !== 0) return { ok: false, detail: `officecli exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
      let png: Uint8Array;
      try {
        if ((await stat(out)).size > MAX_PNG) return { ok: false, detail: 'officecli screenshot is over the size cap' };
        png = await readFile(out);
      } catch { return { ok: false, detail: 'officecli produced no screenshot' }; }
      if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return { ok: false, detail: 'officecli output is not a PNG' };
      return { ok: true };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
      release();
    }
  };
}
