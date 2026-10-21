import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUNDLE_LIMITS, BundleError, parseBundle, parseBundleText } from '../src/marketplace/bundle/schema.ts';
import { topoOrder } from '../src/marketplace/bundle/plan.ts';
import { bundleOf, member } from './helpers/bundle-fixtures.ts';

const good = () => JSON.parse(JSON.stringify(bundleOf([member('acme/a'), member('acme/b')])));
const code = (raw: unknown) => { try { parseBundle(raw); return 'ok'; } catch (e) { assert.ok(e instanceof BundleError, String(e)); return (e as BundleError).code; } };

describe('parseBundle', () => {
  test('accepts a good bundle and normalises it', () => {
    const b = parseBundle(good());
    assert.equal(b.items.length, 2); assert.deepEqual(b.teamScope, { kind: 'none' });
  });
  test('hostile corpus', () => {
    const mut = (f: (b: any) => void) => { const b = good(); f(b); return b; };
    const cases: Array<[string, unknown, string]> = [
      ['range instead of pin', mut((b) => { b.items[0].version = '^1.0.0'; }), 'not_pinned'],
      ['tilde range', mut((b) => { b.items[0].version = '~1.0.0'; }), 'not_pinned'],
      ['x-range', mut((b) => { b.items[0].version = '1.x'; }), 'not_pinned'],
      ['latest', mut((b) => { b.items[0].version = 'latest'; }), 'not_pinned'],
      ['short sha', mut((b) => { b.items[0].sha256 = 'abc'; }), 'bad_sha256'],
      ['upper sha', mut((b) => { b.items[0].sha256 = 'A'.repeat(64); }), 'bad_sha256'],
      ['bad id', mut((b) => { b.items[0].id = 'Acme/Thing'; }), 'bad_id'],
      ['reserved slug', mut((b) => { b.items[0].id = 'acme/versions'; }), 'bad_id'],
      ['path-ish id', mut((b) => { b.items[0].id = '../x/y'; }), 'bad_id'],
      ['unknown type', mut((b) => { b.items[0].type = 'plugin'; }), 'bad_type'],
      ['duplicate item', mut((b) => { b.items[1].id = 'acme/a'; }), 'duplicate'],
      ['confusable ids', mut((b) => { b.items[0].id = 'acme/pdf-tool'; b.items[1].id = 'acme/pdftool'; }), 'confusable_id'],
      ['unknown item key', mut((b) => { b.items[0].url = 'https://x.example'; }), 'unknown_key'],
      ['unknown top key', mut((b) => { b.credentials = {}; }), 'unknown_key'],
      ['wrong schema', mut((b) => { b.schema = 'agentic.bundle/2'; }), 'schema'],
      ['empty items', mut((b) => { b.items = []; }), 'items'],
      ['51 items', mut((b) => { b.items = Array.from({ length: 51 }, (_, i) => ({ ...b.items[0], id: `acme/m${i}x${'y'.repeat(i % 3)}${i}` })); }), 'too_many_items'],
      ['non-string order', mut((b) => { b.installOrder = [1]; }), 'install_order'],
      ['team without id', mut((b) => { b.teamScope = { kind: 'team' }; }), 'team_scope'],
      ['none with team id', mut((b) => { b.teamScope = { kind: 'none', teamId: 't1' }; }), 'team_scope'],
      ['bad team id', mut((b) => { b.teamScope = { kind: 'team', teamId: '../x' }; }), 'team_scope'],
      ['long notes', mut((b) => { b.notes = 'x'.repeat(BUNDLE_LIMITS.maxNotes + 1); }), 'notes'],
      ['array root', [], 'not_object'],
      ['null', null, 'not_object'],
      ['string', 'x', 'not_object'],
      ['deep', JSON.parse('{"a":'.repeat(20) + '1' + '}'.repeat(20)), 'unbounded'],
    ];
    for (const [name, raw, want] of cases) assert.equal(code(raw), want, name);
  });
  test('prototype pollution keys are rejected from JSON text', () => {
    const t = '{"schema":"agentic.bundle/1","items":[],"installOrder":[],"teamScope":{"kind":"none"},"__proto__":{"x":1}}';
    assert.throws(() => parseBundleText(t), BundleError);
    assert.equal(({} as any).x, undefined);
  });
  test('oversized and non-JSON text', () => {
    assert.throws(() => parseBundleText('x'.repeat(BUNDLE_LIMITS.maxBytes + 1)), /exceeds/);
    assert.throws(() => parseBundleText('{nope'), /not valid JSON/);
  });
});

describe('topoOrder', () => {
  test('orders dependencies first, deterministically', () => {
    const g = new Map([['c', ['a', 'b']], ['b', ['a']], ['a', []], ['d', []]]);
    assert.deepEqual(topoOrder(g), ['a', 'b', 'c', 'd']);
  });
  test('reports a cycle without recursing', () => {
    const r = topoOrder(new Map([['a', ['b']], ['b', ['a']]]));
    assert.ok(!Array.isArray(r)); assert.deepEqual((r as any).cycle, ['a', 'b', 'a']);
  });
  test('a long chain does not overflow the stack', () => {
    const g = new Map<string, string[]>();
    for (let i = 0; i < 20000; i++) g.set(`n${i}`, i ? [`n${i - 1}`] : []);
    assert.equal((topoOrder(g) as string[]).length, 20000);
  });
});
