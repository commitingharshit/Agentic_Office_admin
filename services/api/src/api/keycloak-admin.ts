// What the admin console may do in Keycloak, through the confidential service-account client `ao-api` (roles: view-users, manage-users,
// view-events, view-realm; Keycloak itself refuses it on the master realm). The token is fetched with client credentials and reused until
// it is about to expire. Only fields the console shows are passed on: no credential data, no tokens, no attributes.
export interface KeycloakAdminOptions { baseUrl: string; realm: string; clientId: string; clientSecret: string; fetch?: typeof fetch }

export interface KcUserInfo { enabled: boolean; emailVerified: boolean; createdAt: number | null; totp: boolean; requiredActions: string[] }
export interface KcSession { id: string; ip: string | null; started: number; lastAccess: number; clients: string[] }
export interface KcEvent { time: number; type: string; ip: string | null; client: string | null; error: string | null }

export class KeycloakAdmin {
  private token = ''; private expires = 0;
  private readonly o: KeycloakAdminOptions;
  constructor(o: KeycloakAdminOptions) { this.o = { ...o, baseUrl: o.baseUrl.replace(/\/+$/, '') }; }
  private f = (u: string, i?: RequestInit) => (this.o.fetch ?? fetch)(u, { signal: AbortSignal.timeout(10_000), ...i });

  private async auth(): Promise<string> {
    if (this.token && Date.now() < this.expires - 15_000) return this.token;
    const r = await this.f(`${this.o.baseUrl}/realms/${this.o.realm}/protocol/openid-connect/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.o.clientId, client_secret: this.o.clientSecret }),
    });
    const b = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !b.access_token) throw new Error(`Keycloak refused the admin client (${r.status}).`);
    this.token = b.access_token; this.expires = Date.now() + (b.expires_in ?? 60) * 1000;
    return this.token;
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const r = await this.f(`${this.o.baseUrl}/admin/realms/${this.o.realm}${path}`, { ...init, headers: { authorization: `Bearer ${await this.auth()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (r.status === 401) this.expires = 0;   // a rotated key: fetch a new token next time
    return r;
  }
  private async json<T>(path: string): Promise<T> {
    const r = await this.call(path);
    if (r.status === 404) throw Object.assign(new Error('Keycloak has no such user.'), { notFound: true });
    if (!r.ok) throw new Error(`Keycloak answered ${r.status}.`);
    return (await r.json()) as T;
  }
  private enc = (sub: string) => { if (!/^[A-Za-z0-9-]{8,80}$/.test(sub)) throw new Error('Not a Keycloak user id.'); return encodeURIComponent(sub); };

  async user(sub: string): Promise<KcUserInfo> {
    const u = await this.json<{ enabled?: boolean; emailVerified?: boolean; createdTimestamp?: number; requiredActions?: string[] }>(`/users/${this.enc(sub)}`);
    const creds = await this.json<Array<{ type?: string }>>(`/users/${this.enc(sub)}/credentials`).catch(() => []);
    return { enabled: u.enabled !== false, emailVerified: u.emailVerified === true, createdAt: u.createdTimestamp ?? null, totp: creds.some((c) => c.type === 'otp'), requiredActions: (u.requiredActions ?? []).map(String).slice(0, 10) };
  }
  async sessions(sub: string): Promise<KcSession[]> {
    const l = await this.json<Array<{ id: string; ipAddress?: string; start?: number; lastAccess?: number; clients?: Record<string, string> }>>(`/users/${this.enc(sub)}/sessions`);
    return l.slice(0, 50).map((s) => ({ id: s.id, ip: s.ipAddress ?? null, started: s.start ?? 0, lastAccess: s.lastAccess ?? 0, clients: Object.values(s.clients ?? {}).map(String).slice(0, 5) }));
  }
  async events(sub: string, max = 30): Promise<KcEvent[]> {
    const l = await this.json<Array<{ time?: number; type?: string; ipAddress?: string; clientId?: string; error?: string }>>(`/events?user=${this.enc(sub)}&max=${Math.min(100, Math.max(1, max))}`);
    return l.map((e) => ({ time: e.time ?? 0, type: String(e.type ?? ''), ip: e.ipAddress ?? null, client: e.clientId ?? null, error: e.error ?? null }));
  }
  /** Set a few of the person's attributes (Keycloak replaces the whole attribute map on update, so the current ones are read first and kept). */
  async setAttributes(sub: string, attrs: Record<string, string>): Promise<void> {
    const rep = await this.json<{ attributes?: Record<string, string[]> } & Record<string, unknown>>(`/users/${this.enc(sub)}`);
    const attributes = { ...(rep.attributes ?? {}) };
    for (const [k, v] of Object.entries(attrs)) attributes[k] = [String(v).slice(0, 200)];
    const r = await this.call(`/users/${this.enc(sub)}`, { method: 'PUT', body: JSON.stringify({ ...rep, attributes }) });
    if (!r.ok) throw new Error(`Keycloak answered ${r.status}.`);
  }
  /** Ends every Keycloak session of this person. */
  async logout(sub: string): Promise<void> {
    const r = await this.call(`/users/${this.enc(sub)}/logout`, { method: 'POST' });
    if (!r.ok && r.status !== 404) throw new Error(`Keycloak answered ${r.status}.`);
  }
  async setEnabled(sub: string, enabled: boolean): Promise<void> {
    const r = await this.call(`/users/${this.enc(sub)}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    if (!r.ok) throw new Error(`Keycloak answered ${r.status}.`);
  }
}

export const keycloakAdminFromEnv = (env: NodeJS.ProcessEnv = process.env): KeycloakAdmin | undefined => {
  const issuer = env.KEYCLOAK_ISSUER?.replace(/\/+$/, ''), secret = env.KEYCLOAK_API_SECRET;
  if (!issuer || !secret) return undefined;
  const m = /^(.*)\/realms\/([^/]+)$/.exec(issuer);
  if (!m) return undefined;
  return new KeycloakAdmin({ baseUrl: (env.KEYCLOAK_ADMIN_URL || m[1]).replace(/\/+$/, ''), realm: m[2], clientId: env.KEYCLOAK_API_CLIENT_ID || 'ao-api', clientSecret: secret });
};
