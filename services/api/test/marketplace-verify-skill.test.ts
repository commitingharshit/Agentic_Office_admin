// Plan 4 Task 4: the skill pipeline's static stages (corpus, permissions, references, hostile inputs) and the gate-on
// integration for the skill type (creator auto-publish records its own verification first; the DB refuses otherwise).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex, unpack } from '../src/marketplace/artifacts.ts';
import { createListing, creatorDeps } from '../src/marketplace/creator.ts';
import type { PermissionRequest, UnpackedPackage } from '../src/marketplace/types.ts';
import { registerValidator } from '../src/marketplace/validate/index.ts';
import { createSkillsGuardScanner } from '../src/marketplace/validate/skillsGuard.ts';
import { createSkillValidator, type SkillScanner } from '../src/marketplace/validate/skill.ts';
import { memoryEvidenceSink } from '../src/marketplace/verify/evidence.ts';
import { assertNoScoreKeys, registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';
import { runPipeline, serializeResult } from '../src/marketplace/verify/runner.ts';
import { createSkillPipeline, registerSkillPipeline } from '../src/marketplace/verify/stages/skill/index.ts';
import type { PipelineResult, PipelineTools } from '../src/marketplace/verify/types.ts';
import { benign, malicious } from '../evals/run-scan-gate.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const fm = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n`;
const EXEC: PermissionRequest[] = [{ capability: 'exec.script', scope: 'scripts/*', reason: 'Runs the bundled helper.' }];
const NET: PermissionRequest = { capability: 'network', scope: 'api.example.com', reason: 'Calls the API.' };
const SEC: PermissionRequest = { capability: 'secrets.use', scope: 'API_TOKEN', reason: 'Reads the API token.' };

function zip(name: string, files: Record<string, string | Uint8Array>, permissions: PermissionRequest[] = [], declaredExtra: string[] = []): Uint8Array {
  const bytes: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) bytes[k] = typeof v === 'string' ? strToU8(v) : v;
  const manifest = { schema: 'agentic.marketplace/1', id: `u-u1/${name}`, type: 'skill', version: '1.0.0', title: name, summary: `The ${name} skill.`, license: 'MIT', compat: { app: '*' }, dependencies: [], permissions,
    files: [...Object.entries(bytes).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), ...declaredExtra.map((path) => ({ path, sha256: 'a'.repeat(64), size: 1 }))], payload: { name, entry: 'SKILL.md' } };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...bytes });
}
const pkgOf = (name: string, files: Record<string, string | Uint8Array>, perms: PermissionRequest[] = []): UnpackedPackage => unpack(zip(name, { 'SKILL.md': fm(name) + (files['SKILL.md'] ?? '# S\n'), ...files, ...(files['SKILL.md'] ? { 'SKILL.md': fm(name) + files['SKILL.md'] } : {}) }, perms));
const stage = (r: PipelineResult, id: string) => r.stages.find((s) => s.id === id)!;

const python = (() => { try { createSkillsGuardScanner(); return true; } catch { return false; } })();
const realScanner: PipelineTools = { scanner: createSkillsGuardScanner() };
const stubScanner: SkillScanner = async (files) => {
  const findings = [...files].filter(([, b]) => /rm -rf \/|curl [^\n|]*\| *sh/.test(new TextDecoder().decode(b))).map(([file]) => ({ category: 'destructive', severity: 'critical', file }));
  return { verdict: findings.length ? 'dangerous' : 'safe', findings };
};

before(() => { unregisterPipelineForTest('skill'); registerSkillPipeline(); });

