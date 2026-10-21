// The growth routes that no signed-in person calls: Resend's signed delivery webhook and the unsubscribe link from an email.
// Both act with the admin pool (they change other people's rows on a verified signature, never on a session), and both are
// meant to be the only growth routes reachable from the internet. Mounted by main.ts before the sync API.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { HttpError } from '../api/errors.ts';
import { RateLimiter } from '../api/ratelimit.ts';
import { handleResendWebhook, unsubscribe, unsubscribeOk, unsubscribePage, type EmailConfig } from './email.ts';

async function raw(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw new HttpError(413, 'Too large.'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

export function growthPublicHandler(deps: { admin: pg.Pool; email: EmailConfig }) {
  const limit = new RateLimiter(240, 60_000);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = req.method ?? 'GET';
    const isHook = url.pathname === '/v1/webhooks/resend' && m === 'POST';
    const isUnsub = url.pathname === '/v1/unsubscribe' && (m === 'GET' || m === 'POST');
    if (!isHook && !isUnsub) return false;
    const reply = (status: number, body: string, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const from = req.socket.remoteAddress ?? '?';
      if (!limit.take(from)) throw new HttpError(429, 'Too many requests.');
      if (isHook) {
        const r = await handleResendWebhook(deps.admin, deps.email, req.headers, await raw(req, 200_000));
        reply(200, JSON.stringify(r));
        return true;
      }
      const u = url.searchParams.get('u') ?? '', t = url.searchParams.get('t') ?? '';
      if (!deps.email.unsubscribeKey || !unsubscribeOk(deps.email.unsubscribeKey, u, t)) throw new HttpError(400, 'This unsubscribe link is not valid.');
      if (m === 'GET') { reply(200, unsubscribePage(false, `/v1/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`), 'text/html; charset=utf-8'); return true; }
      await raw(req, 10_000);   // the one-click body (List-Unsubscribe=One-Click) or the form: either way, unsubscribe
      await unsubscribe(deps.admin, u);
      reply(200, unsubscribePage(true), 'text/html; charset=utf-8');
      return true;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('growth public route:', (e as Error).message);
      reply(status, JSON.stringify({ error: e instanceof HttpError ? e.message : 'Server error.' }));
      return true;
    }
  };
}
