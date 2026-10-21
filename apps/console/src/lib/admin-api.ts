// The admin console's only door to the data: accounts-sync's admin API, called from the server with a service token
// (never sent to the browser), naming the signed-in admin so the audit log records a person.
const base = () => (process.env.AO_ADMIN_API_URL ?? '').replace(/\/+$/, '');

export class AdminApiError extends Error {
  readonly status: number;
  /** The parsed JSON error body, when there was one (the marketplace API returns `code` and, for a failed upload, `validation`). */
  readonly body?: Record<string, any>;
  constructor(status: number, message: string, body?: Record<string, any>) { super(message); this.status = status; this.body = body; }
}

export async function adminApi<T = any>(path: string, o: { acting?: string; method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; bytes?: { data: Uint8Array; contentType: string } }): Promise<T> {
  const token = process.env.AO_ADMIN_API_TOKEN;
  if (!base() || !token) throw new AdminApiError(503, 'The admin API is not configured (AO_ADMIN_API_URL, AO_ADMIN_API_TOKEN).');
  const r = await fetch(`${base()}${path}`, {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': o.bytes?.contentType ?? 'application/json', ...(o.acting ? { 'x-ao-acting-admin': o.acting } : {}) },
    // a binary body (a package ZIP) is sent as-is; everything else is JSON
    body: o.bytes ? (o.bytes.data as unknown as BodyInit) : o.body === undefined ? undefined : JSON.stringify(o.body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* CSV or text */ }
  if (!r.ok) throw new AdminApiError(r.status, typeof data === 'object' && data?.error ? data.error : `The admin API answered ${r.status}.`, typeof data === 'object' && data ? data : undefined);
  return data as T;
}

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };
/** A read that never throws into the page: the page shows an error state for that panel and renders the rest. */
export async function load<T = any>(path: string, acting: string): Promise<Loaded<T>> {
  try { return { ok: true, data: await adminApi<T>(path, { acting }) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Unknown error.' }; }
}

/** A file upload (raw bytes with their type), e.g. a promotion's image or clip. Same token and acting admin as adminApi. */
export async function adminUpload<T = any>(path: string, o: { acting: string; type: string; bytes: ArrayBuffer }): Promise<T> {
  const token = process.env.AO_ADMIN_API_TOKEN;
  if (!base() || !token) throw new AdminApiError(503, 'The admin API is not configured (AO_ADMIN_API_URL, AO_ADMIN_API_TOKEN).');
  const r = await fetch(`${base()}${path}`, {
    method: 'POST', body: o.bytes, cache: 'no-store', signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': o.type, 'x-ao-acting-admin': o.acting },
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new AdminApiError(r.status, data?.error ?? `The admin API answered ${r.status}.`);
  return data as T;
}