describe('skill pipeline: corpus (real Skills Guard)', () => {
  test('stage list is explicit and starts with manifest', () => {
    assert.deepEqual(createSkillPipeline().stages.map((s) => s.id), ['manifest', 'spec', 'references', 'scan', 'permissions-consistency', 'tool-grounding', 'trigger-proxy', 'task-evals']);
  });
  test('all 12 benign skills pass (incomplete only if python3/scanner is absent); results carry no score', async () => {
    assert.equal(benign.length, 12);
    for (const c of benign) {
      const r = await runPipeline('skill', unpack(await c.build()), realScanner);
      assert.ok(r.verdict === 'pass' || (!python && r.verdict === 'incomplete'), `${c.id}: ${r.verdict} ${JSON.stringify(r.stages.filter((s) => s.status !== 'pass' && s.required).map((s) => [s.id, s.reason]))}`);
      assertNoScoreKeys(r);
    }
  });
  test('every malicious skill is rejected at unpack or fails the pipeline', async () => {
    assert.equal(malicious.length, 12);
    for (const c of malicious) {
      let pkg: UnpackedPackage;
      try { pkg = unpack(await c.build()); } catch { continue; }
      const r = await runPipeline('skill', pkg, realScanner);
      assert.equal(r.verdict, 'fail', `${c.id} was ${r.verdict}`);
    }
  });
});

