// Runs ONE untrusted-input job in a contained child process and always returns an outcome (it never throws for anything the
// child does). Containment, strongest first (see okf/services/marketplace-verify-worker.md for what holds on which OS):
//   process group     detached child; the whole group is SIGKILLed on timeout / cap / abort / exit                    all POSIX
//   process tree      every descendant seen by the poll (even one that setsid()s out of the group) is SIGKILLed too  all POSIX, best effort:
//                     a process that double-forks and detaches inside one poll interval is NOT tracked; that gap is closed only by denyFork (macOS)
//   wall-clock        timeoutMs                                                                                       all POSIX
//   stdout cap        killed the moment the cap is crossed; stderr keeps only a short tail                            all POSIX
//   RSS cap           the group's resident memory is polled (`ps`) and the group killed above maxRssBytes             all POSIX
//   CPU + file size   `ulimit -t` / `ulimit -f` set by an exec wrapper                                               all POSIX
//   scrubbed env      only PATH/HOME/TMPDIR/LANG plus an explicit allowlist; no parent variable is inherited          all POSIX
//   throwaway cwd     a fresh directory, deleted afterwards                                                           all POSIX
//   network denied    macOS sandbox-exec `(deny network*)`; Linux `unshare -rn` when it works                         macOS, Linux if unshare
//   write jail        macOS sandbox-exec: writes only inside the workdir (and /dev/null)                              macOS only
//   fork denial       optional `(deny process-fork)`; off by default because stages legitimately run officecli/kernels macOS only
// macOS has no RLIMIT_AS/RLIMIT_NPROC that bound a user's processes, hence the RSS poll. A tool that is missing is reported in
// `containment`, never silently assumed; `requireSandbox` turns "cannot jail" into a refusal.
import { spawn, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SandboxOptions {
  command: string; args: string[];
  /** Files written into the workdir before the child starts (relative names only). */
  files?: Record<string, Uint8Array>;
  /** Extra environment for the child; the ONLY variables it gets besides PATH/HOME/TMPDIR/LANG. */
  env?: Record<string, string>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxRssBytes?: number;
  cpuSeconds?: number;
  maxFileBytes?: number;
  denyNetwork?: boolean;      // default true
  jailWrites?: boolean;       // default true
  denyFork?: boolean;         // default false
  denyReadPaths?: string[];   // default: common credential directories under $HOME
  requireSandbox?: boolean;   // refuse (reason 'sandbox-unavailable') when network/write containment cannot be applied
  signal?: AbortSignal;
  workRoot?: string;          // parent of the throwaway directory (default: the OS temp dir)
  pollMs?: number;
}
export type SandboxReason = 'timeout' | 'output-cap' | 'memory' | 'aborted' | 'signal' | 'exit' | 'spawn-error' | 'sandbox-unavailable';
export interface Containment { sandbox: 'sandbox-exec' | 'unshare' | 'none'; network: 'denied' | 'open'; writes: 'jailed' | 'open'; fork: 'denied' | 'open'; envScrubbed: true; limits: string[] }
export interface SandboxOutcome {
  ok: boolean; reason?: SandboxReason; exitCode: number | null; signal: string | null;
  stdout: Buffer; stderrTail: string; durationMs: number; peakRssBytes: number; containment: Containment; workdir: string;
}

const STDERR_TAIL = 4096;
export const DEFAULT_DENY_READ = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.docker', '.kube', '.netrc', 'Library/Keychains', '.claude', '.claude-personal'];

let probed: { sandboxExec: boolean; unshare: boolean } | undefined;
function probe(): { sandboxExec: boolean; unshare: boolean } {
  if (probed) return probed;
  let sandboxExec = false, unshare = false;
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    sandboxExec = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'], { timeout: 5000 }).status === 0;
  }
  if (process.platform === 'linux') {
    for (const u of ['/usr/bin/unshare', '/bin/unshare']) if (existsSync(u)) { unshare = spawnSync(u, ['-rn', '/bin/true'], { timeout: 5000 }).status === 0; if (unshare) break; }
  }
  return (probed = { sandboxExec, unshare });
}
export const resetProbeForTest = () => { probed = undefined; };

