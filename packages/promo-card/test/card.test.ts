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