describe('skill pipeline: static stages', () => {
  test('scripts without exec.script fail permissions-consistency while the scan still passes (the stage adds coverage)', async () => {
    const p = pkgOf('no-exec', { 'SKILL.md': 'Run scripts/run.sh\n', 'scripts/run.sh': '#!/bin/sh\necho hello\n' });
    const r = await runPipeline('skill', p, { scanner: stubScanner });
    assert.equal(stage(r, 'scan').status, 'pass');
    assert.equal(stage(r, 'permissions-consistency').status, 'fail');
    assert.match(stage(r, 'permissions-consistency').reason!, /exec\.script/);
    assert.equal(r.verdict, 'fail');
    const ok = await runPipeline('skill', pkgOf('with-exec', { 'SKILL.md': 'Run scripts/run.sh\n', 'scripts/run.sh': '#!/bin/sh\necho hello\n' }, EXEC), { scanner: stubScanner });
    assert.equal(stage(ok, 'permissions-consistency').status, 'pass'); assert.equal(ok.verdict, 'pass');
  });
  test('network code and secret reads need network / secrets.use; declared-but-unused is evidence only', async () => {
    const code = 'import os, requests\nrequests.get("https://api.example.com/x", headers={"k": os.environ["API_TOKEN"]})\n';
    const files = { 'SKILL.md': 'Run scripts/call.py\n', 'scripts/call.py': code };
    let r = await runPipeline('skill', pkgOf('net', files, EXEC), { scanner: stubScanner });
    assert.match(stage(r, 'permissions-consistency').reason!, /network.*secrets\.use|secrets\.use/);
    assert.equal(stage(r, 'permissions-consistency').status, 'fail');
    r = await runPipeline('skill', pkgOf('net2', files, [...EXEC, NET]), { scanner: stubScanner });
    assert.match(stage(r, 'permissions-consistency').reason!, /secrets\.use/);
    r = await runPipeline('skill', pkgOf('net3', files, [...EXEC, NET, SEC]), { scanner: stubScanner });
    assert.equal(stage(r, 'permissions-consistency').status, 'pass');
    r = await runPipeline('skill', pkgOf('unused', { 'SKILL.md': 'Just guidance.\n' }, [NET]), { scanner: stubScanner });
    const s = stage(r, 'permissions-consistency');
    assert.equal(s.status, 'pass'); assert.ok(s.evidence.some((e) => /declared but not detected/.test(e.label)));
  });
  test('references: dangling link, ../outside.md, absolute path, nested references/', async () => {
    const run = async (body: string, extra: Record<string, string> = {}) => {
      const p = pkgOf('refs', { 'SKILL.md': body, ...extra });
      return stage(await runPipeline('skill', p, { scanner: stubScanner }), 'references');
    };
    assert.equal((await run('See [x](references/a.md).\n', { 'references/a.md': '# a\n' })).status, 'pass');
    assert.match((await run('See [x](references/missing.md).\n')).reason!, /does not exist/);
    assert.match((await run('See [x](../outside.md).\n')).reason!, /escapes/);
    assert.match((await run('See [x](/etc/passwd).\n')).reason!, /escapes/);
    assert.match((await run('See [x](references/a/b.md).\n', { 'references/a/b.md': '# b\n' })).reason!, /flat|references/);
    assert.equal((await run('A [site](https://example.com/x) and [top](#top).\n')).status, 'pass');
  });
  test('scanner absent: scan is skipped (required), verdict incomplete, never pass', async () => {
    const r = await runPipeline('skill', pkgOf('plain', { 'SKILL.md': 'Hello.\n' }), {});
    assert.equal(stage(r, 'scan').status, 'skipped'); assert.equal(stage(r, 'scan').reason, 'tool-missing:scanner');
    assert.equal(r.verdict, 'incomplete');
    assert.equal(stage(r, 'tool-grounding').status, 'skipped'); assert.equal(stage(r, 'trigger-proxy').reason, 'no-example-prompts');
  });
  test('scanner crash fails closed; a hung scanner hits the stage deadline and the run continues', async () => {
    const boom: SkillScanner = async () => { throw new Error('python3 not found'); };
    let r = await runPipeline('skill', pkgOf('boom', { 'SKILL.md': 'Hi.\n' }), { scanner: boom });
    assert.equal(stage(r, 'scan').status, 'fail'); assert.match(stage(r, 'scan').reason!, /scanner-error/);
    unregisterPipelineForTest('skill'); registerPipeline(createSkillPipeline({ scanTimeoutMs: 60 }));
    try {
      const hung: SkillScanner = () => new Promise(() => {});
      r = await runPipeline('skill', pkgOf('hung', { 'SKILL.md': 'Hi.\n' }), { scanner: hung });
      assert.equal(stage(r, 'scan').status, 'fail'); assert.equal(stage(r, 'scan').reason, 'timeout');
      assert.equal(stage(r, 'permissions-consistency').status, 'pass');
    } finally { unregisterPipelineForTest('skill'); registerSkillPipeline(); }
  });
  test('oversized tree: the manifest stage fails it, and the stages refuse it on their own (scanner never called)', async () => {
    const p = pkgOf('big', { 'SKILL.md': 'Hi.\n' });
    for (let i = 0; i < 2100; i++) p.files.set(`references/f${i}.md`, strToU8('x'));
    let called = 0;
    const tools: PipelineTools = { scanner: async (f, n) => { called++; return stubScanner(f, n); } };
    const r = await runPipeline('skill', p, tools);
    assert.equal(called, 0); assert.equal(r.verdict, 'fail');
    assert.ok(Buffer.byteLength(serializeResult(r)) < 256 * 1024);
    // defence in depth: reached directly (no manifest gate in front), each tree-walking stage still refuses
    const ctx = { pkg: p, tools, evidence: memoryEvidenceSink(), signal: new AbortController().signal };
    for (const st of createSkillPipeline().stages.filter((x) => ['references', 'scan', 'permissions-consistency'].includes(x.id))) {
      const o = await st.run(ctx);
      assert.equal(o.status, 'fail', st.id); assert.match(o.reason!, /tree-too-large/);
    }
    assert.equal(called, 0);
  });
  test('ignore files and path tricks entering the stage directly fail', async () => {
    const ig = pkgOf('ign', { 'SKILL.md': 'Hi.\n', '.skillignore': 'scripts/*\n' });
    assert.equal(stage(await runPipeline('skill', ig, { scanner: stubScanner }), 'spec').status, 'fail');
    const esc = pkgOf('esc', { 'SKILL.md': 'Hi.\n' });
    esc.files.set('references/../../etc/passwd', strToU8('root'));
    esc.files.set('/abs/x.md', strToU8('x'));
    const r = await runPipeline('skill', esc, { scanner: stubScanner });
    assert.equal(stage(r, 'manifest').status, 'fail');
    assert.equal(stage(r, 'spec').status, 'skipped');   // prerequisite failed: nothing else trusts this tree
    assert.equal(r.verdict, 'fail');
  });
  test('a hostile filename or finding text stays data: evidence is clipped and never grows past the caps', async () => {
    const flood: SkillScanner = async () => ({ verdict: 'dangerous', findings: Array.from({ length: 500 }, (_, i) => ({ category: 'c', severity: 's', file: `<img src=x onerror=1>${i}`, line: i, match: 'M'.repeat(5000) })) });
    const r = await runPipeline('skill', pkgOf('flood', { 'SKILL.md': 'Hi.\n' }), { scanner: flood });
    const s = stage(r, 'scan');
    assert.equal(s.status, 'fail'); assert.ok(s.evidence.length <= 50);
    assert.ok(s.evidence.every((e) => (e.detail ?? '').length <= 2048));
    assert.ok(s.evidence[0].detail!.length < 140);
  });
});

