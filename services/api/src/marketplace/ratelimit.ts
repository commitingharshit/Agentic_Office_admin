// A tiny in-memory fixed-window limiter, one counter per key (the user id). Per process: good enough
// to blunt a runaway client on the mutating marketplace routes, not a distributed quota.
export interface Limiter { allow(key: string): boolean }

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
  };
}
