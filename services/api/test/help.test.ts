// The help assistant: documentation chunking, indexing, retrieval, the doc-only guard, what is sent to the provider, keys, and the log.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { chunkMarkdown } from '../src/help/chunk.ts';
import { cosine, indexDocs, Index } from '../src/help/kb.ts';
import { HelpProvider, providerFromEnv } from '../src/help/provider.ts';
import { createHelp, redact, type HelpModel } from '../src/help/service.ts';
import { RateLimiter } from '../src/api/ratelimit.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

// A deterministic stand-in for an embedding model: hashed bag of words, so similar wording is close and unrelated wording is not.
const DIM = 128;
const words = (s: string) => s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
const vec = (s: string) => { const v = new Array(DIM).fill(0); for (const w of words(s)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % DIM] += 1; } return v; };
function fakeModel(over: Partial<HelpModel> = {}): HelpModel & { sent: Array<Array<{ role: string; content: string }>>; embedded: string[][] } {
  const m: any = { embedModel: 'fake-embed', sent: [], embedded: [],
    async embed(t: string[]) { m.embedded.push(t); return t.map(vec); },
    async chat(msgs: any) { m.sent.push(msgs); return 'Open Coupons, press New coupon, set the credit amount and save [1].'; },
    status: () => ({ keys: 1, resting: 0 }), ...over };
  return m;
}

describe('chunking', () => {
  const md = `---\ntitle: Coupons\nroute: /admin/coupons\n---\nIntro that is long enough to keep as a chunk of its own.\n\n## Create a coupon\nPress New coupon, choose the credit amount and the expiry date.\n\n### Limits\nA coupon can be used once per person unless a limit is set.\n\n\`\`\`\n# not a heading\n\`\`\`\n`;
  test('splits by heading, keeps the trail and the route, ignores # inside code fences', () => {
    const c = chunkMarkdown('guide/coupons.md', md);
    assert.deepEqual(c.map((x) => x.heading), ['Coupons', 'Coupons › Create a coupon', 'Coupons › Create a coupon › Limits']);
    assert.ok(c.every((x) => x.route === '/admin/coupons'));
    assert.ok(c[2]!.body.includes('# not a heading'));
  });
  test('ids and hashes are stable; changing text changes only that hash', () => {
    const a = chunkMarkdown('p.md', md), b = chunkMarkdown('p.md', md.replace('credit amount', 'credit value'));
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
    assert.deepEqual(a.map((x, i) => x.hash === b[i]!.hash), [true, false, true]);
  });
  test('a section can name its own page; it wins over the front matter, and an invalid one is ignored', () => {
    const c = chunkMarkdown('g.md', '---\ntitle: Business\nroute: /admin/billing\n---\n## Coupons\nPage: /admin/coupons\nCreate a coupon with the New coupon button and a credit amount.\n\n## Payments\nPage: https://evil.example/x\nPayments are listed with their state and can be settled by finance.\n');
    assert.deepEqual(c.map((x) => x.route), ['/admin/coupons', '/admin/billing']);
  });
  test('an invalid route is dropped, a long section is split without cutting words', () => {
    assert.equal(chunkMarkdown('p.md', '---\nroute: https://evil\n---\n' + 'word '.repeat(40))[0]!.route, null);
    const long = chunkMarkdown('p.md', '# T\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ` + 'lorem ipsum '.repeat(10)).join('\n\n'));
    assert.ok(long.length > 2 && long.every((c) => c.body.length <= 2400));
  });
});

describe('redaction', () => {
  test('emails, keys, tokens, hex and long numbers never reach the provider', () => {
    const r = redact('why can ayush@example.com not use sk-abc123def456ghi789 or Bearer abcdefghijklmnop1234 or ' + 'a'.repeat(40) + ' or 4111111111111111 or ' + 'ab12'.repeat(10));
    assert.ok(!/ayush|sk-abc|abcdefghijklmnop|4111|ab12ab12/.test(r), r);
    assert.match(r, /\[email\]/);
  });
  test('ordinary questions are untouched', () => assert.equal(redact('How do I create a coupon for finance?'), 'How do I create a coupon for finance?'));
});

describe('provider keys', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body));
  test('uses keys in turn, rests a rate-limited key and moves on, never shows key values', async () => {
    const used: string[] = []; let t = 0;
    const f = (async (_u: string, init: any) => { const k = init.headers.authorization.slice(7); used.push(k); return k === 'k1' ? new Response('{}', { status: 429 }) : ok({ choices: [{ message: { content: 'hi' } }] }); }) as unknown as typeof fetch;
    const p = new HelpProvider({ baseUrl: 'https://api.example.com/v1/', keys: ['k1', 'k2'], chatModel: 'm', embedModel: 'e', fetch: f, now: () => t });
    assert.equal(await p.chat([{ role: 'user', content: 'x' }]), 'hi');
    assert.deepEqual(used, ['k1', 'k2']);
    assert.deepEqual(p.status(), { keys: 2, resting: 1 });
    used.length = 0; await p.chat([{ role: 'user', content: 'x' }]); assert.deepEqual(used, ['k2']);
    t += 61_000; assert.equal(p.status().resting, 0);
    assert.ok(!JSON.stringify(p.status()).includes('k1'));
  });
  test('all keys resting is a 429 error; a refused key rests ten minutes; other errors stop', async () => {
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const p = new HelpProvider({ baseUrl: 'https://x.example', keys: ['a'], chatModel: 'm', embedModel: 'e', fetch: f });
    await assert.rejects(p.chat([{ role: 'user', content: 'x' }]), /refused/);
    await assert.rejects(p.chat([{ role: 'user', content: 'x' }]), /resting|refused/);
    const p2 = new HelpProvider({ baseUrl: 'https://x.example', keys: ['a', 'b'], chatModel: 'm', embedModel: 'e', fetch: (async () => new Response('x', { status: 500 })) as unknown as typeof fetch });
    await assert.rejects(p2.chat([{ role: 'user', content: 'x' }]), /500/);
  });
  test('embeddings: wrong shape is an error, order follows index', async () => {
    const bad = new HelpProvider({ baseUrl: 'https://x.example', keys: ['a'], chatModel: 'm', embedModel: 'e', fetch: (async () => ok({ data: [] })) as unknown as typeof fetch });
    await assert.rejects(bad.embed(['a', 'b']), /wrong shape/);
    const good = new HelpProvider({ baseUrl: 'https://x.example', keys: ['a'], chatModel: 'm', embedModel: 'e', fetch: (async () => ok({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] })) as unknown as typeof fetch });
    assert.deepEqual(await good.embed(['a', 'b']), [[1], [2]]);
  });
  test('config: https only (http for localhost), keys from the environment, none means off', () => {
    assert.throws(() => new HelpProvider({ baseUrl: 'http://api.example.com', keys: ['a'], chatModel: 'm', embedModel: 'e' }), /https/);
    new HelpProvider({ baseUrl: 'http://127.0.0.1:4000/v1', keys: ['a'], chatModel: 'm', embedModel: 'e' });
    assert.equal(providerFromEnv({ AO_HELP_BASE_URL: 'https://x.example' }), undefined);
    assert.equal(providerFromEnv({ AO_HELP_API_KEYS: 'a,b' }), undefined);
    assert.deepEqual(providerFromEnv({ AO_HELP_BASE_URL: 'https://x.example', AO_HELP_API_KEYS: 'a, b,a', AO_HELP_API_KEY: 'c' })!.status(), { keys: 3, resting: 0 });
  });
});

