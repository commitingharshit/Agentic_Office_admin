// Growth: which promotion (if any) a person sees on a placement, what they did with it, and their own choices.
//
// decide() is pure and deterministic: the same person, candidates, history and clock give the same answer, so the console's
// preview, the tests and the app agree. The order of authority, highest first:
//   1. the placement contract the app reports (a creative made for a newer contract is never sent to an older app)
//   2. hard gates: an ad-free plan or entitlement, the person's own "no promotions" choice and the promotions kill switch remove
//      every promo-tier campaign (release notes and task notices still reach them)
//   3. schedule, targeting and the campaign's feature flag
//   4. holdout: a fixed share of eligible people is shown nothing and recorded, so the campaign's effect can be measured
//   5. frequency: dismissed = never again; at most N impressions per window, at least M seconds apart
//   6. precedence: task > release > promo, then priority, then the newest start, then id
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../api/errors.ts';
import { bucket, evaluate, type Flag } from '../api/ops.ts';
import { validateAction, validateCard, type Action, type Card } from './promo-card.ts';

export const PLACEMENTS = ['chat_empty', 'inbox', 'bottom_strip'] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const KILL_SWITCH = 'killswitch.promotions';
export const MEDIA_BUCKET = 'ao-growth-media';
const TIER_RANK: Record<string, number> = { task: 0, release: 1, promo: 2 };
const DISCLOSURE: Record<string, string | undefined> = { promo: 'Featured', release: 'New release', task: undefined };

export interface Candidate {
  campaign: {
    id: string; status: string; tier: 'task' | 'release' | 'promo'; priority: number; starts_at: Date; ends_at: Date | null;
    holdout_pct: number; flag_key: string | null; max_impressions: number; per_seconds: number; min_gap_seconds: number;
  };
  target: {
    plan_ids: string[] | null; exclude_plan_ids: string[] | null; platforms: string[] | null; locales: string[] | null;
    min_app_version: string | null; signup_after: Date | null; signup_before: Date | null; user_ids: string[] | null;
  } | null;
  creative: {
    id: string; placement_id: string; kind: 'image' | 'clip' | 'card'; contract_version: number; headline: string; body: string;
    cta_label: string | null; cta_action: unknown; card: unknown;
  };
}
export interface Exposure { shown_at: Date[]; dismissed_at: Date | null }
export interface Context {
  userId: string; plan: string; adFree: boolean; inApp: boolean; flags: Flag[];
  platform?: string; locale?: string; appVersion?: string; signedUpAt?: Date; contract: number;
}
export type Decision =
  | { kind: 'show'; candidate: Candidate; card?: Card; cta?: Action }
  | { kind: 'holdout'; campaignId: string }
  | { kind: 'none'; reasons: Record<string, string> };

/** "1.10.2" vs "1.9" by numbers, missing parts are 0. */
export function versionAtLeast(have: string | undefined, want: string): boolean {
  if (!have || !/^\d+(\.\d+){0,2}/.test(have)) return false;
  const a = have.split(/[.+-]/).slice(0, 3).map(Number), b = want.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x > y; }
  return true;
}

function targeted(t: Candidate['target'], ctx: Context): string | undefined {
  if (!t) return undefined;
  if (t.user_ids && !t.user_ids.includes(ctx.userId)) return 'not in the listed people';
  if (t.plan_ids && !t.plan_ids.includes(ctx.plan)) return `plan ${ctx.plan} not targeted`;
  if (t.exclude_plan_ids && t.exclude_plan_ids.includes(ctx.plan)) return `plan ${ctx.plan} excluded`;
  if (t.platforms && (!ctx.platform || !t.platforms.includes(ctx.platform))) return 'platform not targeted';
  if (t.locales && (!ctx.locale || !t.locales.some((l) => ctx.locale!.toLowerCase().startsWith(l.toLowerCase())))) return 'locale not targeted';
  if (t.min_app_version && !versionAtLeast(ctx.appVersion, t.min_app_version)) return 'app too old';
  if (t.signup_after && (!ctx.signedUpAt || ctx.signedUpAt < t.signup_after)) return 'signed up too early';
  if (t.signup_before && (!ctx.signedUpAt || ctx.signedUpAt >= t.signup_before)) return 'signed up too late';
  return undefined;
}

