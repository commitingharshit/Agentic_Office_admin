// Optional render check: shells out to the allowlisted `officecli view <file> screenshot` invocation the desktop
// thumbnail service uses (apps/desktop/.../officeTemplatesThumbnailService.ts). spawn with an argument array, never a shell.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type OfficeRenderer = (file: Uint8Array, format: string) => Promise<{ ok: boolean; detail?: string }>;

const FORMATS = new Set(['docx', 'pptx', 'xlsx', 'pdf']);
const TIMEOUT_MS = 30_000;

export function officecliRenderer(opts: { bin?: string; timeoutMs?: number } = {}): OfficeRenderer {
  const bin = opts.bin ?? process.env.OFFICECLI_BIN ?? 'officecli';
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return async (file, format) => {
    if (!FORMATS.has(format)) return { ok: false, detail: `unsupported format ${format}` };
    const dir = await mkdtemp(join(tmpdir(), 'mkt-officecli-'));
    try {
      const input = join(dir, `in.${format}`), out = join(dir, 'page1.png');
      await writeFile(input, file);
      const args = ['view', input, 'screenshot', '--out', out, '--page', '1', '--screenshot-width', '900', '--screenshot-height', '700'];
      const r = await new Promise<{ code: number | null; stderr: string; timedOut: boolean; error?: string }>((resolve) => {
        let stderr = '', timedOut = false, settled = false;
        const done = (v: { code: number | null; error?: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stderr, timedOut, ...v }); };
        const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], cwd: dir });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString('utf8'); });
        child.on('error', (e) => done({ code: null, error: e.message }));
        child.on('close', (code) => done({ code }));
      });
      if (r.error) return { ok: false, detail: `could not run officecli: ${r.error}` };
      if (r.timedOut) return { ok: false, detail: `officecli timed out after ${timeoutMs} ms` };
      if (r.code !== 0) return { ok: false, detail: `officecli exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
      let png: Uint8Array;
      try { png = await readFile(out); } catch { return { ok: false, detail: 'officecli produced no screenshot' }; }
      if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return { ok: false, detail: 'officecli output is not a PNG' };
      return { ok: true };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
