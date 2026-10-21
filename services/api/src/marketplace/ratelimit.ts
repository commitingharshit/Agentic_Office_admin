// A tiny in-memory fixed-window limiter, one counter per key (the user id). Per process: good enough
// to blunt a runaway client on the mutating marketplace routes, not a distributed quota.
import type { IncomingMessage } from 'node:http';

/**
 * The address a request counts against. hops = 0 (default): the socket address, the X-Forwarded-For header is ignored.
 * hops = N > 0: the N-th address from the RIGHT of X-Forwarded-For (the one our own N-th proxy appended); the left-most
 * entries are whatever the client sent and are never used. Fewer entries than hops means the request did not come through
 * the proxy chain we expect, so the header is not trusted and the socket address is used.
 */
export function clientAddress(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops = 0): string {
  const socket = req.socket?.remoteAddress ?? '?';
  if (!(hops > 0)) return socket;
  const raw = req.headers['x-forwarded-for'];
  const parts = (Array.isArray(raw) ? raw.join(',') : raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length >= hops ? parts[parts.length - hops] : socket;
}

export interface Limiter { allow(key: string): boolean; /** Whole seconds until `key` may try again (>= 1). */ retryAfter(key: string): number }

export function createLimiter(opts: { limit?: number; windowMs?: number; now?: () => number } = {}): Limiter {
  const limit = opts.limit ?? 60, windowMs = opts.windowMs ?? 60_000, now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; n: number }>();
  return {
    allow(key) {
      const t = now();
      if (windows.size > 10_000) for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) { windows.set(key, { start: t, n: 1 }); return true; }
      if (w.n >= limit) return false;
      w.n++;
      return true;
    },
    retryAfter(key) {
      const w = windows.get(key);
      return w ? Math.max(1, Math.ceil((w.start + windowMs - now()) / 1000)) : 1;
    },
  };
}
