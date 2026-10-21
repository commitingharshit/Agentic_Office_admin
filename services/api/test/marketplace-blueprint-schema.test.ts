import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BLUEPRINT_SCHEMA, COMPONENT_KEYS, BlueprintError, parseBlueprint, parseBlueprintText, presentComponents } from '../src/marketplace/blueprint/schema.ts';

const DIR = fileURLToPath(new URL('./fixtures/blueprint-conformance/', import.meta.url));
const expected: Record<string, { ok: boolean; code?: string; path?: string }> = JSON.parse(readFileSync(join(DIR, 'expected.json'), 'utf8'));

function minimal(): any {
  return JSON.parse(readFileSync(join(DIR, 'valid-minimal.json'), 'utf8'));
}
function rejects(raw: unknown, code: string, path?: string) {
  assert.throws(() => parseBlueprint(raw), (e: any) => e instanceof BlueprintError && e.code === code && (path === undefined || e.path === path), `${code} ${path ?? ''}`);
}

test('minimal valid blueprint parses and round-trips', () => {
  const bp = parseBlueprint(minimal());
  assert.equal(bp.schema, BLUEPRINT_SCHEMA);
  assert.deepEqual(presentComponents(bp), []);
  assert.deepEqual(parseBlueprint(JSON.parse(JSON.stringify(bp))), bp);
});

test('ECS contract: eleven component keys, and only those may follow the four core keys', () => {
  assert.equal(COMPONENT_KEYS.length, 11);
  assert.equal(new Set(COMPONENT_KEYS).size, 11);
  const full = parseBlueprint(JSON.parse(readFileSync(join(DIR, 'valid-full.json'), 'utf8')));
  const extra = Object.keys(full).filter(k => !['schema', 'identity', 'objective', 'executionEnvironments'].includes(k));
  assert.deepEqual([...extra].sort(), [...COMPONENT_KEYS].sort());
  assert.deepEqual(presentComponents(full), [...COMPONENT_KEYS]);
  // the manifest payload type names components, never ECS machinery
  assert.ok(!COMPONENT_KEYS.some(k => /entity|system|ecs/i.test(k)));
});

test('no readOnly flag and no read-only/off modes (Task 0 amendments)', () => {
  const s = readFileSync(fileURLToPath(new URL('../src/marketplace/blueprint/schema.ts', import.meta.url)), 'utf8');
  assert.ok(!/readOnly\?|'read-only' \|/.test(s.replace(/\/\/.*$/gm, '')));
});

