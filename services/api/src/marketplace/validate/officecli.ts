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
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? dir, LANG: 'C.UTF-8' };
      const r = await new Promise<{ code: number | null; stderr: string; timedOut?: boolean; error?: string }>((resolve) => {
        let stderr = '', settled = false;
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: dir, env, detached: true });
        const finish = (v: { code: number | null; timedOut?: boolean; error?: string }) => {
          if (settled) return; settled = true; clearTimeout(timer);
          child.stderr?.destroy();
          resolve({ stderr, ...v });
        };
        const timer = setTimeout(() => {
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
          finish({ code: null, timedOut: true });
        }, timeoutMs);
        child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_STDERR) stderr += d.toString('utf8').slice(0, MAX_STDERR - stderr.length); });
        child.on('error', (e) => finish({ code: null, error: e.message }));
        child.on('exit', (code) => finish({ code }));
      });
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
