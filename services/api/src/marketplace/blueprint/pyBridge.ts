// JSON bridge to the Python blueprint compiler (vendor/hermes-agent/agent/office/blueprint/cli.py), built like the
// Skills Guard wrapper: spawn with an argument array (no shell), minimal environment, own process group killed as a
// group on timeout, capped stdout, throwaway temp HOME removed afterwards, injectable runner for tests.
// Fail closed, in two flavours:
//   {unavailable}  the bridge could not give an answer (no python, timeout, non-zero exit, crash): the caller records
//                  the required check as SKIPPED, so the report is never `verified`;
//   CheckResult ok:false  the bridge answered with garbage / oversize output / an `ok` without its evidence.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRepoRoot } from '../validate/skillsGuard.ts';
import type { BlueprintDiagnostic } from './schema.ts';
import type { ResolvedRefs } from './resolve.ts';
import type { PermissionRequest } from '../types.ts';

const MODULE_REL = join('vendor', 'hermes-agent', 'agent', 'office', 'blueprint', 'cli.py');
export const MAX_REQUEST = 1024 * 1024;
export const MAX_STDOUT = 1024 * 1024;
const CAPS = new Set(['fs.workspace.read', 'fs.workspace.write', 'network', 'exec.script', 'tool.invoke', 'secrets.use']);

export type ComponentState = 'enforced' | 'advisory' | 'unsupported' | 'empty';
export interface CompileReport { target: string; targetVersion: string; hermes: string; components: Record<string, { state: ComponentState; notes: string[] }>;
  unsupported: Array<{ component: string; path: string; reason: string; availableIn?: string }>; warnings: string[]; requiredCapabilities: PermissionRequest['capability'][] }
export interface DryRunReport { ok: boolean; steps: Array<{ name: string; ok: boolean; detail?: string }>; networkAttempts: 0 }
export interface CheckResult { ok: boolean; findings: BlueprintDiagnostic[]; report?: CompileReport; dryRun?: DryRunReport; skills?: string[] }

export interface BridgeRequest { op: 'check' | 'dryrun'; listingId: string; version: string; blueprint: Uint8Array; soul: Uint8Array; resolved: ResolvedRefs }
export type Bridge = (req: BridgeRequest) => Promise<CheckResult | { unavailable: string }>;
export interface RunInput { python: string; argv: string[]; stdin: string; env: Record<string, string>; cwd: string; timeoutMs: number; maxStdout: number }
export interface RunOutput { code: number | null; stdout: string; stderr: string; timedOut: boolean; overflow: boolean }
export type Runner = (i: RunInput) => Promise<RunOutput>;

export const spawnRunner: Runner = (i) => new Promise<RunOutput>((res) => {
  let stdout = '', stderr = '', settled = false, timedOut = false, overflow = false;
  let child: ReturnType<typeof spawn>;
  try { child = spawn(i.python, i.argv, { stdio: ['pipe', 'pipe', 'pipe'], cwd: i.cwd, env: i.env, detached: true }); }
  catch (e) { res({ code: null, stdout: '', stderr: String(e), timedOut: false, overflow: false }); return; }
  const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
  const done = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); child.stdout?.destroy(); child.stderr?.destroy(); res({ code, stdout, stderr, timedOut, overflow }); };
  const timer = setTimeout(() => { timedOut = true; kill(); done(null); }, i.timeoutMs);
  child.stdout!.on('data', (d: Buffer) => { stdout += d.toString('utf8'); if (stdout.length > i.maxStdout && !overflow) { overflow = true; kill(); done(null); } });
  child.stderr!.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString('utf8').slice(0, 2000 - stderr.length); });
  child.on('error', (e) => { stderr += String(e); done(null); });
  child.on('close', (code) => done(code));
  child.stdin!.on('error', () => { /* child exited early */ });
  child.stdin!.end(i.stdin);
});

/** What the compiler needs to know about the already-resolved references (names, hashes, declared capabilities, child toolsets). */
export function toBridgeResolved(r: ResolvedRefs): { skills: unknown[]; children: unknown[] } {
  const base = (x: ResolvedRefs['skills'][number]) => ({ id: x.id, version: x.version, sha256: x.sha256, name: x.skillName ?? x.id.split('/')[1] ?? x.id, permissions: (x.permissions ?? []).map(p => ({ capability: p.capability })) });
  return {
    skills: r.skills.map(base),
    children: r.children.map(c => ({ ...base(c), ...(c.blueprint?.toolPermissions ? { toolsets: c.blueprint.toolPermissions.toolsets } : {}) })),
  };
}

/** The dry run proves delegation is acyclic and within depth only from the children's own blueprints: it fails closed ("child blueprint not supplied")
 *  for an agent with any child unless every reachable child blueprint is in the request. Keyed by listing id, transitively. */
export function childBlueprints(r: ResolvedRefs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, a] of r.agents) if (a.blueprint) out[id] = a.blueprint;
  return out;
}

const garbage = (message: string): CheckResult => ({ ok: false, findings: [{ path: '', code: 'bridge_garbage', message: `compiler bridge: ${message}` }] });