test('shared conformance corpus: every file is covered by expected.json and vice versa', () => {
  const files = readdirSync(DIR).filter(f => f !== 'expected.json').map(f => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(files, Object.keys(expected).sort());
  assert.ok(files.filter(f => f.startsWith('valid-')).length >= 4);
  assert.ok(files.filter(f => f.startsWith('invalid-')).length >= 80);
});

for (const [name, exp] of Object.entries(expected)) {
  test(`corpus ${name}`, () => {
    const text = readFileSync(join(DIR, `${name}.json`), 'utf8');
    if (exp.ok) { parseBlueprintText(text); return; }
    assert.throws(() => parseBlueprintText(text), (e: any) => {
      assert.ok(e instanceof BlueprintError, String(e));
      assert.equal(e.code, exp.code, `${name}: ${e.code} at ${e.path}`);
      if (exp.path !== undefined) assert.equal(e.path, exp.path, `${name} path`);
      return true;
    });
  });
}

test('oversized document is rejected before any nested value is visited', () => {
  const bomb = minimal();
  bomb.objective.successCriteria = Array.from({ length: 32 }, () => 'c'.repeat(499));
  bomb.identity.description = 'd'.repeat(1999);
  bomb.objective.goal = 'g'.repeat(1999);
  bomb.knowledgeSources = Array.from({ length: 32 }, () => ({ name: 'n'.repeat(80), kind: 'connector', ref: 'r'.repeat(190) }));
  let visited = false;
  // the trap sits after >64 KiB of earlier content, so a bounded walk must stop first
  bomb.zzTrap = {}; Object.defineProperty(bomb.zzTrap, 'x', { enumerable: true, get() { visited = true; throw new Error('getter visited'); } });
  bomb.verificationPolicy = { checks: Array.from({ length: 16 }, () => ({ name: 'n', kind: 'rubric', ref: 'r', when: 'each-edit', onFail: 'ask', maxAttempts: 1 })), requireEvidence: true };
  bomb.schedulingPolicy = { triggers: Array.from({ length: 16 }, () => ({ kind: 'schedule', schedule: 's', prompt: 'p'.repeat(1999) })) };
  assert.throws(() => parseBlueprint(bomb), (e: any) => e instanceof BlueprintError);
  assert.equal(visited, false);
});

test('accessor properties are refused, never invoked', () => {
  let called = false;
  const bp = minimal();
  Object.defineProperty(bp.identity, 'name', { enumerable: true, get() { called = true; return 'x'; } });
  rejects(bp, 'accessor', 'identity.name');
  assert.equal(called, false);
  const arrRaw = minimal(); arrRaw.executionEnvironments = ['desktop'];
  Object.defineProperty(arrRaw.executionEnvironments, 0, { get() { called = true; return 'desktop'; } });
  rejects(arrRaw, 'accessor');
  assert.equal(called, false);
});

test('only plain JSON values are accepted (classes, functions, NaN, undefined holes, sparse arrays)', () => {
  rejects(Object.assign(Object.create({ schema: BLUEPRINT_SCHEMA }), {}), 'not_json');
  rejects(new Map(), 'not_json');
  const f = minimal(); f.identity.name = () => 'x'; rejects(f, 'not_json', 'identity.name');
  const n = minimal(); n.modelPolicy = { primary: { provider: 'a', model: 'm' } }; n.delegationPolicy = { maxDepth: NaN, maxConcurrent: 1, children: [] }; rejects(n, 'not_json');
  const u = minimal(); u.identity.name = undefined; rejects(u, 'not_json', 'identity.name');
  const sp = minimal(); sp.executionEnvironments = new Array(2); rejects(sp, 'not_json');
  const bi = minimal(); bi.identity.name = 1n; rejects(bi, 'not_json', 'identity.name');
});

test('prototype pollution keys never reach Object.prototype and are rejected at any depth', () => {
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  const bp = minimal(); Object.defineProperty(bp, '__proto__', { value: polluted.__proto__, enumerable: true });
  rejects(bp, 'forbidden_key', '__proto__');
  assert.equal(({} as any).polluted, undefined);
  const nested = minimal(); nested.identity = JSON.parse('{"name":"x","constructor":{"prototype":{"p":1}}}');
  rejects(nested, 'forbidden_key', 'identity.constructor');
  assert.equal(({} as any).p, undefined);
});

test('parser output is a fresh object: mutating input afterwards cannot change it (no TOCTOU)', () => {
  const input = minimal();
  const out = parseBlueprint(input);
  input.identity.name = 'changed';
  assert.notEqual(out.identity.name, 'changed');
  assert.notEqual(out.identity, input.identity);
});

test('errors never echo the offending value (no secret reflection)', () => {
  const bp = minimal(); bp.objective.goal = 'sk-abcdefghijklmnopqrstuvwx1234';
  assert.throws(() => parseBlueprint(bp), (e: any) => e.code === 'secret_shape' && !e.message.includes('sk-abcdef'));
});

test('text entry point: byte cap is checked before JSON.parse', () => {
  const huge = '{"a":"' + 'x'.repeat(70_000) + '"}';
  const orig = JSON.parse; let parsed = false;
  JSON.parse = ((...a: any[]) => { parsed = true; return (orig as any)(...a); }) as any;
  try { assert.throws(() => parseBlueprintText(huge), (e: any) => e.code === 'too_large'); } finally { JSON.parse = orig; }
  assert.equal(parsed, false);
});

test('multibyte text counts bytes, not characters, against the cap', () => {
  const s = JSON.stringify(minimal()).replace('Summarises filings.', '日'.repeat(1990)) + ' '.repeat(40_000) + '日'.repeat(8000);
  assert.throws(() => parseBlueprintText(s), (e: any) => e.code === 'too_large');
});

test('desktop mirror does not drift from the schema (key list, constants, AgentBlueprint interface)', () => {
  const server = readFileSync(fileURLToPath(new URL('../src/marketplace/blueprint/schema.ts', import.meta.url)), 'utf8');
  const mirror = readFileSync(fileURLToPath(new URL('../../../apps/desktop/src/vs/platform/marketplace/common/agentBlueprint.ts', import.meta.url)), 'utf8');
  const keys = (s: string) => /export const COMPONENT_KEYS = \[([^\]]*)\]/.exec(s)![1].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(keys(mirror), [...COMPONENT_KEYS]);
  assert.deepEqual(keys(server), [...COMPONENT_KEYS]);
  for (const re of [/export const BLUEPRINT_SCHEMA = [^;]*;/, /export const blueprintFileName = [^;]*;/, /export const SOUL_FILE = [^;]*;/, /export type AgentPayload =[^;]*;/]) {
    assert.equal(mirror.match(re)?.[0].replace(/\s+/g, ''), server.match(re)?.[0].replace(/\s+/g, ''), String(re));
  }
  const iface = (s: string) => { const i = s.indexOf('export interface AgentBlueprint '); const j = s.indexOf('\nexport type AgentPayload', i); return s.slice(i, j).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ''); };
  assert.equal(iface(mirror), iface(server));
});
