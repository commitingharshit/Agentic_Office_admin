// A stand-in for the sandboxed child used by test/marketplace-verify-worker.test.ts. HOSTILE selects the behaviour.
// It is plain JS with no imports from the repo so it can run under any sandbox the test asks for.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const mode = process.env.HOSTILE ?? 'ok';
const sha = process.env.VERIFY_JOB_SHA, type = process.env.VERIFY_JOB_TYPE;
const stage = (o = {}) => ({ id: 'stub', title: 'Stub stage', required: true, status: 'pass', evidence: [], durationMs: 1, ...o });
const result = (o = {}) => ({ type, pipeline: 'template-basic', pipelineVersion: 1, subjectSha256: sha, verdict: 'pass', stages: [stage()], env: {},
  startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), ...o });
const emit = (r, blobs = []) => process.stdout.write(JSON.stringify({ result: r, blobs }));
const hold = () => new Promise(() => setInterval(() => {}, 1000));

switch (mode) {
  case 'ok': emit(result()); break;
  case 'hang': await hold(); break;
  case 'spin': for (;;) { /* burns CPU */ } 
  case 'alloc': { const keep = []; for (;;) { const b = Buffer.alloc(32 * 1024 * 1024, 1); keep.push(b); await new Promise((r) => setTimeout(r, 5)); } }
  case 'megabytes': { const chunk = 'A'.repeat(1024 * 1024); for (let i = 0; i < 64; i++) process.stdout.write(chunk); await hold(); break; }
  case 'exit3': process.stderr.write('boom: secret-looking text\n'); process.exit(3); break;
  case 'garbage': process.stdout.write('this is not json'); break;
  case 'spawn-orphans': {
    for (let i = 0; i < 3; i++) spawn('sleep', [`${process.env.ORPHAN_MARK}`], { detached: true, stdio: 'ignore' }).unref();
    await new Promise((r) => setTimeout(r, 500));   // long enough for the worker's poll to see them
    process.stdout.write('{}'); break;   // exits leaving three detached grandchildren (own sessions, outside the group) behind
  }
  case 'write-outside': {
    let wrote = false;
    try { writeFileSync(process.env.OUTSIDE_FILE, 'pwned'); wrote = true; } catch { /* denied */ }
    process.stdout.write(JSON.stringify({ wrote })); break;
  }
  case 'env-dump': {
    // an evil stage reporting everything it can see as evidence
    emit(result({ stages: [stage({ evidence: [{ kind: 'text', label: 'env', detail: JSON.stringify(process.env).slice(0, 2000) }] })] })); break;
  }
  case 'net': {
    const verdict = await new Promise((res) => {
      const s = net.connect({ host: '127.0.0.1', port: Number(process.env.NET_PORT) }, () => { s.destroy(); res('connected'); });
      s.on('error', () => res('denied'));
      setTimeout(() => res('denied'), 3000);
    });
    process.stdout.write(JSON.stringify({ verdict })); break;
  }
  case 'fork': {
    const r = spawnSync('/bin/echo', ['hi']);
    process.stdout.write(JSON.stringify({ spawned: !r.error && r.status === 0 })); break;
  }
  case 'readsecret': {
    let visible = false;
    try { visible = readFileSync(process.env.PROBE_FILE, 'utf8').length > 0; } catch { /* denied */ }
    process.stdout.write(JSON.stringify({ visible })); break;
  }
  case 'forged-score': emit(result({ stages: [stage({ evidence: [{ kind: 'check', label: 'x', measured: { name: 'a', value: 1, threshold: 1, op: '>=', score: 99 } }] })] })); break;
  case 'forged-verdict': emit(result({ stages: [stage({ status: 'fail', reason: 'really bad' })], verdict: 'pass' })); break;
  case 'ghost-blob': emit(result({ stages: [stage({ evidence: [{ kind: 'image', label: 'p', blob: { sha256: 'e'.repeat(64), mime: 'image/png', size: 4 } }] })] })); break;
  case 'other-subject': emit(result({ subjectSha256: 'f'.repeat(64) })); break;
  default: process.exit(9);
}
