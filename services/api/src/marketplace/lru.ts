// A small in-process LRU for artifact entries (preview images, SKILL.md), bounded by entry count and total bytes. Safe to
// share across users only because artifacts are immutable and content addressed: callers must still check visibility
// (row-level security) on every request BEFORE reading from here.
export class ByteLru {
  private readonly m = new Map<string, Uint8Array>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  constructor(maxEntries = 64, maxBytes = 32 * 1024 * 1024) { this.maxEntries = maxEntries; this.maxBytes = maxBytes; }
  get(key: string): Uint8Array | undefined {
    const v = this.m.get(key);
    if (v) { this.m.delete(key); this.m.set(key, v); }
    return v;
  }
  set(key: string, value: Uint8Array): void {
    if (value.byteLength > this.maxBytes) return;
    const old = this.m.get(key);
    if (old) { this.bytes -= old.byteLength; this.m.delete(key); }
    this.m.set(key, value); this.bytes += value.byteLength;
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, v] = this.m.entries().next().value as [string, Uint8Array];
      this.m.delete(k); this.bytes -= v.byteLength;
    }
  }
}
