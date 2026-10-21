// The production bridge adds the PINNED skill trees to dry-run requests (the compiler loads each referenced skill from its exact files).
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { describe, test } from 'node:test';
import { MANIFEST_NAME, memoryArtifactStore, putArtifact } from '../src/marketplace/artifacts.ts';
import { withSkillTrees } from '../src/marketplace/agents.ts';
import type { RunInput, RunOutput } from '../src/marketplace/blueprint/pyBridge.ts';

const out: RunOutput = { code: 0, stdout: '{}', stderr: '', timedOut: false, overflow: false };
const input = (op: string, resolved: unknown): RunInput => ({ python: 'python3', argv: ['-B', '-m', 'agent.office.blueprint.cli', op], stdin: JSON.stringify({ op, resolved }), env: {}, cwd: '/', timeoutMs: 1000, maxStdout: 1000 });
const capture = () => { const seen: RunInput[] = []; return { seen, run: async (i: RunInput) => { seen.push(i); return out; } }; };

describe('withSkillTrees', () => {
  test('dry-run requests carry the pinned tree of every resolved skill, without the manifest; check requests are untouched', async () => {
    const store = memoryArtifactStore();
    const zip = zipSync({ [MANIFEST_NAME]: strToU8('{}'), 'SKILL.md': strToU8('---\nname: s\n---\n'), 'references/a.md': strToU8('a') });
    const { sha256 } = await putArtifact(store, zip);
    const c = capture();
    const run = withSkillTrees(store, c.run);
    await run(input('dryrun', { skills: [{ id: 'acme/s', sha256 }], children: [] }));
    const sent = JSON.parse(c.seen[0].stdin);
    assert.deepEqual(Object.keys(sent.skills['acme/s']).sort(), ['SKILL.md', 'references/a.md']);
    assert.equal(Buffer.from(sent.skills['acme/s']['SKILL.md'], 'base64').toString(), '---\nname: s\n---\n');
    const chk = input('check', { skills: [{ id: 'acme/s', sha256 }] });
    await run(chk);
    assert.equal(c.seen[1].stdin, chk.stdin);
  });
  test('a tree that is missing, tampered with or not a zip is simply absent (the dry run then fails closed)', async () => {
    const store = memoryArtifactStore();
    const good = await putArtifact(store, zipSync({ 'SKILL.md': strToU8('x') }));
    const bad = 'b'.repeat(64);
    await store.put(bad, strToU8('this is not the content of that hash'));
    const junk = await putArtifact(store, strToU8('not a zip at all'));
    const c = capture();
    await withSkillTrees(store, c.run)(input('dryrun', { skills: [{ id: 'a/good', sha256: good.sha256 }, { id: 'a/tampered', sha256: bad }, { id: 'a/missing', sha256: 'c'.repeat(64) }, { id: 'a/junk', sha256: junk.sha256 }, { id: 5, sha256: 'x' }, null] }));
    assert.deepEqual(Object.keys(JSON.parse(c.seen[0].stdin).skills), ['a/good']);
  });
  test('no store, or a request that is not JSON: passed through unchanged; oversize trees are dropped, not truncated', async () => {
    const c = capture();
    const i = input('dryrun', { skills: [{ id: 'a/s', sha256: 'a'.repeat(64) }] });
    await withSkillTrees(undefined, c.run)(i);
    assert.equal(c.seen[0].stdin, i.stdin);
    await withSkillTrees(memoryArtifactStore(), c.run)({ ...i, stdin: 'not json' });
    assert.equal(c.seen[1].stdin, 'not json');
    const store = memoryArtifactStore();
    const big = await putArtifact(store, zipSync({ 'SKILL.md': new Uint8Array(900 * 1024).map((_, k) => (k * 7919) % 251) }, { level: 0 }));
    const small = await putArtifact(store, zipSync({ 'SKILL.md': strToU8('tiny') }));
    await withSkillTrees(store, c.run)(input('dryrun', { skills: [{ id: 'a/big', sha256: big.sha256 }, { id: 'a/small', sha256: small.sha256 }] }));
    assert.deepEqual(Object.keys(JSON.parse(c.seen[2].stdin).skills), ['a/small']);
  });
});
