// The sync API — the only thing a device talks to. Every request carries a Clerk session token;
// the server maps the Clerk user to our own user id and runs the request as ao_app inside a
// transaction with app.user_id set, so row-level security scopes every read and write to that
// user. Documents, transcripts and memories arrive already encrypted on the device: the server
// stores bytes and metadata, never plaintext.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { AuthError, type ClerkClaims } from '../auth/clerk.ts';
import type { S3 } from './s3.ts';

export interface SyncDeps {
  app: pg.Pool;
  verify(token: string): Promise<ClerkClaims>;
  s3?: S3;
  /** Clerk publishable key, handed to the desktop app's sign-in page (it is public). */
  publishableKey?: string;
  /** Every way a Clerk user can sign in (oauth_google, oauth_microsoft, …), from Clerk's Backend API.
   *  Session tokens carry neither the provider nor, for some Microsoft accounts, the email. */
  clerkIdentities?(clerkUserId: string): Promise<Array<{ provider: string; email?: string | null; image?: string | null }>>;
  /** Largest blob accepted (bytes). */
  maxBlobBytes?: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.extra = extra; }
}

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

  async function user(req: IncomingMessage): Promise<{ uid: string; claims: ClerkClaims }> {
    const tok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!tok) throw new HttpError(401, 'Sign in first.');
    if (tok.startsWith('aod_')) return { uid: await deviceUser(tok), claims: { sub: '', iss: 'ao-device', exp: 0 } };
    let claims: ClerkClaims;
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

  /** Desktop sign-in: a Clerk session token (from the browser) → a device token for this app. */
  async function exchange(req: IncomingMessage) {
    const d = await json(req, 20_000);
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
    const token = `aod_${randomBytes(32).toString('base64url')}`;
    return asUser(deps, uid, async (c) => {
      const t = (await c.query(`INSERT INTO device_tokens(id, user_id, token_hash, device_name, platform, expires_at)
        VALUES ($1,$2,$3,$4,$5, now() + interval '90 days') RETURNING expires_at`,
        [`dtk_${ulidish()}`, uid, sha(token), str(d.device_name, 200), str(d.platform, 40)])).rows[0];
      const u = (await c.query('SELECT id, email, display_name, avatar_url, role FROM users WHERE id = $1', [uid])).rows[0];
      return { token, expires_at: t.expires_at, user: u };
    });
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
      if (a === 'auth' && b === 'config' && m === 'GET') return send(200, { publishableKey: deps.publishableKey ?? null }), true;
      if (a === 'auth' && b === 'exchange' && m === 'POST') return send(200, await exchange(req)), true;
      const { uid, claims } = await user(req);
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
      if (a === 'me' && m === 'GET') {
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

      // ── memory references (Mnemo files synced as encrypted blobs)
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
        await q((cl) => cl.query(`INSERT INTO memory_references(memory_id, user_id, workspace_id, memory_uri, source_version, kind, blob_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (memory_id) DO UPDATE SET source_version = excluded.source_version, kind = excluded.kind, blob_key = excluded.blob_key, deleted_at = NULL, updated_at = now() WHERE memory_references.user_id = $2`,
          [id(b, 'memory id'), uid, d.workspace_id ? id(d.workspace_id, 'workspace_id') : null, `mnemo://${uid}/${b}`, str(d.source_version, 80) ?? '', str(d.kind, 40), hash ? `ao-user-blobs/${uid}/${hash}` : null]));
        return send(200, { ok: true }), true;
      }
      if (a === 'memory' && b && m === 'DELETE') {
        // A tombstone, not a delete: other devices learn the memory is gone on their next pull.
        await q((cl) => cl.query('UPDATE memory_references SET deleted_at = now(), updated_at = now(), blob_key = NULL WHERE memory_id = $1 AND deleted_at IS NULL', [id(b, 'memory id')]));
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
