// Laya shadow mode's pure parts: which text Laya reads, and the client's skip-when-busy rule. The database path is in billing-api.test.ts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { httpLaya, lastUserText, MAX_TEXT } from '../src/api/laya.ts';

test('Laya reads the last user message, string or text parts, capped', () => {
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'second' }] }), 'second');
  assert.equal(lastUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }, { type: 'input_text', text: 'b' }] }] }), 'a\nb');
  assert.equal(lastUserText({ messages: [{ role: 'system', content: 'only system' }] }), undefined);
  assert.equal(lastUserText({ messages: [{ role: 'user', content: '   ' }] }), undefined);
  assert.equal(lastUserText({}), undefined);
  assert.equal(lastUserText({ messages: [{ role: 'user', content: 'x'.repeat(MAX_TEXT + 5) }] })!.length, MAX_TEXT);
});

test('the Laya client sends the key, refuses a bad answer, and skips when busy', async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const seen: Array<{ auth?: string; body: string }> = [];
  const srv = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ auth: req.headers.authorization, body });
    if (JSON.parse(body).text === 'slow') await gate;
    const out = JSON.parse(body).text === 'bad' ? {} : { pattern: 'p1', confidence: 0.9, probabilities: { p1: 0.9 }, model: 'v7c' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const laya = httpLaya(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, 'k', 5_000, 1);
  try {
    assert.deepEqual(await laya('hi'), { pattern: 'p1', confidence: 0.9, probabilities: { p1: 0.9 }, model: 'v7c' });
    assert.deepEqual(seen[0], { auth: 'Bearer k', body: '{"text":"hi"}' });
    await assert.rejects(laya('bad'), /without a pattern/);
    const slow = laya('slow');
    assert.equal(await laya('skipped'), undefined, 'one in flight is the limit here');
    release(); await slow;
    assert.ok(await laya('again'), 'a slot frees once the call ends');
    assert.ok(!seen.some((s) => s.body.includes('skipped')));
  } finally { srv.close(); }
});
