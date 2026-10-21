// A small in-process sliding-window limiter. It guards the few endpoints where a guess or a flood
// is the attack: coupon codes, sign-in exchange and managed inference. A second API instance would
// need a shared store; the public edge (tunnel / proxy) is the other layer.
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  // Explicit fields, not parameter properties: Node runs this file with type stripping only.
  constructor(max: number, windowMs: number, now: () => number = Date.now) { this.max = max; this.windowMs = windowMs; this.now = now; }

  /** Records one hit for `key`; false once the key has used up its allowance in the window. */
  take(key: string): boolean {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (live.length >= this.max) { this.hits.set(key, live); return false; }
    live.push(t);
    this.hits.set(key, live);
    if (this.hits.size > 10_000) this.sweep(t);
    return true;
  }
  /** Whether `key` could take a hit right now, without recording one. */
  peek(key: string): boolean {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs).length < this.max;
  }
  /** Seconds until `key` may try again (0 when it can). */
  retryAfter(key: string): number {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    return live.length < this.max ? 0 : Math.ceil((live[0] + this.windowMs - t) / 1000);
  }
  private sweep(t: number) {
    for (const [k, v] of this.hits) if (!v.some((h) => t - h < this.windowMs)) this.hits.delete(k);
  }
}
