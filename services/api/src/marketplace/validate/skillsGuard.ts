// The real skill security scanner: writes the skill to a throwaway directory and runs the Hermes Skills Guard
// (vendor/hermes-agent/tools/skills_scan_cli.py, a thin wrapper over skills_guard.scan_skill) as a child process, so
// there is one scanner, not two. Spawned with an argument array (no shell), a minimal environment, in its own process
// group that is killed as a group on timeout; stdout is capped. Community trust: any finding blocks (see skill.ts).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathProblem } from '../manifest.ts';
import type { SkillScanResult, SkillScanner } from './skill.ts';

const CLI_REL = join('vendor', 'hermes-agent', 'tools', 'skills_scan_cli.py');
const TIMEOUT_MS = 60_000;
const MAX_STDOUT = 1024 * 1024;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Walks up from this module to the directory holding vendor/hermes-agent/tools/skills_scan_cli.py. */
export function findRepoRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, CLI_REL))) return d;
    const up = dirname(d);
    if (up === d) throw new Error(`could not locate the repository root (${CLI_REL}) above ${from}; pass repoRoot explicitly`);
    d = up;
  }
}

export interface SkillsGuardOptions { repoRoot?: string; python?: string; timeoutMs?: number }

export function createSkillsGuardScanner(opts: SkillsGuardOptions = {}): SkillScanner {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return async (files, name): Promise<SkillScanResult> => {
    if (!NAME_RE.test(name) || name.length > 64) throw new Error(`unsafe skill name ${JSON.stringify(name)}`);
    const root = resolve(opts.repoRoot ?? findRepoRoot());
    const cli = join(root, CLI_REL);
    if (!existsSync(cli)) throw new Error(`skills scanner not found at ${cli}`);
    const base = await mkdtemp(join(tmpdir(), 'mkt-skill-scan-'));
    try {
      const skillDir = join(base, 'skill', name);
      await mkdir(skillDir, { recursive: true });
      await mkdir(join(base, 'hermes-home'), { recursive: true });
      for (const [rel, bytes] of files) {
        const problem = pathProblem(rel);
        const dest = resolve(skillDir, rel);
        if (problem || !dest.startsWith(skillDir + sep)) throw new Error(`unsafe path ${JSON.stringify(rel)}${problem ? ': ' + problem : ''}`);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: base, HERMES_HOME: join(base, 'hermes-home'),
        PYTHONPATH: join(root, 'vendor', 'hermes-agent'), PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8',
      };
      // No -I: it would drop PYTHONPATH, which is how the CLI finds tools.skills_guard. -B: never write .pyc into the repo.
      const args = ['-B', cli, '--source', 'community', '--json', skillDir];
      const out = await new Promise<string>((resolveOut, reject) => {
        let stdout = '', stderr = '', settled = false, over = false;
        const child = spawn(opts.python ?? 'python3', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: base, env, detached: true });
        const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
        const done = (err: Error | null, v = '') => { if (settled) return; settled = true; clearTimeout(timer); child.stdout?.destroy(); child.stderr?.destroy(); if (err) reject(err); else resolveOut(v); };
        const timer = setTimeout(() => { kill(); done(new Error(`skills scanner timed out after ${timeoutMs} ms`)); }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); if (stdout.length > MAX_STDOUT && !over) { over = true; kill(); done(new Error('skills scanner output exceeded 1 MiB')); } });
        child.stderr.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString('utf8').slice(0, 2000 - stderr.length); });
        child.on('error', (e) => done(new Error(`could not run ${opts.python ?? 'python3'}: ${e.message}`)));
        child.on('exit', (code) => { if (code === 0) done(null, stdout); else done(new Error(`skills scanner exited ${code}: ${stderr.trim().slice(0, 300)}`)); });
      });
      let j: any;
      try { j = JSON.parse(out); } catch { throw new Error('skills scanner printed invalid JSON'); }
      if (!j || !['safe', 'caution', 'dangerous'].includes(j.verdict) || !Array.isArray(j.findings)) throw new Error(`skills scanner returned an unexpected result${j?.error ? ': ' + String(j.error) : ''}`);
      return {
        verdict: j.verdict,
        findings: j.findings.map((f: any) => ({ category: String(f.category), severity: String(f.severity), file: String(f.file), ...(typeof f.line === 'number' ? { line: f.line } : {}), ...(typeof f.match === 'string' ? { match: f.match } : {}) })),
      };
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  };
}
