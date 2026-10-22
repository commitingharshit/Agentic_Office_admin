// Client of the verifier service (services/verifier): the Hermes skill scanner and agent compiler run there, in their own
// container, and this process only sends requests. Same two shapes as the local child process, so the response parsing, the
// size caps and the fail-closed rules are the ones the local path already has:
//   Runner  (compiler bridge)  POST /compile {op, stdin}            -> {code, stdout, stderr, timedOut, overflow}
//   Scanner (skills guard)     POST /scan    {name, files: b64 map} -> {code, stdout, stderr, timedOut, overflow}
// A verifier that is down, slow or answering garbage is "unavailable" (the stage is skipped, the report is never `verified`).
import { pathProblem } from './manifest.ts';
import type { Runner, RunInput, RunOutput } from './blueprint/pyBridge.ts';
import { parseScanJson } from './validate/skillsGuard.ts';
import type { SkillScanner, SkillScanResult } from './validate/skill.ts';

type Fetch = typeof fetch;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_REPLY = 2 * 1024 * 1024;

function base(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('VERIFIER_URL must be http(s)');
  return u.toString().replace(/\/$/, '');
}

async function call(f: Fetch, url: string, body: unknown, timeoutMs: number): Promise<RunOutput> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs + 5_000);
  try {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (text.length > MAX_REPLY) throw new Error('verifier reply too large');
    if (!res.ok) throw new Error(`verifier answered ${res.status}`);
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || typeof j.stdout !== 'string' || typeof j.timedOut !== 'boolean' || typeof j.overflow !== 'boolean' || !(j.code === null || Number.isInteger(j.code))) throw new Error('verifier reply has the wrong shape');
    return { code: j.code, stdout: j.stdout, stderr: typeof j.stderr === 'string' ? j.stderr.slice(0, 2000) : '', timedOut: j.timedOut, overflow: j.overflow };
  } finally { clearTimeout(t); }
}

export function createVerifierRunner(url: string, f: Fetch = fetch): Runner {
  const root = base(url);
  return async (i: RunInput): Promise<RunOutput> => {
    const op = i.argv[i.argv.length - 1];
    if (op !== 'check' && op !== 'dryrun') throw new Error(`unsupported compiler op ${JSON.stringify(op)}`);
    return call(f, `${root}/compile`, { op, stdin: i.stdin }, i.timeoutMs);
  };
}

export function createVerifierScanner(opts: { url: string; timeoutMs?: number; fetch?: Fetch }): SkillScanner {
  const root = base(opts.url), f = opts.fetch ?? fetch, timeoutMs = opts.timeoutMs ?? 60_000;
  return async (files, name): Promise<SkillScanResult> => {
    if (!NAME_RE.test(name) || name.length > 64) throw new Error(`unsafe skill name ${JSON.stringify(name)}`);
    const tree: Record<string, string> = {};
    for (const [rel, bytes] of files) {
      const problem = pathProblem(rel);
      if (problem) throw new Error(`unsafe path ${JSON.stringify(rel)}: ${problem}`);
      tree[rel] = Buffer.from(bytes).toString('base64');
    }
    let out: RunOutput;
    try { out = await call(f, `${root}/scan`, { name, files: tree }, timeoutMs); }
    catch (e) { throw new Error(`skills scanner unreachable: ${e instanceof Error ? e.message : String(e)}`); }
    if (out.timedOut) throw new Error(`skills scanner timed out after ${timeoutMs} ms`);
    if (out.overflow) throw new Error('skills scanner output exceeded 1 MiB');
    if (out.code !== 0) throw new Error(`skills scanner exited ${out.code}: ${out.stderr.trim().slice(0, 300)}`);
    return parseScanJson(out.stdout);
  };
}

/** True when the verifier answers its health check (used by the startup self-check and the status prober). */
export async function verifierHealthy(url: string, f: Fetch = fetch): Promise<boolean> {
  try { const r = await f(`${base(url)}/healthz`, { signal: AbortSignal.timeout(3_000) }); return r.ok; } catch { return false; }
}
