// The sync API — the only thing a device talks to. Every request carries a Clerk session token;
// the server maps the Clerk user to our own user id and runs the request as ao_app inside a
// transaction with app.user_id set, so row-level security scopes every read and write to that
// user. Documents, transcripts and memories arrive already encrypted on the device: the server
// stores bytes and metadata, never plaintext.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { AuthError, type ClerkClaims } from '../auth/clerk.ts';
import type { IdClaims } from '../auth/jwks.ts';
import * as billing from './billing.ts';
import type { KeycloakAdmin } from './keycloak-admin.ts';
import { HttpError } from './errors.ts';
import * as ops from './ops.ts';
import type { PaymentsService } from './payments/service.ts';
import * as telemetry from './telemetry.ts';
import * as growth from '../growth/engine.ts';
import { cost as priceCost, outputLimit, UsageMeter, usageOf, worstCase, type Pricing, type StreamUpstream, type Upstream } from './inference.ts';
import { RateLimiter } from './ratelimit.ts';
import type { S3 } from './s3.ts';

export interface SyncDeps {
  app: pg.Pool;
  /** Managed inference: the models on offer (credits per 1,000 tokens) and where a call goes. Off without both. */
  pricing?: Pricing;
  upstream?: Upstream;
  /** The same provider, streaming. Without it a stream request is refused. */
  streamUpstream?: StreamUpstream;
  /** Sign-in exchanges allowed per client address per minute (default 30). */
  exchangeLimit?: number;
  /** Clerk session tokens (until Clerk is retired): absent when only our own sign-in is configured. */
  verify?(token: string): Promise<ClerkClaims>;
  /** Our own sign-in service (Better Auth): verifies the ID token the desktop app receives after the browser sign-in. */
  verifyIdToken?(token: string): Promise<IdClaims>;
  /** Plans bought with money: orders, the provider's webhook, reconciliation. Absent (and every payment route says so) unless payments are switched on. */
  payments?: PaymentsService;
  /** Keycloak's admin REST API. When set, a person's plan and role are mirrored into their Keycloak attributes (ao_plan, ao_role), which the token mappers turn into claims. The database stays the authority: nothing here ever trusts a claim for access. */
  keycloakAdmin?: KeycloakAdmin;
  /** Keycloak, the identity service: its issuer (as it appears in tokens) and a verifier for the ID tokens it signs. Checked first when a token's issuer matches. */
  keycloak?: { issuer: string; verify(token: string): Promise<IdClaims> };
  /** The OAuth endpoints the desktop app signs in through; handed out by GET /v1/auth/config. */
  oauth?: { issuer: string; authorization_endpoint: string; token_endpoint: string; client_id: string };
  s3?: S3;
  /** Signs the app's links to promotion media (src/growth/engine.ts mediaLink). Without one, links last for this process only. */
  mediaKey?: Buffer;
  /** Clerk publishable key, handed to the desktop app's sign-in page (it is public). */
  publishableKey?: string;
  /** Every way a Clerk user can sign in (oauth_google, oauth_microsoft, …), from Clerk's Backend API.
   *  Session tokens carry neither the provider nor, for some Microsoft accounts, the email. */
  clerkIdentities?(clerkUserId: string): Promise<Array<{ provider: string; email?: string | null; image?: string | null }>>;
  /** Largest blob accepted (bytes). */
  maxBlobBytes?: number;
}

export { HttpError };

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const ulidish = () => {
  const t = Date.now().toString(36).padStart(10, '0');
  return t + Array.from({ length: 16 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
};

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, 'Too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage, max = 2_000_000): Promise<Record<string, unknown>> {
  const b = await readBody(req, max);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'Body is not JSON.'); }
}
const id = (v: unknown, what: string) => { const s = String(v ?? ''); if (!ID.test(s)) throw new HttpError(400, `${what} must be 1–80 letters, digits, _ or -.`); return s; };
/** A workspace named by an event or session that this user has not described yet. */
async function ensureWorkspace(c: pg.PoolClient, uid: string, ws: string | null) {
  if (ws) await c.query(`INSERT INTO workspaces(id, user_id, name) VALUES ($1,$2,'Untitled') ON CONFLICT (id) DO NOTHING`, [ws, uid]);
}
const str = (v: unknown, max = 500) => (v === undefined || v === null ? null : String(v).slice(0, max));

/** Runs `fn` as ao_app with RLS scoped to `userId` (or in sign-in mode when userId is null). */
async function asUser<T>(deps: SyncDeps, userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await deps.app.connect();
  try {
    await c.query('BEGIN');
    if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    else await c.query(`SELECT set_config('app.signin', 'on', true)`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** Find or create the user for a Clerk identity; refuses disabled and deleted accounts. */
export async function signIn(deps: SyncDeps, claims: ClerkClaims): Promise<{ id: string; created: boolean }> {
  const found = await asUser(deps, null, async (c) => (await c.query('SELECT id, status FROM users WHERE clerk_user_id = $1', [claims.sub])).rows[0]);
  if (found) {
    if (found.status !== 'active') throw new HttpError(403, found.status === 'disabled' ? 'This account is disabled. Contact the administrator.' : 'This account was deleted.');
    await asUser(deps, found.id, (c) => c.query(`UPDATE users SET last_active_at = now(), email = coalesce($2, email), display_name = coalesce($3, display_name) WHERE id = $1`, [found.id, str(claims.email, 320), str(claims.name, 200)]));
    return { id: found.id, created: false };
  }
  const uid = `usr_${ulidish()}`;
  await asUser(deps, null, async (c) => {
    await c.query(`INSERT INTO users(id, clerk_user_id, email, display_name, last_active_at) VALUES ($1,$2,$3,$4, now())`, [uid, claims.sub, str(claims.email, 320), str(claims.name, 200)]);
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [uid]);
    const provider = String(claims.provider ?? claims.oauth_provider ?? 'clerk').replace(/^oauth_/, '').slice(0, 40);
    await c.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject, email) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [`oa_${ulidish()}`, uid, provider, claims.sub, str(claims.email, 320)]);
  });
  return { id: uid, created: true };
}

