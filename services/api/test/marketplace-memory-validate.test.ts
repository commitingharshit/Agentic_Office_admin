// Plan 3 Task 5: the memory validator against the hostile corpus (evals/corpora/memory.ts), plus targeted assertions on the reasons.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import corpus from '../evals/corpora/memory.ts';
import { loadMemorySchemas, envNameProblem, hermesRelativePath, PROVIDER_HOSTS } from '../src/marketplace/validate/memory.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { TYPE_POLICY } from '../src/marketplace/support.ts';

const failed = async (c: { build(): any }) => (await validateArtifact('memory', c.build())).checks.filter((k) => !k.ok);

describe('memory validator: hostile corpus', () => {
  test('the corpus is not vacuous', () => { assert.ok(corpus.malicious.length >= 10); assert.ok(corpus.benign.length >= 5); });
  for (const c of corpus.malicious) test(`rejects ${c.id} (${c.category})`, async () => {
    const r = await validateArtifact('memory', c.build());
    assert.equal(r.ok, false, `${c.id}: ${c.note}`);
    assert.ok(r.checks.some((k) => !k.ok), c.id);
    assert.ok(!JSON.stringify(r).includes('hunter2'), 'never echoes a secret value');
  });
  for (const c of corpus.benign) test(`accepts ${c.id}`, async () => {
    const r = await validateArtifact('memory', c.build());
    assert.deepEqual(r.checks.filter((k) => !k.ok), [], c.note);
    assert.equal(r.ok, true);
    assert.equal(r.riskTier, 'declarative');
  });
});

describe('memory validator: the reasons are explicit', () => {
  const by = Object.fromEntries([...corpus.malicious].map((c) => [c.id, c]));
  const reason = async (id: string, check: string) => (await failed(by[id])).find((k) => k.name === check)?.detail ?? '';
  test('provider', async () => { assert.match(await reason('provider-not-bundled', 'provider-bundled'), /not a bundled memory provider/); });
  test('team scope', async () => { assert.match(await reason('scope-team', 'scope-supported'), /team scope is not supported/); });
  test('paths', async () => { assert.match(await reason('db-path-absolute', 'config-keys-known'), /\$HERMES_HOME/); assert.match(await reason('db-path-traversal', 'config-keys-known'), /\$HERMES_HOME/); });
  test('redirect', async () => { assert.match(await reason('exfil-attacker-host', 'config-keys-known'), /may not redirect memory traffic/); assert.match(await reason('exfil-metadata-url', 'config-keys-known'), /./); });
  test('claims', async () => {
    assert.match(await reason('claims-export', 'unsupported-claims'), /hermes backup/);
    assert.match(await reason('claims-migration', 'unsupported-claims'), /migration is not supported/);
    assert.match(await reason('claims-setup', 'unsupported-claims'), /installs packages/);
    assert.match(await reason('claims-plugin-code', 'unsupported-claims'), /user-installed provider code/);
  });
  test('env denylist', async () => {
    for (const id of ['secret-env-path', 'secret-env-hermes-home', 'secret-env-ld-preload']) assert.match(await reason(id, 'secrets-declared-only'), /process-control/, id);
  });
  test('files and size', async () => {
    assert.match(await reason('seed-file', 'only-allowed-files'), /file kind not allowed/);
    assert.equal((await failed(by['payload-5mb'])).some((k) => k.name === 'payload-bounded'), true);
  });
  test('permissions are implied by the provider', async () => {
    assert.match(await reason('remote-without-network-permission', 'permissions-match-payload'), /network.*api\.mem0\.ai/);
    assert.match(await reason('secret-undeclared-permission', 'permissions-match-payload'), /secrets\.use.*MEM0_API_KEY/);
  });
  test('data locality is declared for every accepted package', async () => {
    const loc = async (id: string) => (await validateArtifact('memory', corpus.benign.find((c) => c.id === id)!.build())).checks.find((k) => k.name === 'data-locality')?.detail;
    assert.match((await loc('holographic-local')) ?? '', /^local/);
    assert.match((await loc('mem0-declared-key')) ?? '', /^remote: .*api\.mem0\.ai/);
  });
});

describe('memory validator: helpers and the snapshot', () => {
  test('hermesRelativePath', () => {
    assert.equal(hermesRelativePath('$HERMES_HOME/a/b.db'), true);
    for (const v of ['$HERMES_HOME/', '$HERMES_HOME/../x', '$HERMES_HOME/a//b', '/etc/passwd', '$HERMES_HOME/.ssh/x', '${HERMES_HOME}/x', '$HERMES_HOME/a b']) assert.equal(hermesRelativePath(v), false, v);
  });
  test('envNameProblem', () => {
    assert.equal(envNameProblem('MEM0_API_KEY'), null);
    for (const v of ['PATH', 'HERMES_HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'lower', 'A-B', '', 5, null]) assert.ok(envNameProblem(v as any), String(v));
  });
  test('snapshot: the nine bundled providers; every remote one has a declared host; local ones have none', () => {
    const s = loadMemorySchemas();
    assert.deepEqual(Object.keys(s.providers).sort(), ['agentic', 'byterover', 'hindsight', 'holographic', 'honcho', 'mem0', 'openviking', 'retaindb', 'supermemory']);
    for (const [n, p] of Object.entries(s.providers)) assert.equal(!!PROVIDER_HOSTS[n], !p.local, n);
  });
  test('snapshot carries no values or secrets', () => {
    const raw = readFileSync(new URL('../src/marketplace/validate/memory-provider-schemas.json', import.meta.url), 'utf8');
    assert.ok(!/sk-[A-Za-z0-9]{10}/.test(raw));
  });
  test('policy: declarative, manual review', () => { assert.deepEqual([TYPE_POLICY.memory.riskTier, TYPE_POLICY.memory.manualReview], ['declarative', true]); });
});
