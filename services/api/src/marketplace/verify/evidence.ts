// Evidence sinks. Evidence is untrusted data: capped per blob and per run. Over a cap addBlob rejects with
// EvidenceLimitError and the sink records `truncated`, so the runner appends an explicit "evidence truncated"
// item to the stage (even if the stage swallowed the error).
import { putArtifact, sha256Hex, type ArtifactStore } from '../artifacts.ts';
import { MAX_EVIDENCE_BLOBS_PER_RUN, MAX_EVIDENCE_BLOB_BYTES, type BlobMime, type EvidenceSink } from './types.ts';

export class EvidenceLimitError extends Error { constructor(msg: string) { super(msg); this.name = 'EvidenceLimitError'; } }
export interface LimitedSink extends EvidenceSink { readonly truncated: boolean; readonly count: number; resetTruncated(): void }
type Put = (bytes: Uint8Array, mime: BlobMime) => Promise<{ sha256: string; size: number }>;

export function limitedSink(put: Put, o: { maxBlobBytes?: number; maxBlobs?: number } = {}): LimitedSink {
  const maxBytes = o.maxBlobBytes ?? MAX_EVIDENCE_BLOB_BYTES, maxBlobs = o.maxBlobs ?? MAX_EVIDENCE_BLOBS_PER_RUN;
  let count = 0, truncated = false;
  return {
    get truncated() { return truncated; }, get count() { return count; }, resetTruncated() { truncated = false; },
    async addBlob(mime: BlobMime, bytes: Uint8Array) {
      if (bytes.byteLength > maxBytes) { truncated = true; throw new EvidenceLimitError(`evidence blob is ${bytes.byteLength} bytes, over the ${maxBytes} limit`); }
      if (count >= maxBlobs) { truncated = true; throw new EvidenceLimitError(`more than ${maxBlobs} evidence blobs in one run`); }
      const r = await put(bytes, mime);
      count++;
      return { sha256: r.sha256, mime, size: r.size };
    },
  };
}

export function memoryEvidenceSink(o?: { maxBlobBytes?: number; maxBlobs?: number }): LimitedSink & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  const s = limitedSink(async b => { const sha256 = sha256Hex(b); blobs.set(sha256, new Uint8Array(b)); return { sha256, size: b.byteLength }; }, o);
  return Object.assign(s, { blobs });
}

/** Content-addressed via putArtifact. NOTE: ArtifactStore fixes its own key prefix, so blobs share the artifact namespace (sha-keyed, never colliding). */
export function storeEvidenceSink(store: ArtifactStore, o?: { maxBlobBytes?: number; maxBlobs?: number }): LimitedSink {
  const max = o?.maxBlobBytes ?? MAX_EVIDENCE_BLOB_BYTES;
  return limitedSink(async b => { const r = await putArtifact(store, b, max); return { sha256: r.sha256, size: r.size }; }, o);
}
