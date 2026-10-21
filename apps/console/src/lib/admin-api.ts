// The admin console's only door to the data: accounts-sync's admin API, called from the server with a service token
// (never sent to the browser), naming the signed-in admin so the audit log records a person.
const base = () => (process.env.AO_ADMIN_API_URL ?? '').replace(/\/+$/, '');

export class AdminApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function adminApi<T = any>(path: string, o: { acting?: string; method?: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<T> {
  const token = process.env.AO_ADMIN_API_TOKEN;
  if (!base() || !token) throw new AdminApiError(503, 'The admin API is not configured (AO_ADMIN_API_URL, AO_ADMIN_API_TOKEN).');
  const r = await fetch(`${base()}${path}`, {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(o.acting ? { 'x-ao-acting-admin': o.acting } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* CSV or text */ }
  if (!r.ok) throw new AdminApiError(r.status, typeof data === 'object' && data?.error ? data.error : `The admin API answered ${r.status}.`);
  return data as T;
}

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };
/** A read that never throws into the page: the page shows an error state for that panel and renders the rest. */
export async function load<T = any>(path: string, acting: string): Promise<Loaded<T>> {
  try { return { ok: true, data: await adminApi<T>(path, { acting }) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Unknown error.' }; }
}
