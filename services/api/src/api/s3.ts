// A minimal S3 client for MinIO (path-style, SigV4): just what the admin API needs —
// read the backup marker, list a user's blobs, delete them. No SDK dependency.
import { createHash, createHmac } from 'node:crypto';

export interface S3Config { endpoint: string; accessKey: string; secretKey: string; region?: string }

const BYTES_TIMEOUT_MS = 120_000;
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class S3 {
  private readonly cfg: S3Config;
  constructor(cfg: S3Config) { this.cfg = cfg; }

  async request(method: string, bucket: string, key = '', query: Record<string, string> = {}, body?: Buffer, timeoutMs = 10_000): Promise<Response> {
    const url = new URL(this.cfg.endpoint);
    const path = `/${bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const region = this.cfg.region ?? 'us-east-1';
    const payload = sha256(body ?? '');
    const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join('');
    const canonical = [method, path, qs, canonicalHeaders, signed.join(';'), payload].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key4 = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretKey}`, day), region), 's3'), 'aws4_request');
    const sig = createHmac('sha256', key4).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}`;
    return fetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  }

  async getText(bucket: string, key: string): Promise<string | undefined> {
    const r = await this.request('GET', bucket, key);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`S3 GET ${bucket}/${key}: ${r.status}`);
    return r.text();
  }

  async head(bucket: string, key: string): Promise<{ bytes: number; modified: string } | undefined> {
    const r = await this.request('HEAD', bucket, key);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`S3 HEAD ${bucket}/${key}: ${r.status}`);
    return { bytes: Number(r.headers.get('content-length') ?? 0), modified: new Date(r.headers.get('last-modified') ?? 0).toISOString() };
  }

  async list(bucket: string, prefix: string): Promise<Array<{ key: string; bytes: number }>> {
    const out: Array<{ key: string; bytes: number }> = [];
    let token: string | undefined;
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix };
      if (token) q['continuation-token'] = token;
      const r = await this.request('GET', bucket, '', q);
      if (!r.ok) throw new Error(`S3 LIST ${bucket}/${prefix}: ${r.status}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) out.push({ key: unxml(m[1]), bytes: Number(m[2]) });
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '') : undefined;
    } while (token);
    return out;
  }

  async put(bucket: string, key: string, data: Buffer | string): Promise<void> {
    const r = await this.request('PUT', bucket, key, {}, Buffer.from(data));
    if (!r.ok) throw new Error(`S3 PUT ${bucket}/${key}: ${r.status}`);
  }

  /** Large-object PUT: long timeout, and the caller's bytes are sent as a view (no copy). */
  async putBytes(bucket: string, key: string, data: Uint8Array): Promise<void> {
    const r = await this.request('PUT', bucket, key, {}, Buffer.from(data.buffer, data.byteOffset, data.byteLength), BYTES_TIMEOUT_MS);
    if (!r.ok) throw new Error(`S3 PUT ${bucket}/${key}: ${r.status}`);
  }

  /** Large-object GET, refusing anything over maxBytes (by content-length, and again while reading). */
  async getBytes(bucket: string, key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    const r = await this.request('GET', bucket, key, {}, undefined, BYTES_TIMEOUT_MS);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`S3 GET ${bucket}/${key}: ${r.status}`);
    const len = Number(r.headers.get('content-length') ?? NaN);
    const tooBig = () => new Error(`S3 GET ${bucket}/${key}: object exceeds ${maxBytes} bytes`);
    if (Number.isFinite(len) && len > maxBytes) { await r.body?.cancel(); throw tooBig(); }
    const reader = r.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const known = Number.isFinite(len) ? new Uint8Array(len) : undefined; // preallocated: one copy total
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes || (known && n > known.byteLength)) { await reader.cancel(); throw tooBig(); }
      if (known) known.set(value, n - value.byteLength); else chunks.push(value);
    }
    if (known) return n === known.byteLength ? known : known.subarray(0, n);
    const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return out;
  }

  async delete(bucket: string, key: string): Promise<void> {
    const r = await this.request('DELETE', bucket, key);
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${bucket}/${key}: ${r.status}`);
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
