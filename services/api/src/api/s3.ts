// A minimal S3 client for MinIO (path-style, SigV4): just what the admin API needs —
// read the backup marker, list a user's blobs, delete them. No SDK dependency.
import { createHash, createHmac } from 'node:crypto';

export interface S3Config { endpoint: string; accessKey: string; secretKey: string; region?: string }

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class S3 {
  private readonly cfg: S3Config;
  constructor(cfg: S3Config) { this.cfg = cfg; }

  async request(method: string, bucket: string, key = '', query: Record<string, string> = {}, body?: Buffer): Promise<Response> {
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
    return fetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, { method, headers, body, signal: AbortSignal.timeout(10_000) });
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

  async putBytes(bucket: string, key: string, data: Uint8Array): Promise<void> {
    await this.put(bucket, key, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  async getBytes(bucket: string, key: string): Promise<Uint8Array | undefined> {
    const r = await this.request('GET', bucket, key);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`S3 GET ${bucket}/${key}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async delete(bucket: string, key: string): Promise<void> {
    const r = await this.request('DELETE', bucket, key);
    if (!r.ok && r.status !== 404) throw new Error(`S3 DELETE ${bucket}/${key}: ${r.status}`);
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