export function syncHandler(deps: SyncDeps) {
  // Clerk user → our id, so a request does not re-run sign-in; re-checked every minute (a disable lands within a minute).
  const known = new Map<string, { id: string; at: number }>();
  const maxBlob = deps.maxBlobBytes ?? 50 * 1024 * 1024;

  // Device token (aod_…) → our user id, re-checked every minute like Clerk identities.
  const devices = new Map<string, { id: string; at: number }>();
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  async function deviceUser(tok: string): Promise<string> {
    const h = sha(tok);
    const k = devices.get(h);
    if (k && Date.now() - k.at < 60_000) return k.id;
    const row = await asUser(deps, null, async (c) => (await c.query(
      `SELECT t.id, t.user_id, u.status FROM device_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()`, [h])).rows[0]);
    if (!row) { devices.delete(h); throw new HttpError(401, 'Sign in again.'); }
    if (row.status !== 'active') { devices.delete(h); throw new HttpError(403, row.status === 'disabled' ? 'This account is disabled. Contact the administrator.' : 'This account was deleted.'); }
    await asUser(deps, row.user_id, (c) => c.query(`UPDATE device_tokens SET last_used_at = now(), expires_at = now() + interval '90 days' WHERE id = $1`, [row.id]));
    devices.set(h, { id: row.user_id, at: Date.now() });
    return row.user_id;
  }

  // Brute-force guards: wrong coupon codes per user, sign-in exchanges per address, model calls per user.
  const badCodes = new RateLimiter(8, 15 * 60_000);
  const exchanges = new RateLimiter(deps.exchangeLimit ?? 30, 60_000);
  const modelCalls = new RateLimiter(60, 60_000);
  const webhooks = new RateLimiter(120, 60_000);
  // The plan sets the per-minute allowance; one limiter per distinct allowance, keyed by user. `modelCalls` stays as the flat abuse ceiling.
  const planCalls = new Map<number, RateLimiter>();
  const planLimiter = (perMinute: number) => { let l = planCalls.get(perMinute); if (!l) planCalls.set(perMinute, l = new RateLimiter(perMinute, 60_000)); return l; };
  const checkouts = new RateLimiter(10, 60_000);
  const telemetryCalls = new RateLimiter(30, 60_000);
  const promoCalls = new RateLimiter(120, 60_000);
  const mediaKey = deps.mediaKey ?? growth.mediaKey();
  const tooMany = (l: RateLimiter, key: string) => new HttpError(429, 'Too many attempts. Try again later.', { retry_after: l.retryAfter(key) });

  /** An API key (aok_…) → its owner. Keys may only call managed inference (checked by the router). */
  async function keyUser(tok: string): Promise<string> {
    const h = billing.hashKey(tok);
    const row = await asUser(deps, null, async (c) => (await c.query(
      `SELECT k.id, k.user_id, u.status FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`, [h])).rows[0]);
    if (!row) throw new HttpError(401, 'That API key is not valid.');
    if (row.status !== 'active') throw new HttpError(403, row.status === 'disabled' ? 'This account is disabled. Contact the administrator.' : 'This account was deleted.');
    await asUser(deps, row.user_id, (c) => c.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]));
    return row.user_id;
  }

  async function user(req: IncomingMessage): Promise<{ uid: string; claims: ClerkClaims; viaKey?: boolean }> {
    const tok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!tok) throw new HttpError(401, 'Sign in first.');
    if (tok.startsWith('aok_')) return { uid: await keyUser(tok), claims: { sub: '', iss: 'ao-key', exp: 0 }, viaKey: true };
    if (tok.startsWith('aod_')) return { uid: await deviceUser(tok), claims: { sub: '', iss: 'ao-device', exp: 0 } };
    let claims: ClerkClaims;
    if (!deps.verify) throw new HttpError(401, 'Sign in again.');
    try { claims = await deps.verify(tok); } catch (e) { throw new HttpError(401, e instanceof AuthError ? e.message : 'Sign in again.'); }
    const k = known.get(claims.sub);
    if (k && Date.now() - k.at < 60_000) return { uid: k.id, claims };
    const { id: uid } = await signIn(deps, claims);
    known.set(claims.sub, { id: uid, at: Date.now() });
    return { uid, claims };
  }

  /** Mirror the user's sign-in identities (Google, Microsoft, both when Clerk linked them) into
   *  oauth_accounts, and drop the provider-less 'clerk' placeholder once a real one is known. */
  async function recordIdentities(uid: string, sub: string, ids: Array<{ provider: string; email?: string | null }>) {
    await asUser(deps, uid, async (c) => {
      for (const i of ids) {
        const p = String(i.provider).replace(/^oauth_/, '').toLowerCase().slice(0, 40);
        if (!/^[a-z0-9_-]+$/.test(p)) continue;
        await c.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject, email) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (provider, subject, purpose) DO UPDATE SET email = coalesce(excluded.email, oauth_accounts.email), revoked_at = NULL`,
          [`oa_${ulidish()}`, uid, p, sub, str(i.email, 320)]);
      }
      await c.query(`UPDATE oauth_accounts SET revoked_at = now() WHERE user_id = $1 AND subject = $2 AND provider = 'clerk' AND purpose = 'sign_in' AND revoked_at IS NULL`, [uid, sub]);
    });
  }

  /** Desktop sign-in: what the browser produced (our ID token, or a Clerk session token) → a device token for this app. */
  async function exchange(req: IncomingMessage) {
    const d = await json(req, 20_000);
    // The address the proxy in front of us saw (Tailscale sets x-forwarded-for); recorded for the person's sign-in history, never used to decide access.
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || null;
    if (d.id_token !== undefined) return exchangeIdToken(d, ip);
    if (!deps.verify) throw new HttpError(400, 'Send the id_token from the sign-in page.');
    let claims: ClerkClaims;
    try { claims = await deps.verify(String(d.clerk_token ?? '')); } catch (e) { throw new HttpError(401, e instanceof AuthError ? e.message : 'The sign-in did not verify. Try again.'); }
    const ids = deps.clerkIdentities ? await deps.clerkIdentities(claims.sub).catch(() => []) : [];
    if (!claims.provider && !claims.oauth_provider && ids[0]) claims = { ...claims, provider: ids[0].provider };
    if (!claims.email && ids.find((i) => i.email)) claims = { ...claims, email: ids.find((i) => i.email)!.email ?? undefined };
    const { id: uid } = await signIn(deps, claims);
    if (ids.length) await recordIdentities(uid, claims.sub, ids);
    // The profile photo (Google / Microsoft, through Clerk): https only, so the app can show it.
    const photo = [claims.picture, claims.image_url, ...ids.map((i) => i.image)].find((u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]{1,2000}$/.test(u));
    if (photo) await asUser(deps, uid, (c) => c.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [uid, photo]));
    return mintDeviceToken(uid, d);
  }

  async function mintDeviceToken(uid: string, d: Record<string, unknown>) {
    const token = `aod_${randomBytes(32).toString('base64url')}`;
    return asUser(deps, uid, async (c) => {
      const t = (await c.query(`INSERT INTO device_tokens(id, user_id, token_hash, device_name, platform, expires_at)
        VALUES ($1,$2,$3,$4,$5, now() + interval '90 days') RETURNING expires_at`,
        [`dtk_${ulidish()}`, uid, sha(token), str(d.device_name, 200), str(d.platform, 40)])).rows[0];
      // A person can be signed in on many devices, but not on an unbounded number: past 25 the oldest sign-ins end.
      const ended = await c.query(`UPDATE device_tokens SET revoked_at = now() WHERE id IN (SELECT id FROM device_tokens WHERE revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC OFFSET 25)`);
      if (ended.rowCount) devices.clear();   // a token ended here must stop working now, not when the minute-long cache lapses
      const u = (await c.query('SELECT id, email, display_name, avatar_url, role FROM users WHERE id = $1', [uid])).rows[0];
      return { token, expires_at: t.expires_at, user: u, entitlements: await billing.entitlements(c) };
    });
  }

  /** The ID token from Keycloak. Its subject is Keycloak's id for the person, so it is mapped to ours: the identity we already know, else
   *  the one existing account with the same VERIFIED email (linked once, so people keep their data), else a new account. An unverified
   *  email never links to an existing account: anyone can type an address into a sign-up form. */
  async function exchangeKeycloak(d: Record<string, unknown>, kc: NonNullable<SyncDeps['keycloak']>, ip: string | null) {
    let claims: IdClaims;
    try { claims = await kc.verify(String(d.id_token ?? '')); } catch (e) { throw new HttpError(401, e instanceof AuthError ? e.message : 'The sign-in did not verify. Try again.'); }
    if (typeof d.nonce !== 'string' || !d.nonce || claims.nonce !== d.nonce) throw new HttpError(401, 'The sign-in did not verify. Try again.');
    const email = typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase().slice(0, 320) : null;
    const verified = claims.email_verified === true;
    const name = str(claims.name, 200);
    const who = await asUser(deps, null, async (c) => {
      // Two sign-ins for the same Keycloak person at once (two windows, a double click) take turns: the second finds the first's account instead of making another.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`keycloak:${claims.sub}`]);
      const known = (await c.query(`SELECT u.id, u.status FROM oauth_accounts o JOIN users u ON u.id = o.user_id
        WHERE o.provider = 'keycloak' AND o.subject = $1 AND o.purpose = 'sign_in' AND o.revoked_at IS NULL`, [claims.sub])).rows[0];
      if (known) return known as { id: string; status: string };
      const link = async (uid: string) => {
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [uid]);
        await c.query(`INSERT INTO oauth_accounts(id, user_id, provider, subject, email) VALUES ($1,$2,'keycloak',$3,$4) ON CONFLICT DO NOTHING`, [`oa_${ulidish()}`, uid, claims.sub, email]);
      };
      if (email) {
        const same = (await c.query(`SELECT id, status FROM users WHERE lower(email) = $1 AND status <> 'deleted'`, [email])).rows[0];
        if (same) {
          if (!verified) throw new HttpError(409, 'An account with this email already exists. Sign in the way you did before, or verify your email address first.');
          await link(same.id);
          await c.query('UPDATE users SET email_verified = true WHERE id = $1', [same.id]);
          return same as { id: string; status: string };
        }
      }
      const uid = `usr_${ulidish()}`;
      await c.query(`INSERT INTO users(id, email, display_name, email_verified, last_active_at) VALUES ($1,$2,$3,$4, now())`, [uid, email, name, verified]);
      await link(uid);
      return { id: uid, status: 'active' };
    });
    if (who.status !== 'active') throw new HttpError(403, who.status === 'disabled' ? 'This account is disabled. Contact the administrator.' : 'This account was deleted.');
    await asUser(deps, who.id, (c) => c.query(`UPDATE users SET last_active_at = now(), display_name = coalesce(display_name, $2), email_verified = email_verified OR $3 WHERE id = $1`, [who.id, name, verified]));
    if (typeof claims.picture === 'string' && /^https:\/\/[^\s"'<>]{1,2000}$/.test(claims.picture)) await asUser(deps, who.id, (c) => c.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [who.id, claims.picture]));
    const minted = await mintDeviceToken(who.id, d);
    // The sign-in is on record, and the person's plan and role are handed to Keycloak so the next token carries them (best effort: signing in never waits on it).
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    await asUser(deps, who.id, (c) => c.query(`INSERT INTO sign_in_events(user_id, provider, client, device_name, platform, ip) VALUES ($1,'keycloak',$2,$3,$4,$5)`,
      [who.id, typeof aud === 'string' ? aud.slice(0, 80) : null, str(d.device_name, 200), str(d.platform, 40), ip?.slice(0, 64) ?? null])).catch(() => undefined);
    void syncKeycloakAttributes(who.id, claims.sub, minted.entitlements.plan.id, minted.user.role, claims as unknown as Record<string, unknown>);
    return minted;
  }

  /** Put the plan and role where Keycloak can put them in tokens. Skipped when the token already says the same thing. */
  async function syncKeycloakAttributes(uid: string, sub: string, plan: string, role: string, tokenClaims?: Record<string, unknown>): Promise<void> {
    if (!deps.keycloakAdmin) return;
    if (tokenClaims && tokenClaims.ao_plan === plan && tokenClaims.ao_role === role) return;
    try { await deps.keycloakAdmin.setAttributes(sub, { ao_plan: plan, ao_role: role }); } catch (e) { console.warn(`[sync] could not mirror plan/role to Keycloak for ${uid}: ${(e as Error).message}`); }
  }
  const mirrorAfterChange = async (uid: string) => {
    if (!deps.keycloakAdmin) return;
    const r = await asUser(deps, uid, async (c) => ({ sub: (await c.query(`SELECT subject FROM oauth_accounts WHERE provider = 'keycloak' AND purpose = 'sign_in' AND revoked_at IS NULL LIMIT 1`)).rows[0]?.subject as string | undefined,
      ent: await billing.entitlements(c), role: (await c.query('SELECT role FROM users WHERE id = $1', [uid])).rows[0]?.role as string }));
    if (r.sub) await syncKeycloakAttributes(uid, r.sub, r.ent.plan.id, r.role);
  };

  /** The issuer a token claims, read without trusting it, only to choose which verifier to run (the verifier then checks it for real). */
  const issuerOf = (jwt: unknown): string | undefined => { try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')).iss; } catch { return undefined; } };

  /** The ID token from our sign-in service. Its subject is already our user id; it must carry the nonce this device chose. */
  async function exchangeIdToken(d: Record<string, unknown>, ipOf: string | null = null) {
    if (deps.keycloak && issuerOf(d.id_token) === deps.keycloak.issuer) return exchangeKeycloak(d, deps.keycloak, ipOf);
    if (!deps.verifyIdToken) throw new HttpError(503, 'Sign-in is not configured on this server yet.');
    let claims: IdClaims;
    try { claims = await deps.verifyIdToken(String(d.id_token ?? '')); } catch (e) { throw new HttpError(401, e instanceof AuthError ? e.message : 'The sign-in did not verify. Try again.'); }
    // Bound to the browser sign-in this device started: a token taken from elsewhere does not carry its nonce.
    if (typeof d.nonce !== 'string' || !d.nonce || claims.nonce !== d.nonce) throw new HttpError(401, 'The sign-in did not verify. Try again.');
    const row = await asUser(deps, null, async (c) => (await c.query('SELECT id, status FROM users WHERE id = $1', [claims.sub])).rows[0]);
    if (!row) throw new HttpError(401, 'The sign-in did not verify. Try again.');
    if (row.status !== 'active') throw new HttpError(403, row.status === 'disabled' ? 'This account is disabled. Contact the administrator.' : 'This account was deleted.');
    await asUser(deps, row.id, (c) => c.query(`UPDATE users SET last_active_at = now(), email = coalesce($2, email), display_name = coalesce($3, display_name) WHERE id = $1`, [row.id, str(claims.email, 320), str(claims.name, 200)]));
    if (typeof claims.picture === 'string' && /^https:\/\/[^\s"'<>]{1,2000}$/.test(claims.picture)) await asUser(deps, row.id, (c) => c.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [row.id, claims.picture]));
    return mintDeviceToken(row.id, d);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/v1/')) return false;
    const send = (status: number, payload: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(payload) : (payload as Buffer));
    };
    try {
      const m = req.method ?? 'GET';
      const [, , a, b, c] = url.pathname.split('/');   // '', 'v1', a, b, c
      // ── sign-in (no token yet)
      if (a === 'auth' && b === 'config' && m === 'GET') return send(200, { publishableKey: deps.publishableKey ?? null, oauth: deps.oauth ?? null }), true;
      if (a === 'auth' && b === 'exchange' && m === 'POST') {
        const from = req.socket.remoteAddress ?? '?';
        if (!exchanges.take(from)) throw tooMany(exchanges, from);
        return send(200, await exchange(req)), true;
      }
      // The payment provider's notice: no sign-in (it is not a person), only its signature. Raw bytes in, answer out.
      if (a === 'payments' && b === 'webhooks' && c && m === 'POST') {
        if (!deps.payments || deps.payments.provider.id !== c) throw new HttpError(404, 'Not found.');
        const from = req.socket.remoteAddress ?? '?';
        if (!webhooks.take(from)) throw tooMany(webhooks, from);
        const raw = await readBody(req, 100_000);
        const r = await deps.payments.handleWebhook(raw, req.headers);
        return send(r.status, r.body), true;
      }
      // Promotion media: a signed, expiring link (no sign-in header, so it works as a <video src>); the signature names the file.
      if (a === 'promotions' && b === 'media' && c && m === 'GET') {
        const id = Number(c), e = Number(url.searchParams.get('e')), sig = url.searchParams.get('s') ?? '';
        if (!growth.verifyMedia(mediaKey, id, e, sig)) throw new HttpError(403, 'This media link is not valid or has expired.');
        if (!deps.s3) throw new HttpError(503, 'Media storage is not configured.');
        const f = await asUser(deps, null, async (cl) => (await cl.query("SELECT s3_key, mime FROM creative_media WHERE id = $1 AND role <> 'source'", [id])).rows[0]);
        if (!f) throw new HttpError(404, 'Not found.');
        const r = await deps.s3.request('GET', growth.MEDIA_BUCKET, f.s3_key);
        if (!r.ok) throw new HttpError(404, 'Not found.');
        const bytes = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, { 'content-type': f.mime, 'content-length': bytes.length, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(bytes);
        return true;
      }
      const { uid, claims, viaKey } = await user(req);
      if (viaKey && a !== 'inference') throw new HttpError(403, 'An API key can only call managed inference.');
      const q = <T>(fn: (c: pg.PoolClient) => Promise<T>) => asUser(deps, uid, fn);
      if (a === 'auth' && b === 'signout' && m === 'POST') {
        const tok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
        const h = sha(tok); devices.delete(h);
        await q((cl) => cl.query('UPDATE device_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [h]));
        return send(200, { ok: true }), true;
      }

      // ── account
      if (a === 'session' && m === 'POST') {
        const me = await q(async (cl) => (await cl.query('SELECT id, email, display_name, role, created_at FROM users WHERE id = $1', [uid])).rows[0]);
        return send(200, { user: me, admin: claims.role === 'admin' || me?.role === 'admin' }), true;
      }
      // ── plan, credits, coupons, usage, devices, API keys (src/api/billing.ts; money moves in SQL)
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (a === 'me' && b === 'entitlements' && m === 'GET') return send(200, await q(billing.entitlements)), true;
      if (a === 'me' && b === 'devices' && !c && m === 'GET') return send(200, { devices: await q((cl) => billing.listDevices(cl, bearer.startsWith('aod_') ? sha(bearer) : null)) }), true;
      if (a === 'me' && b === 'devices' && c && m === 'DELETE') {
        if (!(await q((cl) => billing.revokeDevice(cl, id(c, 'device id'))))) throw new HttpError(404, 'No such device.');
        devices.clear();   // a revoked token must stop working now, not when the minute-long cache lapses
        return send(200, { ok: true }), true;
      }
      // ── what the app needs from operations: flags, announcements, support (src/api/ops.ts)
      if (a === 'config' && b === 'client' && m === 'GET') { const f = await q((cl) => ops.flagsFor(cl, uid)); return send(200, { plan: f.plan, flags: f.flags }), true; }
      // ── promotions (src/growth/engine.ts): what this person may see on a placement, what they did, and their own choices
      if (a === 'promotions' && b === 'eligible' && m === 'GET') {
        if (!promoCalls.take(uid)) throw tooMany(promoCalls, uid);
        return send(200, await q((cl) => growth.eligible(cl, uid, url.searchParams, (id) => growth.mediaLink(mediaKey, id)))), true;
      }
      if (a === 'promotions' && b === 'events' && m === 'POST') {
        if (!promoCalls.take(uid)) throw tooMany(promoCalls, uid);
        const d = await json(req, 50_000);
        return send(200, await q((cl) => growth.recordEvents(cl, uid, d))), true;
      }
      if (a === 'promotions' && b === 'prefs' && m === 'GET') return send(200, await q((cl) => growth.getPrefs(cl, uid))), true;
      if (a === 'promotions' && b === 'prefs' && m === 'PUT') { const d = await json(req, 1_000); return send(200, await q((cl) => growth.setPrefs(cl, uid, d))), true; }
      if (a === 'announcements' && !b && m === 'GET') return send(200, await q((cl) => ops.liveAnnouncements(cl, uid))), true;
      if (a === 'announcements' && b && c === 'read' && m === 'POST') return send(200, await q((cl) => ops.markRead(cl, uid, b))), true;
      if (a === 'support' && b === 'tickets' && !c && m === 'GET') return send(200, await q(ops.myTickets)), true;
      if (a === 'support' && b === 'tickets' && !c && m === 'POST') { const d = await json(req, 8_000); return send(201, await q((cl) => ops.openTicket(cl, uid, d))), true; }
      if (a === 'support' && b === 'tickets' && c && m === 'POST') { const d = await json(req, 8_000); return send(200, await q((cl) => ops.userReply(cl, uid, c, d))), true; }
      // ── opt-in usage sharing and run telemetry (src/api/telemetry.ts: nothing is stored while sharing is off; free text is refused)
      if (a === 'me' && b === 'usage-consent' && m === 'GET') return send(200, await q(telemetry.getConsent)), true;
      if (a === 'me' && b === 'usage-consent' && m === 'PUT') { const d = await json(req, 1_000); return send(200, await q((cl) => telemetry.setConsent(cl, uid, d))), true; }
      if (a === 'telemetry' && b === 'runs' && m === 'POST') {
        if (!telemetryCalls.take(uid)) throw tooMany(telemetryCalls, uid);
        const d = await json(req, 2_000_000);
        return send(200, await q((cl) => telemetry.ingestRuns(cl, uid, d))), true;
      }
      if (a === 'plans' && !b && m === 'GET') return send(200, { plans: await q(billing.listPlans), payments_enabled: !!deps.payments, payments_experimental: !!deps.payments?.provider.experimental }), true;
      // ── buying a plan. The price comes from the database; the app can only name a plan. Nothing here activates a plan: only a settled order does.
      if (a === 'billing' && b === 'checkout' && m === 'POST') {
        if (!deps.payments) throw new HttpError(503, 'Payments are not switched on.');
        if (!checkouts.take(uid)) throw tooMany(checkouts, uid);
        const d = await json(req, 2_000);
        return send(200, await deps.payments.createCheckout(uid, id(d.plan_id, 'plan_id'))), true;
      }
      if (a === 'billing' && b === 'orders' && !c && m === 'GET') { if (!deps.payments) throw new HttpError(503, 'Payments are not switched on.'); return send(200, await deps.payments.listOrders(uid)), true; }
      if (a === 'billing' && b === 'orders' && c && m === 'GET') { if (!deps.payments) throw new HttpError(503, 'Payments are not switched on.'); return send(200, await deps.payments.getOrder(uid, id(c, 'order id'))), true; }
      if (a === 'billing' && b === 'orders' && c && url.pathname.endsWith('/cancel') && m === 'POST') { if (!deps.payments) throw new HttpError(503, 'Payments are not switched on.'); return send(200, await deps.payments.cancel(uid, id(c, 'order id'))), true; }
      if (a === 'credits' && b === 'balance' && m === 'GET') return send(200, await q(billing.balance)), true;
      if (a === 'usage' && !b && m === 'GET') return send(200, await q((cl) => billing.usage(cl, Number(url.searchParams.get('limit')) || 50))), true;
      if (a === 'coupons' && b === 'redeem' && m === 'POST') {
        const d = await json(req, 2_000);
        if (!badCodes.peek(uid)) throw tooMany(badCodes, uid);
        try { const redeemed = await q((cl) => billing.redeem(cl, d.code)); void mirrorAfterChange(uid).catch(() => undefined); return send(200, redeemed), true; }
        catch (e) { const mapped = billing.mapBillingError(e); if (mapped && mapped.status !== 409) badCodes.take(uid); throw mapped ? new HttpError(mapped.status, mapped.message) : e; }
      }
      if (a === 'api-keys' && !b && m === 'GET') return send(200, { keys: await q(billing.listApiKeys) }), true;
      if (a === 'api-keys' && !b && m === 'POST') {
        const d = await json(req, 2_000);
        const made = await q((cl) => billing.createApiKey(cl, uid, d.name, ulidish));
        if (!made) throw new HttpError(409, 'You have reached the limit of 10 API keys. Revoke one first.');
        return send(201, made), true;
      }
      if (a === 'api-keys' && b && m === 'DELETE') {
        if (!(await q((cl) => billing.revokeApiKey(cl, id(b, 'key id'))))) throw new HttpError(404, 'No such key.');
        return send(200, { ok: true }), true;
      }

      // ── managed inference: hold the worst case, call the model, charge the real use, give back the rest
      if (a === 'inference' && b === 'models' && !c && m === 'GET') {
        if (!deps.pricing) throw new HttpError(503, 'Managed inference is not configured.');
        return send(200, { object: 'list', data: Object.keys(deps.pricing).map((id) => ({ id, object: 'model', owned_by: 'agentic-office' })) }), true;
      }
      // /responses is ours; /chat/completions is the path OpenAI-compatible clients (Hermes) append to a base URL.
      if (a === 'inference' && ((b === 'responses' && !c) || (b === 'chat' && c === 'completions')) && m === 'POST') {
        if (!deps.pricing || !deps.upstream) throw new HttpError(503, 'Managed inference is not configured.');
        if (!modelCalls.take(uid)) throw tooMany(modelCalls, uid);
        const flagState = await q((cl) => ops.flagsFor(cl, uid));
        if (ops.killed(flagState.raw, 'killswitch.managed_inference', uid, flagState.plan)) throw new HttpError(503, 'Managed inference is paused. Try again later, or use your own API key.');
        const ent = await q(billing.entitlements);
        if (!ent.managed_inference) throw new HttpError(403, 'Your plan does not include managed inference.');
        const planRate = planLimiter(ent.limits.requests_per_minute);
        if (!planRate.take(uid)) throw new HttpError(429, 'Your plan allows ' + ent.limits.requests_per_minute + ' requests a minute. Try again shortly.', { retry_after: planRate.retryAfter(uid) });
        const d = await json(req, 1_000_000);
        const model = String(d.model ?? '');
        const price = Object.hasOwn(deps.pricing, model) ? deps.pricing[model] : undefined;
        if (!price) throw new HttpError(400, 'That model is not available.', { models: Object.keys(deps.pricing) });
        const allowed = ent.limits.allowed_models;
        if (allowed && !allowed.includes(model)) throw new HttpError(403, 'Your plan does not include that model.', { models: Object.keys(deps.pricing).filter((id) => allowed.includes(id)) });
        const wantStream = d.stream === true;
        if (wantStream && !deps.streamUpstream) throw new HttpError(400, 'Streaming is not available on this server. Send "stream": false.');
        if (!Array.isArray(d.messages) || !d.messages.length) throw new HttpError(400, 'messages is required.');
        const limit = outputLimit(d);
        const body: Record<string, unknown> = { ...d, max_tokens: limit, stream: wantStream };
        delete body.max_completion_tokens;
        delete body.stream_options;   // ours to set: usage is how a stream is charged
        const reqId = /^[A-Za-z0-9_-]{8,80}$/.test(String(req.headers['idempotency-key'] ?? '')) ? String(req.headers['idempotency-key']) : `req_${ulidish()}`;
        const hold = worstCase(price, body);
        let rid: number, status: string;
        try {
          ({ rid, status } = await q(async (cl) => {
            // Counted under the same per-user lock the reservation takes, so simultaneous calls cannot all see room.
            await cl.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [uid]);
            // Runs in flight = open, unexpired holds. A retry of the same request id is not a new run.
            const busy = Number((await cl.query(`SELECT count(*) FROM credit_reservations WHERE status = 'open' AND expires_at > now() AND request_id <> $1`, [reqId])).rows[0].count);
            if (busy >= ent.limits.max_concurrent_runs) throw new HttpError(429, 'Your plan allows ' + ent.limits.max_concurrent_runs + ' run' + (ent.limits.max_concurrent_runs === 1 ? '' : 's') + ' at a time. Wait for one to finish.');
            const r = Number((await cl.query('SELECT ao_credit_reserve($1,$2,$3)', [hold, reqId, ent.limits.max_job_seconds])).rows[0].ao_credit_reserve);
            return { rid: r, status: (await cl.query('SELECT status FROM credit_reservations WHERE id = $1', [r])).rows[0].status as string };
          }));
        } catch (e) { const mapped = billing.mapBillingError(e); throw mapped ? new HttpError(mapped.status, mapped.message, { needed: hold }) : e; }
        if (status !== 'open') throw new HttpError(409, 'That request was already processed.');
        if (wantStream) {
          const ac = new AbortController();
          let first;
          try { first = await deps.streamUpstream!(model, body, ac.signal); }
          catch { await q((cl) => cl.query('SELECT ao_credit_release($1)', [rid])); throw new HttpError(502, 'The model did not answer. You were not charged.'); }
          if (first.status < 200 || first.status >= 300 || !first.body) {
            await q((cl) => cl.query('SELECT ao_credit_release($1)', [rid]));
            throw new HttpError(first.status >= 500 || first.status === 429 ? 502 : 400, 'The model refused the request. You were not charged.');
          }
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-ao-request-id': reqId });
          res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // the person stopped listening: stop paying for it
          const meter = new UsageMeter();
          const dec = new TextDecoder();
          try {
            const reader = first.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              meter.feed(dec.decode(value, { stream: true }));
              if (!res.destroyed) res.write(value);
            }
          } catch { /* cut short by either side: charge what was used */ }
          if (!res.writableEnded) res.end();
          // What the provider reported, else what we saw go by: never more than was held, never nothing for text already sent.
          const used = meter.usage ?? meter.estimate(body);
          const chargedStream = Math.min(priceCost(price, used.in, used.out), hold);
          await q((cl) => cl.query('SELECT ao_credit_settle($1,$2,$3,$4,$5)', [rid, chargedStream, model, used.in, used.out])).catch((e) => console.error('settle after stream failed', e));
          return true;
        }
        let out;
        try { out = await deps.upstream(model, body); }
        catch { await q((cl) => cl.query('SELECT ao_credit_release($1)', [rid])); throw new HttpError(502, 'The model did not answer. You were not charged.'); }
        const used = out.status >= 200 && out.status < 300 ? usageOf(out.body) : undefined;
        if (!used) {
          // A failed call, or an answer that does not say what it used, costs the user nothing.
          await q((cl) => cl.query('SELECT ao_credit_release($1)', [rid]));
          if (out.status >= 200 && out.status < 300) throw new HttpError(502, 'The model answered without usage. You were not charged.');
          throw new HttpError(out.status >= 500 || out.status === 429 ? 502 : 400, 'The model refused the request. You were not charged.');
        }
        const charged = priceCost(price, used.in, used.out);
        await q((cl) => cl.query('SELECT ao_credit_settle($1,$2,$3,$4,$5)', [rid, charged, model, used.in, used.out]));
        const left = await q(billing.balance);
        return send(200, { ...out.body, ao: { request_id: reqId, charged: Math.min(charged, hold), balance: left.total } }), true;
      }

      if (a === 'me' && !b && m === 'GET') {
        return send(200, await q(async (cl) => ({
          user: (await cl.query('SELECT id, email, display_name, avatar_url, role, created_at, last_active_at FROM users WHERE id = $1', [uid])).rows[0],
          devices: (await cl.query('SELECT id, name, platform, app_version, last_seen FROM devices ORDER BY last_seen DESC')).rows,
          workspaces: (await cl.query('SELECT id, name, updated_at FROM workspaces ORDER BY updated_at DESC')).rows,
          identities: (await cl.query(`SELECT provider, email, created_at FROM oauth_accounts WHERE purpose = 'sign_in' AND revoked_at IS NULL ORDER BY created_at`)).rows,
        }))), true;
      }

      // ── devices
      if (a === 'devices' && b && m === 'PUT') {
        const d = await json(req);
        await q((cl) => cl.query(`INSERT INTO devices(id, user_id, name, platform, app_version) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET name = excluded.name, platform = excluded.platform, app_version = excluded.app_version, last_seen = now()
          WHERE devices.user_id = $2`, [id(b, 'device id'), uid, str(d.name, 200), str(d.platform, 40), str(d.app_version, 40)]));
        return send(200, { ok: true }), true;
      }

      // ── workspaces and sessions (metadata for restore)
      if (a === 'workspaces' && !b && m === 'GET') return send(200, { workspaces: await q(async (cl) => (await cl.query('SELECT id, name, created_at, updated_at FROM workspaces ORDER BY updated_at DESC')).rows) }), true;
      if (a === 'workspaces' && b && m === 'PUT') {
        const d = await json(req);
        await q((cl) => cl.query(`INSERT INTO workspaces(id, user_id, name) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = now() WHERE workspaces.user_id = $2`, [id(b, 'workspace id'), uid, str(d.name, 200) ?? 'Untitled']));
        return send(200, { ok: true }), true;
      }
      if (a === 'sessions' && !b && m === 'GET') {
        const ws = url.searchParams.get('workspace_id');
        const since = url.searchParams.get('since');
        if (since !== null) {
          // Incremental: sessions changed after the cursor, oldest first, a page at a time.
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 500, 1), 1000);
          const rows = await q(async (cl) => (await cl.query(`SELECT id, workspace_id, title, latest_checkpoint_id, created_at, updated_at, updated_at::text AS cursor FROM sessions
            WHERE updated_at > $1 ${ws ? 'AND workspace_id = $3' : ''} ORDER BY updated_at, id LIMIT $2`, ws ? [since || '-infinity', limit, ws] : [since || '-infinity', limit])).rows);
          return send(200, { sessions: rows, more: rows.length === limit }), true;
        }
        return send(200, { sessions: await q(async (cl) => (await cl.query(`SELECT id, workspace_id, title, latest_checkpoint_id, created_at, updated_at FROM sessions ${ws ? 'WHERE workspace_id = $1' : ''} ORDER BY updated_at DESC LIMIT 200`, ws ? [ws] : [])).rows) }), true;
      }
      if (a === 'sessions' && b && m === 'PUT') {
        const d = await json(req);
        const ws = d.workspace_id ? id(d.workspace_id, 'workspace id') : null;
        await q(async (cl) => { await ensureWorkspace(cl, uid, ws); return cl.query(`INSERT INTO sessions(id, user_id, workspace_id, title, latest_checkpoint_id) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (id) DO UPDATE SET title = coalesce(excluded.title, sessions.title), latest_checkpoint_id = coalesce(excluded.latest_checkpoint_id, sessions.latest_checkpoint_id), updated_at = now()
          WHERE sessions.user_id = $2`, [id(b, 'session id'), uid, ws, str(d.title, 300), d.latest_checkpoint_id ? id(d.latest_checkpoint_id, 'checkpoint id') : null]); });
        return send(200, { ok: true }), true;
      }

      // ── events: at-least-once from the device outbox; idempotent by event_id, ordered per session
      if (a === 'events' && m === 'POST') {
        const d = await json(req, 8_000_000);
        const events = Array.isArray(d.events) ? d.events as Array<Record<string, unknown>> : [];
        if (events.length > 500) throw new HttpError(413, 'At most 500 events per request.');
        const r = await q(async (cl) => {
          const acked: string[] = [], rejected: Array<{ event_id: string; reason: string }> = [];
          for (const e of events) {
            const eid = id(e.event_id, 'event_id'), sid = id(e.session_id, 'session_id');
            const seq = Number(e.sequence);
            if (!Number.isSafeInteger(seq) || seq < 1) { rejected.push({ event_id: eid, reason: 'sequence must be a positive integer' }); continue; }
            const ws = e.workspace_id ? id(e.workspace_id, 'workspace_id') : null;
            await ensureWorkspace(cl, uid, ws);
            await cl.query(`INSERT INTO sessions(id, user_id, workspace_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`, [sid, uid, ws]);
            const ins = await cl.query(`INSERT INTO session_events(event_id, user_id, workspace_id, session_id, sequence, type, run_id, task_id, agent_id, payload, created_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING event_id`,
              [eid, uid, e.workspace_id ?? null, sid, seq, str(e.type, 80) ?? 'event', str(e.run_id, 80), str(e.task_id, 80), str(e.agent_id, 80),
               e.payload_b64 ? Buffer.from(String(e.payload_b64), 'base64') : null, e.created_at ? new Date(String(e.created_at)) : new Date()]);
            if (ins.rowCount) { acked.push(eid); continue; }
            const dup = await cl.query('SELECT session_id, sequence FROM session_events WHERE event_id = $1', [eid]);
            if (dup.rowCount && dup.rows[0].session_id === sid && Number(dup.rows[0].sequence) === seq) acked.push(eid);    // a retry
            // The same event at another place is a disagreement the device must resolve, not a success.
            else if (dup.rowCount) rejected.push({ event_id: eid, reason: `event is already stored at sequence ${dup.rows[0].sequence} of session ${dup.rows[0].session_id}` });
            else rejected.push({ event_id: eid, reason: `sequence ${seq} of session ${sid} is taken by another event` });
          }
          if (acked.length) {
            await cl.query('UPDATE users SET last_active_at = now() WHERE id = $1', [uid]);
            // A session changed when its events did: devices pull sessions "updated since".
            const touched = [...new Set(events.filter((e) => acked.includes(String(e.event_id))).map((e) => String(e.session_id)))];
            await cl.query('UPDATE sessions SET updated_at = now() WHERE id = ANY($1)', [touched]);
          }
          return { acked, rejected };
        });
        return send(200, r), true;
      }
      if (a === 'events' && m === 'GET') {
        const sid = id(url.searchParams.get('session_id'), 'session_id');
        const after = Number(url.searchParams.get('after') ?? 0), limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 500)));
        const rows = await q(async (cl) => (await cl.query(`SELECT event_id, session_id, workspace_id, sequence, type, run_id, task_id, agent_id, payload, created_at
          FROM session_events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3`, [sid, after, limit])).rows);
        return send(200, { events: rows.map((r) => ({ ...r, sequence: Number(r.sequence), payload: undefined, payload_b64: r.payload ? Buffer.from(r.payload).toString('base64') : null })) }), true;
      }

      // ── blobs: content-addressed, already encrypted by the device
      if (a === 'blobs' && b === 'batch' && m === 'POST') {
        if (!deps.s3) throw new HttpError(503, 'Blob storage is not configured.');
        const d = await json(req, 20_000);
        const hashes = Array.isArray(d.hashes) ? [...new Set(d.hashes.map(String))] : [];
        if (hashes.length > 100) throw new HttpError(413, 'At most 100 blobs per request.');
        if (hashes.some((h) => !HASH.test(h))) throw new HttpError(400, 'A blob is addressed by the sha256 of its bytes.');
        const out: Record<string, string> = {};
        // Only this user's own blobs (the key is prefixed with the user id); a few at a time.
        for (let i = 0; i < hashes.length; i += 8) {
          await Promise.all(hashes.slice(i, i + 8).map(async (h) => {
            const r = await deps.s3!.request('GET', 'ao-user-blobs', `${uid}/${h}`);
            if (r.ok) out[h] = Buffer.from(await r.arrayBuffer()).toString('base64');
          }));
        }
        return send(200, { blobs: out }), true;
      }
      if (a === 'sync' && b === 'head' && m === 'GET') {
        // The newest change per stream: a device whose cursors are already here has nothing to pull.
        // Cursors are Postgres text timestamps (microseconds): a JSON date would round them down and
        // the newest row would come back on every pull.
        return send(200, await q(async (cl) => (await cl.query(`SELECT
          (SELECT max(updated_at)::text FROM memory_references) AS memory_max,
          (SELECT max(updated_at)::text FROM sessions) AS sessions_max`)).rows[0])), true;
      }
      if (a === 'blobs' && b) {
        if (!HASH.test(b)) throw new HttpError(400, 'A blob is addressed by the sha256 of its bytes.');
        if (!deps.s3) throw new HttpError(503, 'Blob storage is not configured.');
        const key = `${uid}/${b}`;
        if (m === 'PUT') {
          const bytes = await readBody(req, maxBlob);
          if (createHash('sha256').update(bytes).digest('hex') !== b) throw new HttpError(400, 'The bytes do not match their sha256.');
          if (!(await deps.s3.head('ao-user-blobs', key))) await deps.s3.put('ao-user-blobs', key, bytes);
          return send(200, { blob_key: `ao-user-blobs/${key}`, bytes: bytes.length }), true;
        }
        if (m === 'GET') {
          const r = await deps.s3.request('GET', 'ao-user-blobs', key);
          if (r.status === 404) throw new HttpError(404, 'No such blob.');
          if (!r.ok) throw new HttpError(502, 'Blob storage failed.');
          return send(200, Buffer.from(await r.arrayBuffer()), 'application/octet-stream'), true;
        }
      }

      // ── document revisions: optimistic, the next revision must be latest + 1
      if (a === 'revisions' && m === 'POST') {
        const d = await json(req);
        const doc = id(d.doc_id, 'doc_id'), rev = Number(d.revision), hash = String(d.content_hash ?? '');
        if (!HASH.test(hash)) throw new HttpError(400, 'content_hash must be the sha256 of the encrypted bytes.');
        if (!Number.isSafeInteger(rev) || rev < 1) throw new HttpError(400, 'revision must be a positive integer.');
        if (deps.s3 && !(await deps.s3.head('ao-user-blobs', `${uid}/${hash}`))) throw new HttpError(409, 'Upload the blob before its revision.');
        const r = await q(async (cl) => {
          const latest = Number((await cl.query('SELECT coalesce(max(revision), 0) AS r FROM document_revisions WHERE doc_id = $1', [doc])).rows[0].r);
          if (rev !== latest + 1) throw new HttpError(409, `The document is at revision ${latest}; rebase on it and send ${latest + 1}.`, { latest });
          try {
            await cl.query(`INSERT INTO document_revisions(doc_id, revision, user_id, workspace_id, content_hash, blob_key, bytes, op_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [doc, rev, uid, d.workspace_id ? id(d.workspace_id, 'workspace_id') : null, hash, `ao-user-blobs/${uid}/${hash}`, Number(d.bytes ?? 0), str(d.op_id, 80)]);
          } catch (e) {
            if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Someone saved that revision first; rebase and retry.', { latest: rev });
            throw e;
          }
          return { doc_id: doc, revision: rev };
        });
        return send(200, r), true;
      }
      if (a === 'revisions' && b && m === 'GET') {
        const rows = await q(async (cl) => (await cl.query('SELECT doc_id, revision, workspace_id, content_hash, bytes, op_id, created_at FROM document_revisions WHERE doc_id = $1 ORDER BY revision DESC LIMIT 50', [id(b, 'doc_id')])).rows);
        return send(200, { revisions: rows.map((r) => ({ ...r, revision: Number(r.revision), bytes: Number(r.bytes) })) }), true;
      }

      // ── memory references (encrypted memory files)
      if (a === 'memory' && !b && m === 'GET') {
        // With ?since= (incremental) tombstones come too, as {deleted: true}; without it, live memories only.
        const since = url.searchParams.get('since');
        const rows = await q(async (cl) => (await cl.query(`SELECT memory_id, workspace_id, memory_uri, source_version, kind, blob_key, updated_at, updated_at::text AS cursor, deleted_at IS NOT NULL AS deleted
          FROM memory_references ${since !== null ? 'WHERE updated_at > $1' : 'WHERE deleted_at IS NULL'} ORDER BY updated_at`, since !== null ? [since || '-infinity'] : [])).rows);
        return send(200, { memories: rows }), true;
      }
      if (a === 'memory' && b && m === 'PUT') {
        const d = await json(req);
        const hash = d.blob_hash ? String(d.blob_hash) : null;
        if (hash && !HASH.test(hash)) throw new HttpError(400, 'blob_hash must be a sha256.');
        if (!Object.hasOwn(d, 'expected_version')) throw new HttpError(400, 'expected_version is required.');
        await q(async (cl) => {
          const mid = id(b, 'memory id');
          // Serialize even absent-row creations. The row lock protects updates; the advisory
          // lock also protects two devices creating the same id simultaneously.
          await cl.query('SELECT pg_advisory_xact_lock(hashtext($1))', [mid]);
          const current = (await cl.query('SELECT source_version, deleted_at FROM memory_references WHERE memory_id = $1 FOR UPDATE', [mid])).rows[0];
          const actual = current && !current.deleted_at ? current.source_version : null;
          if (actual !== d.expected_version) throw new HttpError(409, 'Memory changed on another device; pull and resolve the conflict.');
          await cl.query(`INSERT INTO memory_references(memory_id, user_id, workspace_id, memory_uri, source_version, kind, blob_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (memory_id) DO UPDATE SET source_version = excluded.source_version, kind = excluded.kind, blob_key = excluded.blob_key, deleted_at = NULL, updated_at = now() WHERE memory_references.user_id = $2`,
            [mid, uid, d.workspace_id ? id(d.workspace_id, 'workspace_id') : null, `mnemo://${uid}/${b}`, str(d.source_version, 80) ?? '', str(d.kind, 40), hash ? `ao-user-blobs/${uid}/${hash}` : null]);
        });
        return send(200, { ok: true }), true;
      }
      if (a === 'memory' && b && m === 'DELETE') {
        // A tombstone, not a delete: other devices learn the memory is gone on their next pull.
        const d = await json(req);
        if (!Object.hasOwn(d, 'expected_version')) throw new HttpError(400, 'expected_version is required.');
        await q(async (cl) => {
          const mid = id(b, 'memory id');
          await cl.query('SELECT pg_advisory_xact_lock(hashtext($1))', [mid]);
          const current = (await cl.query('SELECT source_version, deleted_at FROM memory_references WHERE memory_id = $1 FOR UPDATE', [mid])).rows[0];
          const actual = current && !current.deleted_at ? current.source_version : null;
          if (actual !== d.expected_version) throw new HttpError(409, 'Memory changed on another device; pull and resolve the conflict.');
          if (current && !current.deleted_at) await cl.query('UPDATE memory_references SET deleted_at = now(), updated_at = now(), blob_key = NULL WHERE memory_id = $1', [mid]);
        });
        return send(200, { ok: true }), true;
      }

      // ── device metrics (numbers only; System health)
      if (a === 'metrics' && m === 'POST') {
        const d = await json(req, 64_000);
        const metrics = d.metrics && typeof d.metrics === 'object' ? d.metrics as Record<string, unknown> : {};
        // Keep only numbers: names → number or {count,p50,p95,max}. Anything else is dropped.
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(metrics).slice(0, 50)) {
          if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
          if (typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
          else if (v && typeof v === 'object') {
            const o: Record<string, number> = {};
            for (const [kk, vv] of Object.entries(v as Record<string, unknown>).slice(0, 50)) if (/^[a-z0-9_]{1,40}$/.test(kk) && typeof vv === 'number' && Number.isFinite(vv)) o[kk] = vv;
            clean[k] = o;
          }
        }
        await q((cl) => cl.query('INSERT INTO device_metrics(user_id, device_id, metrics) VALUES ($1,$2,$3)', [uid, id(d.device_id, 'device_id'), JSON.stringify(clean)]));
        return send(200, { ok: true }), true;
      }

      // ── sync cursors (per device, per stream)
      if (a === 'cursors' && b && c) {
        if (m === 'GET') {
          const r = await q(async (cl) => (await cl.query('SELECT cursor, updated_at FROM sync_cursors WHERE device_id = $1 AND stream = $2', [id(b, 'device id'), id(c, 'stream')])).rows[0]);
          return send(200, r ?? { cursor: null }), true;
        }
        if (m === 'PUT') {
          const d = await json(req);
          await q((cl) => cl.query(`INSERT INTO sync_cursors(user_id, device_id, stream, cursor) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, device_id, stream) DO UPDATE SET cursor = excluded.cursor, updated_at = now()`,
            [uid, id(b, 'device id'), id(c, 'stream'), String(d.cursor ?? '').slice(0, 200)]));
          return send(200, { ok: true }), true;
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(status, { error: status === 500 ? 'Server error.' : (e as Error).message, ...(e instanceof HttpError ? e.extra : {}) });
      return true;
    }
  };
}
