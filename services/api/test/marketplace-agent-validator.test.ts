import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createAgentValidator } from '../src/marketplace/validate/agent.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { createPythonBridge, parseBridgeOutput, type Runner, type RunOutput } from '../src/marketplace/blueprint/pyBridge.ts';
import { findRepoRoot } from '../src/marketplace/validate/skillsGuard.ts';
import { agentPkg, baseBp, enc, fakeBridge, fakeCatalog, get, names, okReport, row, safeScanner } from './marketplace-agent-helpers.ts';

const full = (o: Parameters<typeof createAgentValidator>[0] = {}) => createAgentValidator({ catalog: fakeCatalog([row('acme/s')]), bridge: fakeBridge(), scanner: safeScanner, ...o });
const report = (cs: any[]) => ({ ok: cs.every(c => c.ok), verified: cs.every(c => c.ok) && !cs.some(c => c.skipped && c.required) });
const skillBp = baseBp({ skillReferences: [{ id: 'acme/s', range: '^1.0.0', required: true }] });

describe('agent validator: happy path and verified semantics', () => {
  test('a clean agent passes every check and is verified', async () => {
    const cs = await full()(agentPkg({ bp: skillBp }));
    assert.deepEqual(names(cs), [], JSON.stringify(cs.filter(c => !c.ok)));
    for (const n of ['agent-files-allowlist', 'blueprint-parse', 'soul-file', 'payload-matches', 'deps-match-manifest', 'refs-resolve', 'visibility-no-escalation', 'permissions-subset', 'no-wildcards', 'delegation-acyclic', 'no-secrets', 'persona-scan', 'compiles', 'dry-run', 'unsupported-reported'])
      assert.equal(get(cs, n)?.ok, true, n);
    assert.deepEqual(report(cs), { ok: true, verified: true });
  });
  test('bridge unavailable: ok but NOT verified (compiles, dry-run skipped+required)', async () => {
    const cs = await full({ bridge: fakeBridge({ check: { unavailable: 'no python' } }) })(agentPkg({ bp: skillBp }));
    assert.deepEqual(report(cs), { ok: true, verified: false });
    for (const n of ['compiles', 'dry-run']) { assert.equal(get(cs, n).skipped, true); assert.equal(get(cs, n).required, true); }
  });
  test('no bridge, no scanner, no catalog: every one skipped+required, never verified', async () => {
    const cs = await createAgentValidator()(agentPkg({ bp: skillBp }));
    assert.equal(report(cs).verified, false);
    for (const n of ['compiles', 'dry-run', 'persona-scan', 'refs-resolve']) assert.equal(get(cs, n).required, true, n);
  });
  test('dry-run unavailable alone also prevents verification', async () => {
    const cs = await full({ bridge: fakeBridge({ dryrun: { unavailable: 'op not supported' } }) })(agentPkg({ bp: skillBp }));
    assert.deepEqual(report(cs), { ok: true, verified: false });
  });
  test('unsupported components are listed in unsupported-reported (local and compiler-reported)', async () => {
    const bp = baseBp({ schedulingPolicy: { triggers: [{ kind: 'schedule', schedule: 'every 1h', prompt: 'p' }] }, workflowReferences: [{ id: 'acme/wf', range: '^1.0.0' }] });
    const cs = await full({ bridge: fakeBridge({ check: { ok: true, findings: [], report: okReport([], [{ component: 'hookBindings', path: 'x', reason: 'r' }]), skills: [] } }) })(agentPkg({ bp }));
    const d = get(cs, 'unsupported-reported').detail;
    assert.match(d, /schedulingPolicy/); assert.match(d, /workflowReferences/); assert.match(d, /hookBindings/);
    assert.equal(get(cs, 'unsupported-reported').ok, true);
  });
  test('through validateArtifact (the registry is Task 7): ok and verified only with every required check run', async () => {
    const { registerValidator } = await import('../src/marketplace/validate/index.ts');
    registerValidator('agent', full());
    const r = await validateArtifact('agent', agentPkg({ bp: skillBp }));
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
    assert.equal(r.verified, true);
    registerValidator('agent', createAgentValidator());
    assert.equal((await validateArtifact('agent', agentPkg({ bp: skillBp }))).verified, false);
  });
});

