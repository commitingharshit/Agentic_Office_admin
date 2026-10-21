import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CARD_BYTES, validateAction, validateCard } from '../src/card.ts';

const good = {
  v: 1, layout: 'stack', tone: 'accent', disclosure: 'Featured',
  blocks: [
    { type: 'badge', text: 'New' },
    { type: 'heading', text: '  Build an LBO model faster  ' },
    { type: 'text', text: 'A verified finance toolkit.' },
    { type: 'image', media: 'poster', alt: 'The toolkit open on a model' },
    { type: 'metric', label: 'Time saved', value: '3h' },
    { type: 'checklist', items: ['Sources and uses', 'Debt schedule'] },
  ],
  actions: [
    { label: 'Explore', action: { command: 'open_marketplace_item', arg: 'lbo-toolkit' } },
    { label: 'Not now', action: { command: 'dismiss' } },
  ],
};

test('a well-formed card validates and comes back clean (trimmed, same content)', () => {
  const r = validateCard(good);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal((r.value!.blocks[1] as { text: string }).text, 'Build an LBO model faster');
  assert.equal(r.value!.actions!.length, 2);
});

test('unknown fields, html-ish payloads and scripts have nowhere to go', () => {
  assert.equal(validateCard({ ...good, onClick: 'alert(1)' }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'html', html: '<script>alert(1)</script>' }] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'image', media: 'https://evil.example/x.png', alt: 'x' }] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'heading', text: 'x', style: 'color:red' }] }).ok, false);
});

test('actions are the fixed list, with arguments of the right shape', () => {
  assert.equal(validateAction({ command: 'run_shell', arg: 'rm -rf /' }).ok, false);
  assert.equal(validateAction({ command: 'open_url', arg: 'http://example.com' }).ok, false);
  assert.equal(validateAction({ command: 'open_url', arg: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateAction({ command: 'open_url', arg: 'https://user:pw@example.com' }).ok, false);
  assert.equal(validateAction({ command: 'open_url', arg: 'https://agenticoffice.ai/toolkit' }).ok, true);
  assert.equal(validateAction({ command: 'open_settings', arg: 'workbench.colorTheme' }).ok, false);
  assert.equal(validateAction({ command: 'open_settings', arg: 'agenticOffice.promotions.enabled' }).ok, true);
  assert.equal(validateAction({ command: 'open_plans', arg: 'x' }).ok, false);
  assert.equal(validateAction({ command: 'insert_prompt', arg: 'Build me an LBO model' }).ok, true);
});

test('limits: sizes, counts, and a card must say something', () => {
  assert.equal(validateCard({ ...good, blocks: [{ type: 'heading', text: 'x'.repeat(81) }] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: Array(9).fill({ type: 'text', text: 'x' }) }).ok, false);
  assert.equal(validateCard({ ...good, actions: [good.actions[0], good.actions[0], good.actions[1]] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'badge', text: 'New' }] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'text', text: 'y'.repeat(MAX_CARD_BYTES) }] }).ok, false);
  assert.equal(validateCard({ ...good, v: 2 }).ok, false);
});

test('control characters and bidi overrides cannot hide or reorder words', () => {
  const rlo = String.fromCharCode(0x202e), nul = String.fromCharCode(0);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'heading', text: `Pay ${rlo}gnp.exe` }] }).ok, false);
  assert.equal(validateCard({ ...good, blocks: [{ type: 'text', text: `a${nul}b` }] }).ok, false);
});

test('garbage in never throws', () => {
  for (const v of [null, undefined, 42, 'card', [], { v: 1 }, { v: 1, layout: 'stack', blocks: 'x' }, { v: 1, layout: 'stack', blocks: [null] }]) {
    const r = validateCard(v);
    assert.equal(r.ok, false);
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(validateCard(cyclic).ok, false);
});

test('fuzz: thousands of mutated cards never throw, and anything accepted is clean and stable under a second validation', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const junk: unknown[] = [null, undefined, 0, -1, 1e999, NaN, '', ' ', 'x'.repeat(500), '‮', '\u0000', '<script>alert(1)</script>', 'javascript:alert(1)', [], {}, [[]], { __proto__: { a: 1 } }, true, 'https://u:p@evil.example/', 'http://insecure.example', 'open_url'];
  const base = { v: 1, layout: 'stack', tone: 'accent', disclosure: 'Featured', blocks: [{ type: 'heading', text: 'Hi' }, { type: 'text', text: 'there' }, { type: 'checklist', items: ['a', 'b'] }, { type: 'image', media: 'image', alt: 'x' }], actions: [{ label: 'Go', action: { command: 'open_url', arg: 'https://example.com/a' } }, { label: 'Plans', action: { command: 'open_plans' } }] };
  const mutate = (v: any, depth = 0): any => {
    if (v && typeof v === 'object' && depth < 5) {
      const copy: any = Array.isArray(v) ? [...v] : { ...v };
      const keys = Object.keys(copy);
      const n = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const k = keys.length && rnd() < 0.8 ? pick(keys) : pick(['x', 'type', 'command', 'arg', 'text', 'v']);
        const r = rnd();
        if (r < 0.35) copy[k] = pick(junk); else if (r < 0.5) delete copy[k]; else if (copy[k] && typeof copy[k] === 'object') copy[k] = mutate(copy[k], depth + 1); else copy[k] = pick(junk);
      }
      return copy;
    }
    return pick(junk);
  };
  let accepted = 0;
  for (let i = 0; i < 4000; i++) {
    const input = mutate(base);
    const r = validateCard(input);
    if (r.ok) {
      accepted++;
      assert.deepEqual(validateCard(r.value).value, r.value, 'a clean card validates to itself');
      // text is data the app draws as plain text, so markup in it is inert; what must never survive is any field outside the schema
      const KEYS = new Set(['v', 'layout', 'tone', 'disclosure', 'blocks', 'actions', 'type', 'text', 'media', 'alt', 'label', 'value', 'items', 'action', 'command', 'arg']);
      const walk = (n: any): void => { if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) { if (!Array.isArray(n)) assert.ok(KEYS.has(k), `unexpected field ${k}`); walk(v); } };
      walk(r.value);
      for (const a of r.value!.actions ?? []) if (a.action.command === 'open_url') assert.match(a.action.arg!, /^https:\/\/[^@]*$/);
    } else {
      assert.ok(r.errors.length > 0);
    }
  }
  assert.ok(accepted > 0, 'some mutations are still valid, so the loop is testing both sides');
});
