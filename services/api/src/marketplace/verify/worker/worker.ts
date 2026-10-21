// The verifier worker (marketplace Plan 4, Task 5): a separate process that claims verification jobs over the admin API,
// runs the heavy pipeline stages in a sandboxed child (sandbox.ts) and POSTs the result back. It holds one secret, the
// service token (a `verifier` role identity: it can claim jobs and deliver results, nothing else). The token is sent only
// in the Authorization header; it is never passed to the child, never put in a URL and never logged (all log lines pass
// through `redact`). The lease token is a second, per-job secret with the same handling.
import { createServer, type Server } from 'node:http';
import { sha256Hex } from '../../artifacts.ts';
import type { PipelineResult, StageResult } from '../types.ts';
import { deriveVerdict } from '../runner.ts';
import { runSandboxed, type Containment, type SandboxOptions, type SandboxOutcome } from './sandbox.ts';

export interface WorkerOptions {
  apiBase: string;                 // e.g. http://127.0.0.1:8787
  token: string;                   // service credential (Bearer)
  workerId: string;
  pollMs?: number;                 // idle poll interval (default 2000)
  leaseSec?: number;               // default 60; heartbeat at a third of it
  /** The sandboxed command. Default: this checkout's child.ts under the current node. Tests substitute a hostile child. */
  child?: { command: string; args: string[]; env?: Record<string, string> };
  sandbox?: Partial<Pick<SandboxOptions, 'timeoutMs' | 'maxStdoutBytes' | 'maxRssBytes' | 'cpuSeconds' | 'maxFileBytes' | 'denyFork' | 'requireSandbox' | 'workRoot' | 'denyNetwork' | 'jailWrites' | 'pollMs'>>;
  maxArtifactBytes?: number;       // default 64 MiB
  log?: (line: string) => void;
  fetch?: typeof fetch;
  healthPort?: number;             // 127.0.0.1:<port>/healthz when set
}

export interface WorkerHealth {
  status: 'idle' | 'busy' | 'stopping' | 'stopped'; workerId: string; startedAt: string; lastPollAt: string | null; lastHeartbeatAt: string | null;
  current: { jobId: string; versionId: string; attempt: number } | null; done: number; failed: number; retried: number; leaseLost: number;
}

type Json = Record<string, any>;
export class ApiFailure extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code; }
}

const SANDBOX_DEFAULTS = { timeoutMs: 90_000, maxStdoutBytes: 16 * 1024 * 1024, maxRssBytes: 2 * 1024 ** 3, maxFileBytes: 64 * 1024 * 1024 };
const childEntry = () => new URL('./child.ts', import.meta.url).pathname;

/** Sandbox failure -> a recorded `fail` (the package made the verifier die: hang, blow a limit, crash). Evidence is bounded text. */
export function failureResult(type: string, sha: string, o: SandboxOutcome, why: string, startedAt: string): PipelineResult {
  const stages: StageResult[] = [{
    id: 'sandbox', title: 'Sandboxed verifier', required: true, status: 'fail', reason: `sandbox:${why}`,
    evidence: [{ kind: 'log', label: 'sandbox outcome', detail: `reason=${why} exit=${o.exitCode ?? 'none'} signal=${o.signal ?? 'none'} ms=${o.durationMs} peakRssBytes=${o.peakRssBytes}` },
      ...(o.stderrTail ? [{ kind: 'log' as const, label: 'stderr tail (untrusted)', detail: o.stderrTail.slice(-1500) }] : [])],
    durationMs: Math.min(o.durationMs, 3_600_000),
  }];
  return { type: type as PipelineResult['type'], pipeline: 'verifier-worker', pipelineVersion: 0, subjectSha256: sha, verdict: deriveVerdict(stages), stages, env: {}, startedAt, finishedAt: new Date().toISOString() };
}
const describeContainment = (c: Containment) => `${c.sandbox}; net=${c.network}; writes=${c.writes}; fork=${c.fork}`;

export class VerifyWorker {
  readonly opts: WorkerOptions;
  private stopping = false; private loop?: Promise<void>; private wake?: () => void;
  private abort = new AbortController(); private server?: Server;
  private h: WorkerHealth;
  private f: typeof fetch;

  constructor(opts: WorkerOptions) {
    this.opts = opts; this.f = opts.fetch ?? fetch;
    this.h = { status: 'idle', workerId: opts.workerId, startedAt: new Date().toISOString(), lastPollAt: null, lastHeartbeatAt: null, current: null, done: 0, failed: 0, retried: 0, leaseLost: 0 };
  }
  health(): WorkerHealth { return { ...this.h, current: this.h.current && { ...this.h.current } }; }
  private secrets: string[] = [];
  private log(line: string) { this.opts.log?.(this.redact(line)); }
  private redact(s: string): string { let r = s; for (const x of [this.opts.token, ...this.secrets]) if (x) r = r.split(x).join('[redacted]'); return r; }