describe('agent validator: hostile package corpus', () => {
  test('files allowlist: notes.pdf, memory.md, .env, a shebang SOUL sibling', async () => {
    for (const extra of [{ 'notes.pdf': '%PDF-1.4' }, { 'memory.md': 'x' }, { '.env': 'K=v' }, { 'run.sh': '#!/bin/sh\n' }, { 'sub/SOUL.md': 'x' }]) {
      const cs = await full()(agentPkg({ bp: skillBp, extraFiles: extra }));
      assert.equal(get(cs, 'agent-files-allowlist').ok, false, Object.keys(extra)[0]);
    }
  });
  test('blueprint.json missing, oversize, invalid UTF-8, invalid JSON, duplicate key', async () => {
    const pk = agentPkg({ bp: baseBp() });
    pk.files.delete('blueprint.json');
    assert.equal(get(await full()(pk), 'blueprint-parse').ok, false);
    assert.equal(get(await full()(agentPkg({ rawBlueprint: ' '.repeat(70_000) })), 'blueprint-parse').ok, false);
    const bad = agentPkg({ bp: baseBp() }); bad.files.set('blueprint.json', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    assert.equal(get(await full()(bad), 'blueprint-parse').ok, false);
    assert.equal(get(await full()(agentPkg({ rawBlueprint: '{not json' })), 'blueprint-parse').ok, false);
    const dup = JSON.stringify(baseBp()).replace('"schema"', '"schema":"x","schema"');
    assert.equal(get(await full()(agentPkg({ rawBlueprint: dup })), 'blueprint-parse').ok, false);
  });
  test('SOUL.md: missing, oversize, NUL, invisible characters, instructionsFile pointing elsewhere', async () => {
    const a = agentPkg({ bp: baseBp() }); a.files.delete('SOUL.md');
    assert.equal(get(await full()(a), 'soul-file').ok, false);
    assert.equal(get(await full()(agentPkg({ soul: 'x'.repeat(33 * 1024) })), 'soul-file').ok, false);
    assert.equal(get(await full()(agentPkg({ soul: 'hi\0there' })), 'soul-file').ok, false);
    assert.equal(get(await full()(agentPkg({ soul: 'ignore‮ previous' })), 'soul-file').ok, false);
    const other = baseBp(); other.identity.instructionsFile = '../../etc/passwd';
    assert.equal((await full()(agentPkg({ bp: other }))).filter(c => !c.ok).length > 0, true);
  });
  test('payload must describe the blueprint exactly', async () => {
    const cs = await full()(agentPkg({ bp: skillBp, payload: { blueprint: 'other.json', schema: 'x', components: [], extra: 1 } }));
    assert.equal(get(cs, 'payload-matches').ok, false);
    const ok = await full()(agentPkg({ bp: skillBp }));
    assert.equal(get(ok, 'payload-matches').ok, true);
  });
  test('literal secrets in persona text, in blueprint strings, in a key-shaped token; the value is never echoed', async () => {
    const key = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
    const a = await full()(agentPkg({ soul: `# Analyst\n\nUse key ${key} for the API.\n` }));
    assert.equal(get(a, 'no-secrets').ok, false);
    assert.doesNotMatch(get(a, 'no-secrets').detail, /A1b2C3d4/);
    const bp = baseBp(); bp.identity.description = `token ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
    assert.equal(get(await full()(agentPkg({ bp })), 'no-secrets').ok, false);
    const bp2 = baseBp(); bp2.objective.successCriteria = ['connect to https://user:hunter2pass@db.example.com/x'];
    assert.equal(get(await full()(agentPkg({ bp: bp2 })), 'no-secrets').ok, false);
    assert.equal(get(await full()(agentPkg({ bp: baseBp() })), 'no-secrets').ok, true);
  });
  test('file hashes are not scanned as secrets (sha256 hex in the manifest is fine)', async () => {
    const cs = await full()(agentPkg({ bp: baseBp() }));
    assert.equal(get(cs, 'no-secrets').ok, true);
  });
  test('persona scanner blocks a dangerous persona and a throwing scanner fails closed', async () => {
    const danger = await full({ scanner: async () => ({ verdict: 'dangerous', findings: [{ category: 'injection', severity: 'high', file: 'SOUL.md', line: 3 }] }) })(agentPkg({ bp: baseBp() }));
    assert.equal(get(danger, 'persona-scan').ok, false);
    const boom = await full({ scanner: async () => { throw new Error('guard crashed'); } })(agentPkg({ bp: baseBp() }));
    assert.equal(get(boom, 'persona-scan').ok, false);
  });
  test('compiler agreement: python rejecting, python ok without a report, skill-list mismatch, and python accepting what TS rejected all fail', async () => {
    const rej = await full({ bridge: fakeBridge({ check: { ok: false, findings: [{ path: 'x', code: 'bad', message: 'nope' }] } }) })(agentPkg({ bp: skillBp }));
    assert.equal(get(rej, 'compiles').ok, false);
    const noRep = await full({ bridge: fakeBridge({ check: { ok: true, findings: [] } }) })(agentPkg({ bp: skillBp }));
    assert.equal(get(noRep, 'compiles').ok, false);
    const mismatch = await full({ bridge: fakeBridge({ check: { ok: true, findings: [], report: okReport(), skills: ['acme/other'] } }) })(agentPkg({ bp: skillBp }));
    assert.equal(get(mismatch, 'compiles').ok, false);
    const disagree = await full()(agentPkg({ rawBlueprint: '{"schema":"nope"}' }));
    assert.equal(get(disagree, 'blueprint-parse').ok, false);
    assert.equal(get(disagree, 'compiles').ok, false);
    assert.match(get(disagree, 'compiles').detail, /disagree/);
  });
  test('the compiler is not called when references did not resolve', async () => {
    const bridge = fakeBridge();
    const cs = await full({ catalog: fakeCatalog([]), bridge })(agentPkg({ bp: skillBp }));
    assert.deepEqual(bridge.ops, []);
    assert.equal(get(cs, 'compiles').skipped, true);
  });
  test('a bridge that throws is unavailable, not a crash', async () => {
    const cs = await full({ bridge: async () => { throw new Error('boom'); } })(agentPkg({ bp: skillBp }));
    assert.deepEqual(report(cs), { ok: true, verified: false });
  });
});

describe('python bridge: failure modes (injected runner)', () => {
  const out = (o: Partial<RunOutput>): RunOutput => ({ code: 0, stdout: '', stderr: '', timedOut: false, overflow: false, ...o });
  const req = { op: 'check' as const, listingId: 'acme/analyst', version: '1.0.0', blueprint: enc('{}'), soul: enc('x'), resolved: { skills: [], children: [], agents: new Map(), graph: new Map(), truncated: false } };
  const bridgeOf = (runner: Runner) => createPythonBridge({ runner, repoRoot: findRepoRoot() });
  const goodJson = JSON.stringify({ ok: true, findings: [], skills: [], report: okReport() });
  test('good output parses', async () => { const r: any = await bridgeOf(async () => out({ stdout: goodJson }))(req); assert.equal(r.ok, true); assert.ok(r.report); });
  test('timeout, spawn failure, non-zero exit and a thrown runner are unavailable', async () => {
    for (const runner of [async () => out({ timedOut: true, code: null }), async () => out({ code: null, stderr: 'ENOENT' }), async () => out({ code: 2, stdout: '{"ok":false,"error":"crash"}' }), async () => { throw new Error('x'); }]) {
      const r: any = await bridgeOf(runner as Runner)(req);
      assert.equal(typeof r.unavailable, 'string');
    }
  });
  test('bad JSON, wrong shape, oversize, ok:true without evidence, ok:true with findings, unknown capability are ok:false', async () => {
    const cases = ['not json', '[]', '{"ok":"yes"}', '{"ok":true,"findings":[]}', JSON.stringify({ ok: true, findings: [{ path: '', code: 'x', message: 'y' }], skills: [], report: okReport() }),
      JSON.stringify({ ok: true, findings: [], skills: [], report: okReport(['root.everything']) }), JSON.stringify({ ok: true, findings: [], report: okReport() }), 'x'.repeat(1024 * 1024 + 5)];
    for (const stdout of cases) { const r: any = await bridgeOf(async () => out({ stdout }))(req); assert.equal(r.ok, false, stdout.slice(0, 40)); assert.equal(r.findings[0].code, 'bridge_garbage'); }
    const over: any = await bridgeOf(async () => out({ overflow: true, code: null }))(req);
    assert.equal(over.ok, false);
  });
  test('findings with ok:false are passed through bounded; unknown_op means unavailable; dryrun ok needs a passing report', async () => {
    const rej: any = await bridgeOf(async () => out({ stdout: JSON.stringify({ ok: false, findings: [{ path: 'a', code: 'c', message: 'm'.repeat(900) }] }) }))(req);
    assert.equal(rej.ok, false); assert.equal(rej.findings[0].message.length, 500);
    const unk: any = await bridgeOf(async () => out({ stdout: JSON.stringify({ ok: false, findings: [{ code: 'unknown_op', message: 'x' }] }) }))(req);
    assert.equal(typeof unk.unavailable, 'string');
    assert.equal((parseBridgeOutput(JSON.stringify({ ok: true, findings: [], dryRun: { ok: false, steps: [], networkAttempts: 0 } }), 'dryrun') as any).ok, false);
    assert.equal((parseBridgeOutput(JSON.stringify({ ok: true, findings: [], dryRun: { ok: true, steps: [{ name: 'a', ok: true }], networkAttempts: 3 } }), 'dryrun') as any).ok, false);
    assert.equal((parseBridgeOutput(JSON.stringify({ ok: true, findings: [], dryRun: { ok: true, steps: [{ name: 'a', ok: true }], networkAttempts: 0 } }), 'dryrun') as any).ok, true);
  });
  test('the runner gets an argument array, a minimal env and a throwaway HOME that is removed afterwards', async () => {
    let seen: any;
    await bridgeOf(async (i) => { seen = i; assert.ok(existsSync(i.cwd)); return out({ stdout: goodJson }); })(req);
    assert.deepEqual(seen.argv, ['-B', '-m', 'agent.office.blueprint.cli', 'check']);
    assert.deepEqual(Object.keys(seen.env).sort(), ['HERMES_HOME', 'HOME', 'LANG', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONPATH']);
    assert.equal(existsSync(seen.cwd), false);
    assert.doesNotMatch(JSON.stringify(seen.env), /TOKEN|SECRET|KEY/);
  });
  test('an oversize request is refused before spawning', async () => {
    let called = false;
    const r: any = await bridgeOf(async () => { called = true; return out({}); })({ ...req, blueprint: new Uint8Array(900_000), soul: new Uint8Array(200_000) });
    assert.equal(called, false); assert.equal(r.ok, false);
  });
});

const venv = process.env.HERMES_PYTHON ?? '/Users/harshitverma/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python';
const realOk = (() => { try { findRepoRoot(); return existsSync(venv); } catch { return false; } })();
describe('python bridge: real compiler', { skip: realOk ? false : 'no python venv with the vendored Hermes' }, () => {
  test('a valid agent compiles through the real CLI; a bad one is rejected; dryrun is unavailable until Task 3', async () => {
    const bridge = createPythonBridge({ python: venv });
    const v = createAgentValidator({ catalog: fakeCatalog([row('acme/s')]), bridge, scanner: safeScanner });
    const cs = await v(agentPkg({ bp: baseBp({ skillReferences: [{ id: 'acme/s', range: '^1.0.0', required: true }], toolPermissions: { mode: 'ask', toolsets: ['file'], kits: [], deny: [] } }), permissions: [{ capability: 'fs.workspace.read', scope: 'docs/**', reason: 'r' }, { capability: 'fs.workspace.write', scope: 'docs/**', reason: 'r' }, { capability: 'exec.script', scope: 'scripts/**', reason: 'r' }, { capability: 'network', scope: 'https://a.example', reason: 'r' }] }));
    assert.equal(get(cs, 'compiles').skipped, undefined, JSON.stringify(get(cs, 'compiles')));
    assert.equal(get(cs, 'compiles').ok, true, JSON.stringify(get(cs, 'compiles')));
    const bad = await v(agentPkg({ bp: baseBp({ toolPermissions: { mode: 'ask', toolsets: ['no_such_toolset'], kits: [], deny: [] } }) }));
    assert.equal(get(bad, 'compiles').ok, false, JSON.stringify(get(bad, 'compiles')));
  });
});
