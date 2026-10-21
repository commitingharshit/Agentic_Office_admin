// Cross-origin access for the sync API (/v1/*). By default any origin may call it, as the owner asked: callers prove who they are with a bearer
// token in a header (never a cookie, and credentialed requests are not allowed), so a page on another site has nothing of the person's to ride on.
// Setting AO_CORS_ORIGINS to exact origins narrows it to those. The admin API (/admin/*) is never opened to browsers: the console calls it from its own server.
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Empty or "*" means every origin; otherwise the exact origins listed (the desktop app's own renderer is always among them). */
export const parseOrigins = (raw: string | undefined): Set<string> | '*' => {
  const items = (raw ?? '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!items.length || items.includes('*')) return '*';
  return new Set(['vscode-file://vscode-app', ...items.filter((x) => /^[a-z][a-z0-9+.-]*:\/\/[^\s/*]+$/i.test(x))]);
};

/** True when the request was a preflight that has been fully answered. Otherwise it only adds the headers a real request needs. */
export function cors(allowed: Set<string> | '*') {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (!origin || !req.url?.startsWith('/v1/')) return false;
    res.setHeader('vary', 'Origin');
    if (allowed !== '*' && !allowed.has(origin)) return req.method === 'OPTIONS' && (res.writeHead(403).end(), true);
    res.setHeader('access-control-allow-origin', allowed === '*' ? '*' : origin);
    res.setHeader('access-control-expose-headers', 'retry-after');
    if (req.method !== 'OPTIONS') return false;
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, idempotency-key',
      'access-control-max-age': '600',
    }).end();
    return true;
  };
}