  // ── HTTP
  private async call(method: string, path: string, o: { body?: unknown; raw?: Uint8Array; mime?: string; lease?: string } = {}): Promise<{ status: number; json?: Json; bytes: Uint8Array }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}` };
    if (o.lease) headers['x-lease-token'] = o.lease;
    let body: any;
    if (o.raw) { headers['content-type'] = o.mime ?? 'application/octet-stream'; body = o.raw; }
    else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await this.f(this.opts.apiBase.replace(/\/$/, '') + '/admin/marketplace' + path, { method, headers, body, signal: AbortSignal.timeout(60_000) } as RequestInit);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let json: Json | undefined; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* binary */ }
    return { status: r.status, json, bytes };
  }
  private must(r: { status: number; json?: Json }, what: string): Json {
    if (r.status >= 200 && r.status < 300) return r.json ?? {};
    throw new ApiFailure(r.status, String(r.json?.code ?? 'http'), `${what}: ${r.status} ${String(r.json?.error ?? r.json?.message ?? '').slice(0, 200)}`);
  }

  // ── one iteration
  /** Claims and processes at most one job. 'idle' when the queue is empty. Never throws. */
  async runOnce(): Promise<'idle' | 'done' | 'failed' | 'lost' | 'error'> {
    this.h.lastPollAt = new Date().toISOString();
    let job: Json | null;
    try {
      job = this.must(await this.call('POST', '/verify-jobs/claim', { body: { worker: this.opts.workerId, leaseSec: this.opts.leaseSec ?? 60 } }), 'claim').job;
    } catch (e) { this.log(`claim failed: ${(e as Error).message}`); return 'error'; }
    if (!job) return 'idle';
    this.secrets.push(job.leaseToken);
    this.h.status = 'busy'; this.h.current = { jobId: job.id, versionId: job.versionId, attempt: job.attempts };
    this.log(`claimed ${job.id} (version ${job.versionId}, attempt ${job.attempts}/${job.maxAttempts})`);
    try { return await this.process(job); }
    finally { this.h.current = null; this.h.status = this.stopping ? 'stopping' : 'idle'; this.secrets = this.secrets.filter((x) => x !== job!.leaseToken); }
  }

  private async process(job: Json): Promise<'done' | 'failed' | 'lost' | 'error'> {
    const lease = job.leaseToken as string, id = job.id as string, leaseSec = (job.leaseSec as number) ?? 60;
    const jobAbort = new AbortController();
    const onGlobal = () => jobAbort.abort(); this.abort.signal.addEventListener('abort', onGlobal, { once: true });
    let lost = false;
    const hb = setInterval(async () => {
      try { this.must(await this.call('POST', `/verify-jobs/${id}/heartbeat`, { lease, body: { leaseSec } }), 'heartbeat'); this.h.lastHeartbeatAt = new Date().toISOString(); }
      catch (e) { if (e instanceof ApiFailure && e.code === 'lease_lost') { lost = true; jobAbort.abort(); } else this.log(`heartbeat failed: ${(e as Error).message}`); }
    }, Math.max(200, Math.floor((leaseSec * 1000) / 3)));
    const startedAt = new Date().toISOString();
    try {
      const art = await this.call('GET', `/verify-jobs/${id}/artifact`, { lease });
      if (art.status !== 200) throw new ApiFailure(art.status, String(art.json?.code ?? 'http'), `artifact: ${art.status}`);
      if (art.bytes.length > (this.opts.maxArtifactBytes ?? 64 * 1024 * 1024)) return await this.report(id, lease, 'fail-job', 'artifact-too-large');
      if (sha256Hex(art.bytes) !== job.sha256) return await this.report(id, lease, 'fail-job', 'artifact-sha-mismatch');

      const c = this.opts.child ?? { command: process.execPath, args: ['--max-old-space-size=1024', childEntry()] };
      const out = await runSandboxed({
        ...SANDBOX_DEFAULTS, ...defined(this.opts.sandbox), command: c.command, args: c.args, files: { 'package.zip': art.bytes },
        env: { ...(c.env ?? {}), VERIFY_JOB_SHA: job.sha256, VERIFY_JOB_TYPE: job.type, ...passEnv() }, signal: jobAbort.signal,
      });
      if (lost) { this.h.leaseLost++; this.log(`lease lost on ${id}; discarding`); return 'lost'; }
      if (out.reason === 'sandbox-unavailable' || out.reason === 'spawn-error') return await this.report(id, lease, 'fail-job', `${out.reason}: ${out.stderrTail}`.slice(0, 400));
      if (out.reason === 'aborted') return await this.report(id, lease, 'fail-job', 'worker-shutdown');

      let result: PipelineResult | undefined; let blobs: { mime: string; b64: string }[] = [];
      if (out.ok) {
        try {
          const parsed = JSON.parse(out.stdout.toString('utf8'));
          result = parsed.result; blobs = Array.isArray(parsed.blobs) ? parsed.blobs : [];
          if (!result || typeof result !== 'object' || !Array.isArray(result.stages)) throw new Error('no result');
        } catch { result = undefined; }
      }
      const whyFail = out.ok ? (result ? undefined : 'invalid-output') : out.reason === 'exit' ? `exit-${out.exitCode}` : out.reason === 'signal' ? `signal-${out.signal}` : out.reason!;
      if (whyFail || !result) result = failureResult(job.type, job.sha256, out, whyFail ?? 'invalid-output', startedAt);
      else blobs = blobs.slice(0, 40);
      // Never trust the child's claim about WHAT was verified: the subject is the job's artifact, and the env says how it was contained.
      result = { ...result, subjectSha256: job.sha256, type: job.type, env: { ...(result.env ?? {}), containment: describeContainment(out.containment).slice(0, 190) } };
      if (whyFail === undefined) {
        const uploaded = new Set<string>();
        for (const b of blobs) {
          if (typeof b?.b64 !== 'string') continue;
          const bytes = Buffer.from(b.b64, 'base64');
          const r = this.must(await this.call('POST', `/verify-jobs/${id}/blob`, { lease, raw: bytes, mime: String(b.mime) }), 'blob');
          uploaded.add(r.sha256);
        }
        for (const s of result.stages) for (const e of s.evidence ?? []) if (e.blob && !uploaded.has(e.blob.sha256)) { delete e.blob; }   // a reference to a blob that was never uploaded is dropped
      }
      return await this.report(id, lease, 'result', result);
    } catch (e) {
      if (lost) { this.h.leaseLost++; return 'lost'; }
      if (e instanceof ApiFailure && e.code === 'lease_lost') { this.h.leaseLost++; return 'lost'; }
      this.log(`job ${id} errored: ${(e as Error).message}`);
      return await this.report(id, lease, 'fail-job', `worker-error: ${(e as Error).message}`.slice(0, 400)).catch(() => 'error' as const);
    } finally { clearInterval(hb); this.abort.signal.removeEventListener('abort', onGlobal); }
  }

  private async report(id: string, lease: string, kind: 'result' | 'fail-job', payload: unknown): Promise<'done' | 'failed' | 'lost' | 'error'> {
    try {
      if (kind === 'result') {
        const r = this.must(await this.call('POST', `/verify-jobs/${id}/result`, { lease, body: payload }), 'result');
        this.h.done++; this.log(`result recorded for ${id}: ${r.verdict ?? 'recorded'}${r.duplicate ? ' (duplicate)' : ''}`);
        return 'done';
      }
      const r = this.must(await this.call('POST', `/verify-jobs/${id}/fail`, { lease, body: { error: String(payload) } }), 'fail');
      if (r.status === 'dead') this.h.failed++; else this.h.retried++;
      this.log(`job ${id} ${r.status}: ${String(payload).slice(0, 120)}`);
      return 'failed';
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'lease_lost') { this.h.leaseLost++; return 'lost'; }
      if (e instanceof ApiFailure && e.code === 'sha_mismatch') { this.h.failed++; return 'failed'; }
      if (e instanceof ApiFailure && kind === 'result' && e.status === 400) {
        // The server refused our result as malformed (a hostile child shaped it): hand the job back so it is retried or dead-lettered, never stuck.
        return this.report(id, lease, 'fail-job', `result-rejected: ${e.message}`);
      }
      this.log(`report failed for ${id}: ${(e as Error).message}`);
      return 'error';
    }
  }

  // ── lifecycle
  async start(): Promise<void> {
    if (this.opts.healthPort !== undefined) {
      this.server = createServer((req, res) => {
        if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(this.health())); } else { res.writeHead(404); res.end(); }
      });
      await new Promise<void>((r) => this.server!.listen(this.opts.healthPort, '127.0.0.1', r));
    }
    this.loop = (async () => {
      while (!this.stopping) {
        const r = await this.runOnce();
        if (this.stopping) break;
        if (r === 'idle' || r === 'error') await new Promise<void>((res) => { const t = setTimeout(res, this.opts.pollMs ?? 2000); this.wake = () => { clearTimeout(t); res(); }; });
      }
    })();
  }
  healthAddress(): number | undefined { const a = this.server?.address(); return a && typeof a === 'object' ? a.port : undefined; }

  /** Finishes the current job when it can within `graceMs`, otherwise kills its child and hands the job back for a retry. */
  async stop(graceMs = 10_000): Promise<void> {
    this.stopping = true; this.h.status = 'stopping'; this.wake?.();
    const timer = setTimeout(() => this.abort.abort(), graceMs);
    await this.loop?.catch(() => {});
    clearTimeout(timer);
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.h.status = 'stopped';
  }
}

/** Variables the worker deliberately forwards to the sandboxed child (never credentials). */
function passEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['SKILLS_GUARD', 'OFFICECLI_BIN', 'PERCEPTION_CHROME', 'VERIFY_MODULES', 'VERIFY_TOOLS_MODULE']) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