describe('index, retrieval and ask (real Postgres)', { skip }, () => {
  let h: MarketplacePg, dir: string;
  let admin: ReturnType<MarketplacePg['pool']>, ro: ReturnType<MarketplacePg['pool']>;
  before(async () => {
    h = await startMarketplacePg();
    await h.owner.query(readFileSync(new URL('../../../database/migrations/0032_help_kb.sql', import.meta.url), 'utf8'));
    admin = h.pool('ao_admin'); ro = h.pool('ao_readonly');
    dir = mkdtempSync(join(tmpdir(), 'help-docs-'));
    mkdirSync(join(dir, 'admin-guide'));
    writeFileSync(join(dir, 'admin-guide', 'coupons.md'), '---\ntitle: Coupons\nroute: /admin/coupons\n---\n## Create a coupon\nOpen Coupons and press New coupon. Choose the credit amount, the expiry date and how many people can redeem it, then save the coupon.\n');
    writeFileSync(join(dir, 'admin-guide', 'users.md'), '---\ntitle: Users\nroute: /admin/users\n---\n## Disable a user\nOpen the user in Users, then press Disable account. The person is signed out of every device immediately.\n');
  });
  after(async () => { await h?.stop(); rmSync(dir, { recursive: true, force: true }); });

  test('indexing embeds each chunk once; a rerun embeds nothing; an edit re-embeds only that chunk; a deleted page is removed', async () => {
    const m = fakeModel();
    const a = await indexDocs(admin, dir, m); assert.deepEqual([a.pages, a.chunks, a.embedded, a.removed], [2, 2, 2, 0]);
    const b = await indexDocs(admin, dir, m); assert.equal(b.embedded, 0);
    writeFileSync(join(dir, 'admin-guide', 'users.md'), '---\ntitle: Users\nroute: /admin/users\n---\n## Disable a user\nOpen the user in Users, then press Disable account. Their sessions end at once.\n');
    assert.equal((await indexDocs(admin, dir, m)).embedded, 1);
    writeFileSync(join(dir, 'scratch.md'), '# Scratch\nthis page will be deleted soon enough to test removal.\n');
    assert.equal((await indexDocs(admin, dir, m)).embedded, 1);
    rmSync(join(dir, 'scratch.md'));
    assert.equal((await indexDocs(admin, dir, m)).removed, 1);
    assert.equal((await indexDocs(admin, dir, fakeModel({ embedModel: 'other' } as any))).embedded, 2);   // new model re-embeds everything
    await indexDocs(admin, dir, m);
  });
  test('retrieval puts the right page first', async () => {
    const idx = new Index(ro);
    const hits = await idx.search(vec('how do I create a coupon with an expiry date'), 'fake-embed', 2);
    assert.equal(hits[0]!.route, '/admin/coupons');
    assert.ok(hits[0]!.score > hits[1]!.score);
    assert.deepEqual(await idx.search(vec('x'), 'a-model-nobody-used'), []);
  });
  test('ask: a documented question is answered from its chunks, cites them, and the provider sees only docs + redacted question + role', async () => {
    const m = fakeModel();
    const help = createHelp({ provider: m, ro, admin, limiter: new RateLimiter(50, 60_000) });
    const r: any = await help.ask('usr_1', 'support', 'How do I create a coupon with an expiry date? ayush@example.com asked');
    assert.equal(r.answered, true);
    assert.equal(r.sources[0].route, '/admin/coupons');
    const sent = JSON.stringify(m.sent[0]);
    assert.ok(!sent.includes('ayush@example.com') && sent.includes('[email]'));
    assert.ok(sent.includes('Administrator role: support') && sent.includes('New coupon'));
    assert.ok(!/users\.md|usr_1/.test(sent), 'nothing but the question, the role and the matched documentation is sent');
    const row = (await h.owner.query('SELECT * FROM help_questions WHERE id = $1', [r.questionId])).rows[0];
    assert.deepEqual([row.admin_id, row.answered, row.sources, row.question_hash.length], ['usr_1', true, ['admin-guide/coupons.md'], 64]);
    assert.ok(!Object.values(row).some((v) => typeof v === 'string' && v.includes('coupon with an expiry')), 'the question text is not stored');
  });
  test('ask: nothing documented close enough => the model is NOT called, the gap is logged', async () => {
    const m = fakeModel();
    const help = createHelp({ provider: m, ro, admin, limiter: new RateLimiter(50, 60_000) });
    const r: any = await help.ask('usr_1', 'support', 'what is the airspeed velocity of a swallow');
    assert.equal(r.answered, false); assert.equal(m.sent.length, 0);
    assert.equal((await h.owner.query('SELECT answered FROM help_questions WHERE id=$1', [r.questionId])).rows[0].answered, false);
  });
  test('ask: provider failure is a 503 with no detail; rate limit is a 429; too short is a 400', async () => {
    const boom = fakeModel({ chat: async () => { throw new Error('sk-secret-key-value-123456 leaked'); } } as any);
    const r: any = await createHelp({ provider: boom, ro, admin, limiter: new RateLimiter(50, 60_000) }).ask('usr_1', 'support', 'how do I create a coupon');
    assert.equal(r.status, 503); assert.ok(!JSON.stringify(r).includes('secret'));
    const lim = createHelp({ provider: fakeModel(), ro, admin, limiter: new RateLimiter(1, 60_000) });
    await lim.ask('usr_2', 'support', 'how do I create a coupon');
    assert.equal(((await lim.ask('usr_2', 'support', 'how do I create a coupon')) as any).status, 429);
    assert.equal(((await lim.ask('usr_3', 'support', 'hi')) as any).status, 400);
  });
  test('feedback: only the person who asked can mark their own question', async () => {
    const help = createHelp({ provider: fakeModel(), ro, admin, limiter: new RateLimiter(50, 60_000) });
    const r: any = await help.ask('usr_9', 'support', 'how do I create a coupon');
    assert.equal(await help.feedback('usr_other', r.questionId, true), false);
    assert.equal(await help.feedback('usr_9', r.questionId, true), true);
    assert.equal((await h.owner.query('SELECT helpful FROM help_questions WHERE id=$1', [r.questionId])).rows[0].helpful, true);
  });
  test('the read-only role cannot change the knowledge base', async () => {
    await assert.rejects(ro.query(`DELETE FROM help_chunks`), /permission denied/);
  });
});

test('cosine: identical is 1, orthogonal 0, zero vector 0', () => {
  assert.ok(Math.abs(cosine([1, 2], [1, 2]) - 1) < 1e-9); assert.equal(cosine([1, 0], [0, 1]), 0); assert.equal(cosine([0, 0], [1, 1]), 0);
});
