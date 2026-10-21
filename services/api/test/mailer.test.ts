// The Resend adapter against a fake provider: off without both settings, sends the right request, resolves only on a real id, throws otherwise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mailerFromEnv } from '../src/api/mailer.ts';

test('off unless both a key and a sender are set', () => {
  assert.equal(mailerFromEnv({}), undefined);
  assert.equal(mailerFromEnv({ RESEND_API_KEY: 'k' }), undefined);
  assert.equal(mailerFromEnv({ AO_MAIL_FROM: 'a@b.test' }), undefined);
  assert.equal(mailerFromEnv({ RESEND_API_KEY: '  ', AO_MAIL_FROM: 'a@b.test' }), undefined);
  assert.equal(typeof mailerFromEnv({ RESEND_API_KEY: 'k', AO_MAIL_FROM: 'a@b.test' }), 'function');
});

test('sends one message with the key, and returns only what the provider said', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const ok = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }); }) as unknown as typeof fetch;
  const send = mailerFromEnv({ RESEND_API_KEY: 'secret-key', AO_MAIL_FROM: 'Agentic Office <hi@x.test>' }, ok)!;
  assert.deepEqual(await send({ to: 'p@x.test', subject: 'S', text: 'T' }), { id: 'msg_123' });
  assert.equal(seen!.url, 'https://api.resend.com/emails');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { from: 'Agentic Office <hi@x.test>', to: ['p@x.test'], subject: 'S', text: 'T' });
});

test('a refusal, a missing id, or a network error is an error, never a success', async () => {
  const mk = (f: unknown) => mailerFromEnv({ RESEND_API_KEY: 'k', AO_MAIL_FROM: 'a@b.test' }, f as typeof fetch)!;
  await assert.rejects(mk(async () => new Response(JSON.stringify({ message: 'bad address' }), { status: 422 }))({ to: 'x', subject: 's', text: 't' }), /422: bad address/);
  await assert.rejects(mk(async () => new Response('{}', { status: 200 }))({ to: 'x', subject: 's', text: 't' }), /refused/);
  await assert.rejects(mk(async () => { throw new Error('connection reset'); })({ to: 'x', subject: 's', text: 't' }), /connection reset/);
});
