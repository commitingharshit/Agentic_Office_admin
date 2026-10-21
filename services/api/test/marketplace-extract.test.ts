import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { extractOne, UnpackError } from '../src/marketplace/artifacts.ts';
import { ByteLru } from '../src/marketplace/lru.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as UnpackError).code; } return 'no-throw'; };

test('extractOne returns exactly the requested entry and nothing else', () => {
  const z = zipSync({ 'a.txt': enc('alpha'), 'dir/b.txt': enc('beta') });
  assert.equal(new TextDecoder().decode(extractOne(z, 'dir/b.txt', { maxBytes: 100 })!), 'beta');
});
test('extractOne: a missing entry is undefined', () => {
  assert.equal(extractOne(zipSync({ 'a.txt': enc('x') }), 'nope.txt', { maxBytes: 100 }), undefined);
});
test('extractOne: a zip-slip or absolute request path is refused before any lookup', () => {
  const z = zipSync({ 'a.txt': enc('x') });
  for (const p of ['../a.txt', '/etc/passwd', 'a/../../x', 'a\\b']) assert.equal(codeOf(() => extractOne(z, p, { maxBytes: 100 })), 'zip-slip', p);
});
test('extractOne: an entry that declares more than maxBytes is refused without inflating it', () => {
  const z = zipSync({ 'big.bin': new Uint8Array(5000) });
  assert.equal(codeOf(() => extractOne(z, 'big.bin', { maxBytes: 1000 })), 'too-large');
});
test('extractOne: a corrupt archive is a bad-zip error, not a crash', () => {
  assert.equal(codeOf(() => extractOne(new Uint8Array(40), 'a', { maxBytes: 10 })), 'bad-zip');
});
test('ByteLru evicts the least recently used entry past either limit', () => {
  const c = new ByteLru(2, 100);
  c.set('a', new Uint8Array(10)); c.set('b', new Uint8Array(10));
  assert.ok(c.get('a'));            // a is now most recent
  c.set('c', new Uint8Array(10));   // evicts b
  assert.deepEqual([c.get('a') !== undefined, c.get('b') !== undefined, c.get('c') !== undefined], [true, false, true]);
  c.set('big', new Uint8Array(101)); // over the byte budget on its own: not stored
  assert.equal(c.get('big'), undefined);
});
