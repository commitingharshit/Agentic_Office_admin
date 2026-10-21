// The admin console's sign-in through Keycloak (OpenID Connect, authorization code + PKCE, confidential client `ao-admin-console`).
// Switched on by KEYCLOAK_ISSUER; without it the console keeps using its own sign-in (the migration's transition mode).
//
//   /admin/login     → sets a signed, short-lived state cookie and sends the browser to Keycloak
//   /admin/callback  → checks state, swaps the code for tokens (back channel, with the client secret and the PKCE verifier), then hands the ID
//                      token to the sync API's Keycloak sign-in, which finds the person (and refuses unknown or disabled ones). Only an admin gets a
//                      console session: a signed cookie that names who, valid for hours. Every page still asks the admin API who that is and what
//                      they may do, so demoting or disabling someone takes effect on their next click.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const env = () => process.env;
export const keycloakMode = (): boolean => !!env().KEYCLOAK_ISSUER;
export const SESSION_COOKIE = 'ao_admin_session';
/** Who was just turned away, for 30 minutes: only so they can ask to be let in. It grants nothing. */
export const ASK_COOKIE = 'ao_access_ask';
export const LOGIN_COOKIE = 'ao_admin_login';
const SESSION_HOURS = 8;

export interface KcConfig { issuer: string; internal: string; clientId: string; secret: string; base: string }
export function kcConfig(): KcConfig {
  const e = env();
  const need = (k: string) => { const v = e[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const issuer = need('KEYCLOAK_ISSUER').replace(/\/+$/, '');
  return {
    issuer,
    // Where this server reaches Keycloak (may be an internal address); browsers always use `issuer`.
    internal: (e.KEYCLOAK_INTERNAL_URL || issuer).replace(/\/+$/, ''),
    clientId: e.KEYCLOAK_CONSOLE_CLIENT_ID || 'ao-admin-console',
    secret: need('KEYCLOAK_CONSOLE_SECRET'),
    base: need('AUTH_BASE_URL').replace(/\/+$/, ''),
  };
}
export const callbackUrl = (c: KcConfig) => `${c.base}/admin/callback`;
export const secureCookies = (c: KcConfig) => c.base.startsWith('https://');

const secret = () => { const s = env().AUTH_SECRET; if (!s || s.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters'); return s; };
const mac = (data: string) => createHmac('sha256', secret()).update(data).digest('base64url');

/** A value the browser carries but cannot change: base64url(json) + "." + HMAC. */
export function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}
export function unsign<T = Record<string, unknown>>(value: string | undefined | null): T | undefined {
  if (!value) return undefined;
  const i = value.lastIndexOf('.');
  if (i < 1) return undefined;
  const body = value.slice(0, i), given = Buffer.from(value.slice(i + 1)), want = Buffer.from(mac(body));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return undefined;
    return p;
  } catch { return undefined; }
}

export const newLogin = (next: string) => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(24).toString('base64url'), nonce: randomBytes(24).toString('base64url'), next };
};

/** Only a path on this site: a sign-in link must not be an open redirect. */
export const safeNext = (n: string | null | undefined): string => (n && /^\/admin(?:[/?#][\w\-./?=&%]*)?$/.test(n) ? n : '/admin');

export const authorizeUrl = (c: KcConfig, l: { state: string; nonce: string; challenge: string }) => {
  const u = new URL(`${c.issuer}/protocol/openid-connect/auth`);
  u.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: callbackUrl(c), scope: 'openid profile email', state: l.state, nonce: l.nonce, code_challenge: l.challenge, code_challenge_method: 'S256' }).toString();
  return u.toString();
};

const claimsOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));

export type LoginResult = { ok: true; id: string; email: string; name: string | null; role: string } | { ok: false; reason: 'denied'; who: { id: string; email: string; name: string | null } } | { ok: false; reason: 'unverified' | 'disabled' | 'failed' };

/** Code → ID token (back channel) → the sync API's Keycloak sign-in → who this is. The device token that sign-in mints is revoked at once: the console keeps no device. */
export async function finishLogin(c: KcConfig, code: string, l: { verifier: string; nonce: string }, f: typeof fetch = fetch): Promise<LoginResult> {
  // Say which step failed (never a token, a code or a secret), so a failed sign-in can be diagnosed from the server log.
  const fail = (step: string, detail = ''): LoginResult => { console.warn(`[admin] Keycloak sign-in failed at ${step}${detail ? `: ${detail}` : ''}`); return { ok: false, reason: 'failed' }; };
  const tr = await f(`${c.internal}/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(c), client_id: c.clientId, client_secret: c.secret, code_verifier: l.verifier }),
  }).catch((e) => { console.warn(`[admin] Keycloak token endpoint unreachable: ${(e as Error).message}`); return undefined; });
  if (!tr || !tr.ok) return fail('token exchange', tr ? `Keycloak answered ${tr.status}` : 'no answer');
  const tok = (await tr.json().catch(() => ({}))) as { id_token?: string };
  if (!tok.id_token) return fail('token exchange', 'no ID token in the answer');
  // The token came straight from Keycloak over the back channel; the sync API verifies its signature, issuer, audience and nonce again below.
  let claims: Record<string, unknown>;
  try { claims = claimsOf(tok.id_token); } catch { return fail('reading the ID token'); }
  if (claims.nonce !== l.nonce) return fail('nonce check', 'the ID token carries a different nonce');
  const api = (process.env.AO_SYNC_API_URL || process.env.AO_ADMIN_API_URL || '').replace(/\/+$/, '');
  if (!api) return fail('configuration', 'no API address (AO_SYNC_API_URL / AO_ADMIN_API_URL)');
  const xr = await f(`${api}/v1/auth/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ id_token: tok.id_token, nonce: l.nonce, device_name: 'admin console', platform: 'web' }),
  }).catch((e) => { console.warn(`[admin] sync API unreachable: ${(e as Error).message}`); return undefined; });
  if (!xr) return fail('sync API exchange', 'no answer');
  const body = (await xr.json().catch(() => ({}))) as { token?: string; user?: { id: string; email?: string | null; display_name?: string | null; role?: string } };
  if (xr.status === 409) return { ok: false, reason: 'unverified' };
  if (xr.status === 403) return { ok: false, reason: 'disabled' };
  if (!xr.ok || !body.token || !body.user) return fail('sync API exchange', `API answered ${xr.status}${(body as { error?: string }).error ? `: ${(body as { error?: string }).error}` : ''}`);
  await f(`${api}/v1/auth/signout`, { method: 'POST', headers: { authorization: `Bearer ${body.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  if (body.user.role !== 'admin') return { ok: false, reason: 'denied', who: { id: body.user.id, email: body.user.email ?? String(claims.email ?? ''), name: body.user.display_name ?? null } };
  return { ok: true, id: body.user.id, email: body.user.email ?? String(claims.email ?? ''), name: body.user.display_name ?? null, role: body.user.role };
}

export const newSession = (p: { id: string; email: string; name: string | null }) => sign({ ...p, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 });
export const readSession = (cookie: string | undefined) => unsign<{ id: string; email: string; name: string | null }>(cookie);
