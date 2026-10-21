// The in-sandbox half of a skill task evaluation (Plan 4 Task 6). Plain ESM, no imports from the repo: it runs inside the
// verifier sandbox (or, for the worker's own nested use, inside the worker child's sandbox, which every child inherits).
// Reads ./job.json from its cwd, lays the skill and the task inputs out under ./ws, runs the steps (the commands a scripted
// model chose, or the one `hermes` invocation of the real runner) with per-step time / output caps, then prints ONE json
// document: { transcript, outputs: [{ path, b64 }], exitCode, timedOut, incomplete }.
// The steps are untrusted code; the containment that matters (network denial, write jail, credential read denial, rlimits)
// is applied by sandbox.ts around THIS process. What this file adds: process-group kill, bounded transcript, bounded collection.
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const job = JSON.parse(readFileSync('job.json', 'utf8'));
const work = process.cwd();
const ws = join(work, 'ws');
const L = { stepOut: job.maxStepOutputBytes ?? 256 * 1024, transcript: job.maxTranscriptBytes ?? 64 * 1024, files: 40, file: 8 * 1024 * 1024, total: 24 * 1024 * 1024 };
const deadline = Date.now() + (job.timeoutMs ?? 60_000);
const inside = (root, p) => { const r = resolve(root, p); return r === root || r.startsWith(root + sep) ? r : undefined; };

function lay(prefix, files) {
  for (const [rel, b64] of Object.entries(files ?? {})) {
    const dst = inside(ws, join(prefix, rel));
    if (!dst) continue;                                  // a path that would leave the workspace is dropped, never written
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, Buffer.from(b64, 'base64'), { mode: 0o600 });
  }
}
mkdirSync(join(ws, 'out'), { recursive: true });
lay('skill', job.skill); lay('in', job.inputs);

let transcript = '', incomplete, timedOut = false, exitCode = 0;
const note = (s) => { if (transcript.length < L.transcript) transcript = (transcript + s).slice(0, L.transcript); };

function runStep(step) {
  return new Promise((done) => {
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; return done(124); }
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: work, TMPDIR: work, LANG: 'C', ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, String(v).split('${HOME}').join(work)])) };
    note(`$ ${step.argv.map((a) => String(a).slice(0, 200)).join(' ').slice(0, 400)}\n`);
    let child;
    try { child = spawn(step.argv[0], step.argv.slice(1).map(String), { cwd: ws, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { note(`[spawn failed: ${String(e.message).slice(0, 120)}]\n`); return done(127); }
    const out = []; let size = 0, capped = false, fin = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
    const take = (b) => { if (capped) return; size += b.length; if (size > L.stepOut) { capped = true; incomplete ??= 'step-output-cap'; kill(); return; } out.push(b); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(left, step.timeoutMs ?? left));
    const end = (code, sig) => {
      if (fin) return; fin = true; clearTimeout(timer); kill();   // anything the step left behind dies with its group
      const text = Buffer.concat(out);
      note(text.toString('utf8').slice(0, 8192) + (text.length > 8192 ? '\n[output truncated]\n' : '') + (capped ? '\n[step output cap reached, step killed]\n' : '') + (timedOut ? '\n[timeout]\n' : '') + `[exit ${code ?? sig}]\n`);
      if (step.stdoutTo && !capped) {
        const dst = inside(join(ws, 'out'), String(step.stdoutTo).replace(/^out\//, ''));
        if (dst) { try { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, text); } catch { /* recorded by the missing output */ } }
      }
      done(capped ? 125 : timedOut ? 124 : code ?? 128);
    };
    child.once('close', end); child.once('error', () => end(127, null));
    child.once('exit', (c, s) => setTimeout(() => end(c, s), 1500).unref());   // a grandchild holding the pipes cannot hold us
  });
}

for (const step of job.steps ?? []) {
  const code = await runStep(step);
  if (code !== 0) { exitCode = exitCode || code; if (!step.continueOnError) break; }
}

// collect ./ws/out: regular files only (a symlink is refused), depth <= 3, capped
const outputs = []; let total = 0;
(function walk(dir, rel, depth) {
  let names; try { names = readdirSync(dir); } catch { return; }
  for (const n of names.sort()) {
    const p = join(dir, n), r = rel ? rel + '/' + n : n;
    let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) { incomplete ??= 'symlink-in-output'; continue; }
    if (st.isDirectory()) { if (depth < 3) walk(p, r, depth + 1); else incomplete ??= 'output-too-deep'; continue; }
    if (!st.isFile()) { incomplete ??= 'special-file-in-output'; continue; }
    if (outputs.length >= L.files) { incomplete ??= 'too-many-output-files'; return; }
    if (st.size > L.file || total + st.size > L.total) { incomplete ??= 'output-over-size-cap'; continue; }
    total += st.size; outputs.push({ path: 'out/' + r, b64: readFileSync(p).toString('base64') });
  }
})(join(ws, 'out'), '', 0);

process.stdout.write(JSON.stringify({ transcript, outputs, exitCode, timedOut, ...(incomplete ? { incomplete } : {}) }));
