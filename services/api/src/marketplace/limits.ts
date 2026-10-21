// Per-user quotas and the ingest gate for the creator routes, in one place. Every value can be overridden by an
// environment variable (operators) or by `limits` in the handler deps (tests).
import { StoreError } from './store.ts';

export interface Limits {
  /** Listings a user may own. */
  maxListings: number;
  /** Versions on one listing (every state counts). */
  maxVersionsPerListing: number;
  /** Sum of the sizes of the versions on a user's listings. */
  maxBytesPerUser: number;
  /** Uploads validated (unpacked, scanned) at the same time in this process. */
  ingestConcurrency: number;
  /** Uploads waiting for a validation slot; beyond it the answer is 429 `busy`. */
  ingestQueue: number;
}

const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? Math.floor(v) : d; };

export function defaultLimits(over: Partial<Limits> = {}): Limits {
  return {
    maxListings: num('AO_MKT_MAX_LISTINGS', 100),
    maxVersionsPerListing: num('AO_MKT_MAX_VERSIONS_PER_LISTING', 50),
    maxBytesPerUser: num('AO_MKT_MAX_BYTES_PER_USER', 1024 * 1024 * 1024),
    ingestConcurrency: num('AO_MKT_INGEST_CONCURRENCY', 2),
    ingestQueue: num('AO_MKT_INGEST_QUEUE', 8),
    ...over,
  };
}

export interface Gate { run<T>(fn: () => Promise<T>): Promise<T> }

/** A counting semaphore with a bounded wait queue: beyond it, `run` rejects with 429 `busy` (Retry-After 5). */
export function createGate(concurrency: number, queue: number): Gate {
  let running = 0;
  const waiting: (() => void)[] = [];
  const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
  return {
    async run(fn) {
      if (running >= concurrency) {
        if (waiting.length >= queue) throw new StoreError(429, 'The server is busy validating other uploads. Try again shortly.', 'busy');
        await new Promise<void>((r) => waiting.push(r));   // the slot is handed over without `running` changing
      } else running++;
      try { return await fn(); } finally { release(); }
    },
  };
}