function parseFindings(v: unknown): BlueprintDiagnostic[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out: BlueprintDiagnostic[] = [];
  for (const f of v) {
    if (!f || typeof f !== 'object') return null;
    const { path, code, message } = f as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return null;
    out.push({ path: typeof path === 'string' ? path.slice(0, 200) : '', code: code.slice(0, 80), message: message.slice(0, 500) });
  }
  return out;
}

/** Defensive parse of the CLI's stdout. Unknown fields are ignored; `ok:true` needs its evidence (report, or dryRun). */
export function parseBridgeOutput(stdout: string, op: BridgeRequest['op']): CheckResult | { unavailable: string } {
  if (stdout.length > MAX_STDOUT) return garbage('output too large');
  let j: any;
  try { j = JSON.parse(stdout); } catch { return garbage('output is not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.ok !== 'boolean') return garbage('unexpected response shape');
  const findings = parseFindings(j.findings ?? []);
  if (!findings) return garbage('malformed findings');
  if (findings.some(f => f.code === 'unknown_op')) return { unavailable: `compiler does not support ${op}` };
  if (!j.ok) return { ok: false, findings: findings.length ? findings : [{ path: '', code: 'rejected', message: 'compiler rejected the blueprint' }] };
  if (findings.length) return garbage('ok:true with findings');
  if (op === 'dryrun') {
    const d = j.dryRun ?? j.dryrun ?? j.report;
    if (!d || typeof d !== 'object' || d.ok !== true || !Array.isArray(d.steps) || d.networkAttempts !== 0) return garbage('ok:true without a passing dry-run report');
    return { ok: true, findings: [], dryRun: { ok: true, steps: d.steps.slice(0, 100).map((s: any) => ({ name: String(s?.name ?? '').slice(0, 80), ok: s?.ok === true, ...(typeof s?.detail === 'string' ? { detail: s.detail.slice(0, 300) } : {}) })), networkAttempts: 0 } };
  }
  const r = j.report;
  if (!r || typeof r !== 'object' || typeof r.target !== 'string' || !r.components || typeof r.components !== 'object' || !Array.isArray(r.requiredCapabilities) || !Array.isArray(r.unsupported)) return garbage('ok:true without a compile report');
  if (!r.requiredCapabilities.every((c: unknown) => typeof c === 'string' && CAPS.has(c))) return garbage('report names an unknown capability');
  if (!Array.isArray(j.skills) || !j.skills.every((s: any) => s && typeof s.id === 'string')) return garbage('ok:true without the skill install list');
  const report: CompileReport = {
    target: r.target, targetVersion: String(r.targetVersion ?? ''), hermes: String(r.hermes ?? ''),
    components: r.components, warnings: Array.isArray(r.warnings) ? r.warnings.map(String).slice(0, 50) : [],
    unsupported: r.unsupported.slice(0, 100).map((u: any) => ({ component: String(u?.component ?? ''), path: String(u?.path ?? ''), reason: String(u?.reason ?? ''), ...(typeof u?.availableIn === 'string' ? { availableIn: u.availableIn } : {}) })),
    requiredCapabilities: r.requiredCapabilities,
  };
  return { ok: true, findings: [], report, skills: j.skills.map((s: any) => s.id) };
}

export function createPythonBridge(opts: { python?: string; repoRoot?: string; timeoutMs?: number; runner?: Runner } = {}): Bridge {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const run = opts.runner ?? spawnRunner;
  return async (req): Promise<CheckResult | { unavailable: string }> => {
    let root: string;
    try { root = resolve(opts.repoRoot ?? findRepoRoot()); } catch (e) { return { unavailable: e instanceof Error ? e.message : String(e) }; }
    if (!opts.runner && !existsSync(join(root, MODULE_REL))) return { unavailable: `compiler not found at ${join(root, MODULE_REL)}` };
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const stdin = JSON.stringify({ op: req.op, listing_id: req.listingId, version: req.version, files: { 'blueprint.json': b64(req.blueprint), 'SOUL.md': b64(req.soul) }, resolved: toBridgeResolved(req.resolved), ...(req.op === 'dryrun' ? { child_blueprints: childBlueprints(req.resolved) } : {}) });
    if (Buffer.byteLength(stdin) > MAX_REQUEST) return garbage('request larger than 1 MiB');
    const base = await mkdtemp(join(tmpdir(), 'mkt-bp-'));
    try {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: base, HERMES_HOME: join(base, 'hermes-home'),
        PYTHONPATH: join(root, 'vendor', 'hermes-agent'), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8',
      };
      let out: RunOutput;
      try { out = await run({ python: opts.python ?? 'python3', argv: ['-B', '-m', 'agent.office.blueprint.cli', req.op], stdin, env, cwd: base, timeoutMs, maxStdout: MAX_STDOUT }); }
      catch (e) { return { unavailable: `bridge failed: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}` }; }
      if (out.timedOut) return { unavailable: `compiler timed out after ${timeoutMs} ms` };
      if (out.overflow) return garbage('output exceeded 1 MiB');
      if (out.code !== 0) return { unavailable: `compiler exited ${out.code}: ${out.stderr.trim().slice(0, 200)}` };
      return parseBridgeOutput(out.stdout, req.op);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  };
}