describe('skill verification gate (real Postgres)', { skip }, () => {
  let h: MarketplacePg;
  const store = memoryArtifactStore();
  const mk = (name: string, extra: Record<string, string> = {}, perms: PermissionRequest[] = []) => zip(name, { 'SKILL.md': fm(name) + '# S\n\nDo it.\n', ...extra }, perms);
  const deps = (tools?: PipelineTools) => creatorDeps(h.pool('ao_app'), h.pool('ao_admin'), store, {}, tools);
  const required = (types: string[]) => h.owner.query('UPDATE marketplace_settings SET verification_required_types = $1', [types]);
  const rows = async (vid: string) => (await h.owner.query('SELECT verdict, sha256, run_by FROM marketplace_verifications WHERE version_id = $1 ORDER BY seq', [vid])).rows;

  before(async () => {
    h = await startMarketplacePg();
    await h.owner.query(`INSERT INTO users(id, email) VALUES ('u1','u1@example.test')`);
    registerValidator('skill', createSkillValidator({ scanner: stubScanner }));
  });
  after(async () => { registerValidator('skill', createSkillValidator()); if (h) await h.stop(); });

  test('gate off (the default): auto-publish is unchanged and records no verification', async () => {
    const c = await createListing(deps({ scanner: stubScanner }), 'u1', mk('off-skill'), { visibility: 'private', team: null });
    assert.equal(c.state, 'published'); assert.equal((await rows(c.versionId)).length, 0);
  });
  test('gate on for skill: the creator runs the pipeline first and stores a passing record for the sha before publishing', async () => {
    await required(['skill']);
    try {
      const bytes = mk('gated-ok');
      const c = await createListing(deps({ scanner: stubScanner }), 'u1', bytes, { visibility: 'private', team: null });
      assert.equal(c.state, 'published');
      const r = await rows(c.versionId);
      assert.equal(r.length, 1); assert.equal(r[0].verdict, 'pass'); assert.equal(r[0].sha256, sha256Hex(bytes)); assert.equal(r[0].run_by, 'creator:u1');
    } finally { await required([]); }
  });
  test('gate on: scanner unavailable => incomplete record, version stays submitted and cannot be published by SQL', async () => {
    await required(['skill']);
    try {
      const c = await createListing(deps({}), 'u1', mk('gated-noscan'), { visibility: 'private', team: null });
      assert.equal(c.state, 'submitted'); assert.equal(c.installable, false);
      assert.deepEqual((await rows(c.versionId)).map((x) => x.verdict), ['incomplete']);
      await assert.rejects(h.owner.query(`UPDATE marketplace_versions SET state = 'published' WHERE id = $1`, [c.versionId]), /needs pass/);
    } finally { await required([]); }
  });
  test('gate on: a pipeline failure the validator does not catch (undeclared network code) is rejected with the failing record kept', async () => {
    await required(['skill']);
    try {
      const c = await createListing(deps({ scanner: stubScanner }), 'u1', mk('gated-net', { 'references/x.md': '# x\n' }), { visibility: 'private', team: null });
      assert.equal(c.state, 'published');   // control: a clean skill
      const bad = await createListing(deps({ scanner: stubScanner }), 'u1', mk('gated-bad', { 'scripts/c.py': 'import requests\nrequests.get("https://x.example")\n' }, EXEC), { visibility: 'private', team: null });
      assert.equal(bad.state, 'rejected');
      const r = await rows(bad.versionId);
      assert.deepEqual(r.map((x) => x.verdict), ['fail']);
      await assert.rejects(h.owner.query(`UPDATE marketplace_versions SET state = 'approved' WHERE id = $1`, [bad.versionId]), /needs pass|verification/);
    } finally { await required([]); }
  });
  test('gate on and no skill pipeline registered: nothing publishes (fails closed)', async () => {
    await required(['skill']); unregisterPipelineForTest('skill');
    try {
      const c = await createListing(deps({ scanner: stubScanner }), 'u1', mk('gated-nopipe'), { visibility: 'private', team: null });
      assert.notEqual(c.state, 'published');
    } finally { registerSkillPipeline(); await required([]); }
  });
});