/** Why a candidate is not shown now, or undefined when it may be (before precedence). */
function blocked(c: Candidate, ctx: Context, ex: Exposure | undefined, now: Date): string | undefined {
  const { campaign: k, creative } = c;
  if (creative.contract_version > ctx.contract) return `needs placement contract ${creative.contract_version}`;
  if (k.tier === 'promo') {
    if (ctx.adFree) return 'ad-free';
    if (!ctx.inApp) return 'promotions switched off by the person';
    const kill = ctx.flags.find((f) => f.key === KILL_SWITCH);
    if (kill && evaluate(kill, ctx.userId, ctx.plan)) return 'kill switch';
  }
  if (k.status !== 'live' && k.status !== 'scheduled') return `status ${k.status}`;
  if (now < k.starts_at) return 'not started';
  if (k.ends_at && now >= k.ends_at) return 'ended';
  const t = targeted(c.target, ctx);
  if (t) return t;
  if (k.flag_key) {
    const f = ctx.flags.find((x) => x.key === k.flag_key);
    if (!f || !evaluate(f, ctx.userId, ctx.plan)) return `flag ${k.flag_key} off`;
  }
  if (ex?.dismissed_at) return 'dismissed';
  const shown = (ex?.shown_at ?? []).filter((d) => now.getTime() - d.getTime() < k.per_seconds * 1000);
  if (shown.length >= k.max_impressions) return 'frequency cap';
  const last = shown.reduce<number>((m, d) => Math.max(m, d.getTime()), 0);
  if (last && now.getTime() - last < k.min_gap_seconds * 1000) return 'too soon since the last time';
  return undefined;
}

export function decide(ctx: Context, candidates: Candidate[], exposure: Map<string, Exposure>, now: Date): Decision {
  const reasons: Record<string, string> = {};
  const ok: Candidate[] = [];
  for (const c of candidates) {
    const why = blocked(c, ctx, exposure.get(c.campaign.id), now);
    if (why) { reasons[c.campaign.id] = why; continue; }
    // A creative that no longer validates (a contract changed under it) is skipped, never rendered half-right.
    if (c.creative.kind === 'card' && !validateCard(c.creative.card).ok) { reasons[c.campaign.id] = 'card does not validate'; continue; }
    if (c.creative.cta_action != null && !validateAction(c.creative.cta_action).ok) { reasons[c.campaign.id] = 'action does not validate'; continue; }
    ok.push(c);
  }
  ok.sort((a, b) => (TIER_RANK[a.campaign.tier] - TIER_RANK[b.campaign.tier]) || (b.campaign.priority - a.campaign.priority)
    || (b.campaign.starts_at.getTime() - a.campaign.starts_at.getTime()) || (a.campaign.id < b.campaign.id ? -1 : a.campaign.id > b.campaign.id ? 1 : 0));
  const pick = ok[0];
  if (!pick) return { kind: 'none', reasons };
  if (pick.campaign.holdout_pct > 0 && bucket(ctx.userId, `holdout:${pick.campaign.id}`) < pick.campaign.holdout_pct) {
    return { kind: 'holdout', campaignId: pick.campaign.id };
  }
  const card = pick.creative.kind === 'card' ? validateCard(pick.creative.card).value : undefined;
  const cta = pick.creative.cta_action != null ? validateAction(pick.creative.cta_action).value : undefined;
  if (card && DISCLOSURE[pick.campaign.tier]) card.disclosure = DISCLOSURE[pick.campaign.tier];
  return { kind: 'show', candidate: pick, card, cta };
}

