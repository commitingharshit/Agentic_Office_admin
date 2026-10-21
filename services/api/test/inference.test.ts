// Pricing, the worst-case hold and the rate limiter: pure logic, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cost, DEFAULT_MAX_OUTPUT, estimateInputTokens, HARD_MAX_OUTPUT, outputLimit, parsePricing, UsageMeter, usageOf, worstCase } from '../src/api/inference.ts';
import { RateLimiter } from '../src/api/ratelimit.ts';

test('pricing parses, and refuses anything malformed', () => {
  assert.deepEqual(parsePricing(undefined), {});
  assert.deepEqual(parsePricing('{"gpt-4o-mini":{"in":1,"out":4.5}}'), { 'gpt-4o-mini': { in: 1, out: 4.5 } });
  for (const bad of ['not json', '{"m":{"in":-1,"out":1}}', '{"m":{"in":"x","out":1}}', '{"bad model":{"in":1,"out":1}}', '{"m":{"in":1}}', '{"m":null}'])
    assert.throws(() => parsePricing(bad), /AO_PRICING/, bad);
});

test('cost rounds up to a whole credit and is monotonic in tokens', () => {
  const p = { in: 1, out: 4 };
  assert.equal(cost(p, 0, 0), 0);
  assert.equal(cost(p, 1, 0), 1);              // a fraction of a credit is a credit
  assert.equal(cost(p, 1000, 1000), 5);
  assert.ok(cost(p, 2000, 1000) >= cost(p, 1000, 1000));
});

test('the output limit is the caller\'s, clamped, with a default', () => {
  assert.equal(outputLimit({}), DEFAULT_MAX_OUTPUT);
  assert.equal(outputLimit({ max_tokens: 50 }), 50);
  assert.equal(outputLimit({ max_completion_tokens: 70, max_tokens: 50 }), 70);
  assert.equal(outputLimit({ max_tokens: 10_000_000 }), HARD_MAX_OUTPUT);
  for (const junk of [0, -4, 'lots', null, NaN, Infinity]) assert.equal(outputLimit({ max_tokens: junk }), DEFAULT_MAX_OUTPUT, String(junk));
});

test('the worst case covers any answer that fits the limit, and is at least one credit', () => {
  const p = { in: 2, out: 6 };
  const body = { messages: [{ role: 'user', content: 'a'.repeat(3000) }], max_tokens: 500 };
  const hold = worstCase(p, body);
  assert.ok(hold >= cost(p, 1000, 500), 'the prompt is over-estimated, never under');
  assert.ok(hold >= cost(p, estimateInputTokens(body), 500));
  assert.equal(worstCase({ in: 0, out: 0 }, { messages: [], max_tokens: 1 }), 1);
});

test('usage is read from either API shape, and only when it is sound', () => {
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { in: 3, out: 4 });
  assert.deepEqual(usageOf({ usage: { input_tokens: 5, output_tokens: 6 } }), { in: 5, out: 6 });
  for (const bad of [{}, { usage: {} }, { usage: { prompt_tokens: -1, completion_tokens: 2 } }, { usage: { prompt_tokens: 'x', completion_tokens: 2 } }, { usage: { prompt_tokens: 1 } }])
    assert.equal(usageOf(bad as Record<string, unknown>), undefined, JSON.stringify(bad));
});

test('the rate limiter allows its quota, then refuses until the window slides', () => {
  let now = 1_000_000;
  const l = new RateLimiter(3, 10_000, () => now);
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a'), l.take('a')], [true, true, true, false]);
  assert.equal(l.take('b'), true, 'keys are independent');
  assert.equal(l.retryAfter('a'), 10);
  now += 4_000;
  assert.equal(l.retryAfter('a'), 6);
  assert.equal(l.take('a'), false);
  now += 6_001;
  assert.equal(l.retryAfter('a'), 0);
  assert.equal(l.take('a'), true);
});

test('peek never spends an attempt', () => {
  const l = new RateLimiter(1, 1000, () => 0);
  for (let i = 0; i < 5; i++) assert.equal(l.peek('k'), true);
  assert.equal(l.take('k'), true);
  assert.equal(l.peek('k'), false);
});

test('the usage meter reads a stream across chunk boundaries, and ignores what it cannot read', () => {
  const m = new UsageMeter();
  const events = [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: { content: ' world' } }] })}\n\n`, `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`, 'data: [DONE]\n\n'].join('');
  for (let i = 0; i < events.length; i += 7) m.feed(events.slice(i, i + 7));   // arbitrary slicing, even mid-line
  assert.deepEqual(m.usage, { in: 7, out: 3 });
  assert.equal(m.chars, 11);
  const junk = new UsageMeter();
  junk.feed(': keep-alive\n\nevent: ping\n\ndata: not json\n\ndata: {"usage": {"prompt_tokens": -4, "completion_tokens": 1}}\n\n');
  assert.equal(junk.usage, undefined, 'unsound usage is not trusted');
  assert.deepEqual(junk.estimate({ messages: [{ role: 'user', content: 'x'.repeat(30) }] }).out, 0);
});

test('the meter does not grow without bound on a stream with no line breaks', () => {
  const m = new UsageMeter();
  for (let i = 0; i < 50; i++) m.feed('x'.repeat(100_000));
  m.feed('\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n');
  assert.deepEqual(m.usage, { in: 1, out: 2 });
});