const sbQuote = (p: string) => { if (/["\\\0\n]/.test(p)) throw new Error('unsafe path for a sandbox profile'); return `"${p}"`; };
function profile(work: string, o: { network: boolean; writes: boolean; fork: boolean; deny: string[] }): string {
  const lines = ['(version 1)', '(allow default)'];
  if (o.network) lines.push('(deny network*)');
  if (o.writes) lines.push('(deny file-write*)', `(allow file-write* (subpath ${sbQuote(work)}) (literal "/dev/null") (literal "/dev/dtracehelper"))`);
  if (o.fork) lines.push('(deny process-fork)');
  for (const d of o.deny) lines.push(`(deny file-read* (subpath ${sbQuote(d)}))`);
  return lines.join('\n');
}

interface Row { pid: number; ppid: number; pgid: number; rss: number }
function snapshot(): Promise<Row[]> {
  return new Promise((res) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return res([]);
      res(out.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 4 && a.every(Number.isFinite)).map(([pid, ppid, pgid, rss]) => ({ pid, ppid, pgid, rss: rss * 1024 })));
    });
  });
}

export async function runSandboxed(o: SandboxOptions): Promise<SandboxOutcome> {
  const t0 = Date.now();
  const caps = probe();
  const wantNet = o.denyNetwork !== false, wantJail = o.jailWrites !== false, wantFork = o.denyFork === true;
  const root = o.workRoot ?? tmpdir();
  mkdirSync(root, { recursive: true });
  const base = realpathSync(root);
  const work = realpathSync(mkdtempSync(join(base, 'verify-job-')));
  const containment: Containment = {
    sandbox: caps.sandboxExec ? 'sandbox-exec' : caps.unshare ? 'unshare' : 'none',
    network: (caps.sandboxExec || caps.unshare) && wantNet ? 'denied' : 'open',
    writes: caps.sandboxExec && wantJail ? 'jailed' : 'open',
    fork: caps.sandboxExec && wantFork ? 'denied' : 'open',
    envScrubbed: true, limits: [],
  };
  const done = (p: Partial<SandboxOutcome> & { ok: boolean }): SandboxOutcome => {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    return { exitCode: null, signal: null, stdout: Buffer.alloc(0), stderrTail: '', durationMs: Date.now() - t0, peakRssBytes: 0, containment, workdir: work, ...p };
  };
  if (o.requireSandbox && ((wantNet && containment.network !== 'denied') || (wantJail && containment.writes !== 'jailed'))) {
    return done({ ok: false, reason: 'sandbox-unavailable', stderrTail: `cannot apply network/write containment on ${process.platform}` });
  }
  try {
    for (const [name, bytes] of Object.entries(o.files ?? {})) {
      if (name.includes('/') || name.includes('..') || name.startsWith('.')) throw new Error(`unsafe workdir file name ${name}`);
      writeFileSync(join(work, name), bytes, { mode: 0o600 });
    }
  } catch (e) { return done({ ok: false, reason: 'spawn-error', stderrTail: String((e as Error).message).slice(0, 300) }); }

  // exec wrapper: rlimits, then exec the real command (no extra process stays between us and the child)
  const cpu = Math.max(1, Math.trunc(o.cpuSeconds ?? Math.ceil(o.timeoutMs / 1000) + 5));
  const fileBlocks = Math.max(1, Math.ceil((o.maxFileBytes ?? 64 * 1024 * 1024) / 512));
  containment.limits.push(`cpu=${cpu}s`, `file=${fileBlocks * 512}B`, `wall=${o.timeoutMs}ms`, `stdout=${o.maxStdoutBytes}B`);
  if (o.maxRssBytes) containment.limits.push(`rss=${o.maxRssBytes}B`);
  const wrapped = ['/bin/sh', '-c', 'ulimit -t "$1"; ulimit -f "$2"; shift 2; exec "$@"', 'sh', String(cpu), String(fileBlocks), o.command, ...o.args];
  let argv: string[] = wrapped;
  if (caps.sandboxExec) {
    const deny = (o.denyReadPaths ?? DEFAULT_DENY_READ.map((d) => join(homedir(), d))).filter((p) => { try { return existsSync(p); } catch { return false; } }).map((p) => realpathSync(p));
    argv = ['/usr/bin/sandbox-exec', '-p', profile(work, { network: wantNet, writes: wantJail, fork: wantFork, deny }), ...wrapped];
  } else if (caps.unshare && wantNet) argv = ['/usr/bin/unshare', '-rn', ...wrapped];

  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: work, TMPDIR: work, LANG: 'C', ...(o.env ?? {}) };
  let child;
  try { child = spawn(argv[0], argv.slice(1), { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return done({ ok: false, reason: 'spawn-error', stderrTail: String((e as Error).message).slice(0, 300) }); }
  const pid = child.pid;
  if (!pid) return done({ ok: false, reason: 'spawn-error', stderrTail: 'no pid' });

  const out: Buffer[] = []; let outBytes = 0, tail = '', reason: SandboxReason | undefined, peak = 0, finished = false;
  const killGroup = () => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } };
  const stop = (why: SandboxReason) => { if (!reason) reason = why; killGroup(); };
  child.stdout.on('data', (b: Buffer) => {
    if (reason) return;
    outBytes += b.length;
    if (outBytes > o.maxStdoutBytes) { stop('output-cap'); return; }
    out.push(b);
  });
  child.stderr.on('data', (b: Buffer) => { tail = (tail + b.toString('utf8')).slice(-STDERR_TAIL); });
  child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
  const timer = setTimeout(() => stop('timeout'), o.timeoutMs);
  const onAbort = () => stop('aborted');
  if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
  const known = new Set<number>([pid]);
  const track = (rows: Row[]) => {   // grow `known` to the group plus every descendant; returns the group's resident bytes
    let grew = true, rss = 0;
    while (grew) { grew = false; for (const r of rows) if (!known.has(r.pid) && (r.pgid === pid || known.has(r.ppid))) { known.add(r.pid); grew = true; } }
    for (const r of rows) if (known.has(r.pid)) rss += r.rss;
    return rss;
  };
  let polling = false;
  const poll = setInterval(async () => {
    if (polling || finished) return; polling = true;
    try { const r = track(await snapshot()); peak = Math.max(peak, r); if (o.maxRssBytes && r > o.maxRssBytes) stop('memory'); } finally { polling = false; }
  }, o.pollMs ?? 100);

  const exit = await new Promise<{ code: number | null; sig: string | null; spawnError?: string }>((res) => {
    let settled = false;
    const fin = (v: { code: number | null; sig: string | null; spawnError?: string }) => { if (!settled) { settled = true; res(v); } };
    child.once('error', (e) => fin({ code: null, sig: null, spawnError: e.message }));
    child.once('close', (code, sig) => fin({ code, sig }));
    child.once('exit', (code, sig) => { setTimeout(() => fin({ code, sig }), 2000).unref(); });   // grandchildren holding the pipes cannot keep us waiting
  });
  finished = true; clearTimeout(timer); clearInterval(poll);
  o.signal?.removeEventListener('abort', onAbort);
  killGroup();   // anything the job left behind dies with its group
  const rows = await snapshot(); track(rows);
  for (const r of rows) if (known.has(r.pid) && r.pid !== process.pid) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }   // detached descendants
  child.stdout.destroy(); child.stderr.destroy();
  const base_ = { stdout: Buffer.concat(out), stderrTail: tail, exitCode: exit.code, signal: exit.sig, peakRssBytes: peak };
  if (exit.spawnError) return done({ ...base_, ok: false, reason: 'spawn-error', stderrTail: exit.spawnError.slice(0, 300) });
  if (reason) return done({ ...base_, ok: false, reason });
  if (exit.sig) return done({ ...base_, ok: false, reason: 'signal' });
  if (exit.code !== 0) return done({ ...base_, ok: false, reason: 'exit' });
  return done({ ...base_, ok: true });
}