// ── media links ────────────────────────────────────────────────────────────────────────────────────
// The app plays clips and shows images from links like a presigned URL: /v1/promotions/media/<id>?e=<expiry>&s=<signature>.
// The signature is an HMAC over the media id and expiry with the server's key, so the link works in <video src> (no header),
// expires within the hour and cannot be pointed at any other object.

export function mediaKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const k = env.AO_MEDIA_SIGNING_KEY?.trim();
  return k && k.length >= 32 ? Buffer.from(k) : randomBytes(32);   // without one, links last only for this process's life
}
/** A link for one media file. The expiry is rounded up to the next hour (and an hour on), so a link is stable for an hour and the
 *  app's cache can reuse it. */
export function mediaLink(key: Buffer, mediaId: number, now = Date.now()): string {
  const expires = (Math.floor(now / 3600_000) + 2) * 3600;
  return `/v1/promotions/media/${mediaId}?e=${expires}&s=${signMedia(key, mediaId, expires)}`;
}
export function signMedia(key: Buffer, mediaId: number, expires: number): string {
  return createHmac('sha256', key).update(`${mediaId}.${expires}`).digest('base64url');
}
export function verifyMedia(key: Buffer, mediaId: number, expires: number, sig: string, now = Date.now()): boolean {
  if (!Number.isInteger(mediaId) || !Number.isInteger(expires) || expires * 1000 < now || expires * 1000 > now + 2 * 3600_000) return false;
  const want = Buffer.from(signMedia(key, mediaId, expires)), got = Buffer.from(sig ?? '');
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── loading what decide() needs ───────────────────────────────────────────────────────────────────

export async function contextFor(c: pg.PoolClient, userId: string, q: URLSearchParams): Promise<Context> {
  const contract = Number(q.get('contract') ?? '1');
  if (!Number.isInteger(contract) || contract < 1 || contract > 100) throw new HttpError(400, 'contract must be a placement contract version.');
  const row = (await c.query(`
    SELECT coalesce((SELECT plan_id FROM subscriptions WHERE user_id = $1 AND status = 'active'), 'free') AS plan,
           u.created_at,
           coalesce(p.in_app, true) AS in_app,
           coalesce((SELECT (pl.features->>'ad_free')::boolean FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
                     WHERE s.user_id = $1 AND s.status = 'active'), false)
             OR EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = $1 AND e.key = 'ad_free' AND e.value = 'true'::jsonb
                        AND (e.expires_at IS NULL OR e.expires_at > now())) AS ad_free
      FROM users u LEFT JOIN user_promo_prefs p ON p.user_id = u.id WHERE u.id = $1`, [userId])).rows[0];
  if (!row) throw new HttpError(404, 'No such person.');
  const flags = (await c.query('SELECT key, enabled, rollout_pct, plan_ids FROM feature_flags')).rows as Flag[];
  const s = (k: string, re: RegExp) => { const v = q.get(k) ?? undefined; return v && re.test(v) ? v : undefined; };
  return {
    userId, plan: row.plan, adFree: !!row.ad_free, inApp: row.in_app, flags, contract, signedUpAt: row.created_at,
    platform: s('platform', /^(darwin|win32|linux)$/), locale: s('locale', /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/), appVersion: s('app_version', /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/),
  };
}

export async function candidatesFor(c: pg.PoolClient, placement: Placement): Promise<Candidate[]> {
  const r = await c.query(`
    SELECT k.id, k.status, k.tier, k.priority, k.starts_at, k.ends_at, k.holdout_pct, k.flag_key, k.max_impressions, k.per_seconds, k.min_gap_seconds,
           t.campaign_id AS t_id, t.plan_ids, t.exclude_plan_ids, t.platforms, t.locales, t.min_app_version, t.signup_after, t.signup_before, t.user_ids,
           cr.id AS cr_id, cr.placement_id, cr.kind, cr.contract_version, cr.headline, cr.body, cr.cta_label, cr.cta_action, cr.card
      FROM campaigns k JOIN creatives cr ON cr.campaign_id = k.id AND cr.placement_id = $1 AND cr.status = 'ready'
      LEFT JOIN campaign_targets t ON t.campaign_id = k.id
     WHERE k.status IN ('live', 'scheduled')`, [placement]);
  return r.rows.map((x) => ({
    campaign: { id: x.id, status: x.status, tier: x.tier, priority: x.priority, starts_at: x.starts_at, ends_at: x.ends_at, holdout_pct: x.holdout_pct,
      flag_key: x.flag_key, max_impressions: x.max_impressions, per_seconds: x.per_seconds, min_gap_seconds: x.min_gap_seconds },
    target: x.t_id ? { plan_ids: x.plan_ids, exclude_plan_ids: x.exclude_plan_ids, platforms: x.platforms, locales: x.locales, min_app_version: x.min_app_version,
      signup_after: x.signup_after, signup_before: x.signup_before, user_ids: x.user_ids } : null,
    creative: { id: x.cr_id, placement_id: x.placement_id, kind: x.kind, contract_version: x.contract_version, headline: x.headline, body: x.body,
      cta_label: x.cta_label, cta_action: x.cta_action, card: x.card },
  }));
}

export async function exposureFor(c: pg.PoolClient, userId: string): Promise<Map<string, Exposure>> {
  const r = await c.query('SELECT campaign_id, shown_at, dismissed_at FROM promo_exposure WHERE user_id = $1', [userId]);
  return new Map(r.rows.map((x) => [x.campaign_id as string, { shown_at: x.shown_at as Date[], dismissed_at: x.dismissed_at as Date | null }]));
}

const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_TYPES = new Set(['impression', 'view', 'click', 'dismiss', 'conversion']);
const holdoutEventId = (userId: string, campaignId: string, now: Date) =>
  `h_${createHash('sha256').update(`${userId}:${campaignId}:${now.toISOString().slice(0, 10)}`).digest('base64url').slice(0, 40)}`;

/** GET /v1/promotions/eligible: at most one item for the placement. A holdout records its exposure (once a day) and returns none. */
export async function eligible(c: pg.PoolClient, userId: string, q: URLSearchParams, media: (mediaId: number) => string, now = new Date()) {
  const placement = q.get('placement') as Placement;
  if (!PLACEMENTS.includes(placement)) throw new HttpError(400, `placement must be one of ${PLACEMENTS.join(', ')}.`);
  const ctx = await contextFor(c, userId, q);
  const d = decide(ctx, await candidatesFor(c, placement), await exposureFor(c, userId), now);
  const ttl = 300;
  if (d.kind === 'holdout') {
    const consent = (await c.query('SELECT shared FROM usage_consent WHERE user_id = $1', [userId])).rows[0]?.shared === true;
    await c.query(`INSERT INTO promo_events(event_id, user_id, campaign_id, placement, type) VALUES ($1, $2, $3, $4, 'holdout') ON CONFLICT (event_id) DO NOTHING`,
      [holdoutEventId(userId, d.campaignId, now), consent ? userId : null, d.campaignId, placement]);
    return { placement, item: null, ttl };
  }
  if (d.kind === 'none') return { placement, item: null, ttl };
  const { campaign, creative } = d.candidate;
  const files = (await c.query('SELECT id, role, width, height, mime, bytes FROM creative_media WHERE creative_id = $1 AND role <> \'source\' ORDER BY role, width', [creative.id])).rows;
  if (creative.kind === 'clip' && !files.some((f) => f.role === 'mp4' || f.role === 'webm')) return { placement, item: null, ttl };
  return {
    placement, ttl,
    item: {
      campaign_id: campaign.id, creative_id: creative.id, tier: campaign.tier, kind: creative.kind, disclosure: DISCLOSURE[campaign.tier] ?? null,
      headline: creative.headline, body: creative.body, cta_label: creative.cta_label, cta_action: d.cta ?? null, card: d.card ?? null,
      media: files.map((f) => ({ role: f.role, width: f.width, height: f.height, mime: f.mime, bytes: f.bytes, url: media(Number(f.id)) })),
    },
  };
}

/** POST /v1/promotions/events: what the app showed and what the person did. Counted once per event id; linked to the person only
 *  if they share usage. Impressions and dismissals also update the per-person exposure that frequency caps read. */
export async function recordEvents(c: pg.PoolClient, userId: string, body: Record<string, unknown>) {
  const list = Array.isArray(body.events) ? body.events : null;
  if (!list || list.length < 1 || list.length > 50) throw new HttpError(400, 'events must list 1-50 events.');
  const consent = (await c.query('SELECT shared FROM usage_consent WHERE user_id = $1', [userId])).rows[0]?.shared === true;
  let accepted = 0, duplicate = 0;
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    if (typeof e.event_id !== 'string' || !EVENT_ID.test(e.event_id)) throw new HttpError(400, 'event_id must be 8-64 letters, digits, - or _.');
    if (typeof e.type !== 'string' || !EVENT_TYPES.has(e.type)) throw new HttpError(400, 'type must be impression, view, click, dismiss or conversion.');
    if (typeof e.placement !== 'string' || !PLACEMENTS.includes(e.placement as Placement)) throw new HttpError(400, 'Unknown placement.');
    // The creative must belong to the campaign and to that placement: the app cannot invent pairings for someone else's numbers.
    const own = (await c.query('SELECT 1 FROM creatives WHERE id = $1 AND campaign_id = $2 AND placement_id = $3', [e.creative_id, e.campaign_id, e.placement])).rowCount;
    if (!own) throw new HttpError(400, 'That creative is not part of that campaign on that placement.');
    const ins = await c.query(`INSERT INTO promo_events(event_id, user_id, campaign_id, creative_id, placement, type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (event_id) DO NOTHING`,
      [e.event_id, consent ? userId : null, e.campaign_id, e.creative_id, e.placement, e.type]);
    if (!ins.rowCount) { duplicate++; continue; }
    accepted++;
    if (e.type === 'impression') {
      await c.query(`INSERT INTO promo_exposure(user_id, campaign_id, shown_at) VALUES ($1, $2, ARRAY[now()])
        ON CONFLICT (user_id, campaign_id) DO UPDATE SET shown_at = (promo_exposure.shown_at || now())[greatest(1, cardinality(promo_exposure.shown_at) - 98):]`, [userId, e.campaign_id]);
    } else if (e.type === 'dismiss') {
      await c.query(`INSERT INTO promo_exposure(user_id, campaign_id, dismissed_at) VALUES ($1, $2, now())
        ON CONFLICT (user_id, campaign_id) DO UPDATE SET dismissed_at = coalesce(promo_exposure.dismissed_at, now())`, [userId, e.campaign_id]);
    }
  }
  return { accepted, duplicate, linked: consent };
}

export async function getPrefs(c: pg.PoolClient, userId: string) {
  const r = (await c.query('SELECT in_app, email_marketing, unsubscribed_at FROM user_promo_prefs WHERE user_id = $1', [userId])).rows[0];
  return r ?? { in_app: true, email_marketing: false, unsubscribed_at: null };
}
export async function setPrefs(c: pg.PoolClient, userId: string, b: Record<string, unknown>) {
  for (const k of ['in_app', 'email_marketing']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false.`);
  await c.query(`INSERT INTO user_promo_prefs(user_id, in_app, email_marketing, unsubscribed_at) VALUES ($1, coalesce($2, true), coalesce($3, false), CASE WHEN $3 = false THEN now() END)
    ON CONFLICT (user_id) DO UPDATE SET in_app = coalesce($2, user_promo_prefs.in_app), email_marketing = coalesce($3, user_promo_prefs.email_marketing),
      unsubscribed_at = CASE WHEN $3 = true THEN NULL WHEN $3 = false THEN coalesce(user_promo_prefs.unsubscribed_at, now()) ELSE user_promo_prefs.unsubscribed_at END,
      updated_at = now()`, [userId, b.in_app ?? null, b.email_marketing ?? null]);
  return getPrefs(c, userId);
}
