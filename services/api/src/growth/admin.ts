// Growth in the admin API: campaigns, creatives and their media, audiences, releases and their staged rollouts, the funnel and
// its guardrails. Mounted by src/api/admin.ts under /admin/growth/*; every route checks its permission there-style (need) and
// every change is written to admin_audit. Reads use the read-only pool, changes the admin pool.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type pg from 'pg';
import type { AdminDeps } from '../api/admin.ts';
import { HttpError } from '../api/errors.ts';
import type { Permission } from '../api/rbac.ts';
import { candidatesFor, contextFor, decide, exposureFor, MEDIA_BUCKET, PLACEMENTS, type Placement } from './engine.ts';
import { validateAction, validateCard } from './promo-card.ts';
import * as email from './email.ts';

type Audit = (action: string, target: string | null, detail?: Record<string, unknown>) => Promise<void>;
export interface GrowthCtx { deps: AdminDeps; adminId: string; need(p: Permission): Promise<void>; audit: Audit }

const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
const text = (v: unknown, what: string, min: number, max: number): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) throw new HttpError(400, `${what} must be ${min}-${max} characters.`);
  return s;
};
const int = (v: unknown, what: string, min: number, max: number, dflt?: number): number => {
  if (v === undefined || v === null) { if (dflt === undefined) throw new HttpError(400, `${what} is required.`); return dflt; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}.`);
  return n;
};
const date = (v: unknown, what: string): Date | null => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${what} must be a date.`);
  return d;
};
const list = (v: unknown, what: string, re: RegExp): string[] | null => {
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || !re.test(x))) throw new HttpError(400, `${what} must be a list.`);
  return v as string[];
};
const oneOf = <T extends string>(v: unknown, what: string, allowed: readonly T[], dflt?: T): T => {
  if ((v === undefined || v === null) && dflt) return dflt;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new HttpError(400, `${what} must be one of ${allowed.join(', ')}.`);
  return v as T;
};

// ── campaigns ────────────────────────────────────────────────────────────────────────────────────

export async function listCampaigns(deps: AdminDeps) {
  const list = await rows(deps.ro, `
    SELECT k.*, (SELECT json_agg(json_build_object('id', c.id, 'placement', c.placement_id, 'kind', c.kind, 'status', c.status, 'error', c.error,
                     'headline', c.headline, 'body', c.body, 'cta_label', c.cta_label, 'cta_action', c.cta_action, 'card', c.card, 'updated_at', c.updated_at,
                     'media', (SELECT coalesce(json_agg(json_build_object('role', m.role, 'width', m.width, 'bytes', m.bytes) ORDER BY m.role, m.width), '[]') FROM creative_media m WHERE m.creative_id = c.id),
                     'job', (SELECT json_build_object('status', j.status, 'error', j.error) FROM media_jobs j WHERE j.creative_id = c.id ORDER BY j.id DESC LIMIT 1))
                   ORDER BY c.placement_id)
                   FROM creatives c WHERE c.campaign_id = k.id) AS creatives,
           to_jsonb(t) - 'campaign_id' AS target
      FROM campaigns k LEFT JOIN campaign_targets t ON t.campaign_id = k.id ORDER BY k.created_at DESC LIMIT 200`);
  return { campaigns: list, placements: await rows(deps.ro, 'SELECT * FROM placements ORDER BY id') };
}

function campaignFields(b: Record<string, unknown>) {
  const starts = date(b.starts_at, 'starts_at'), ends = date(b.ends_at, 'ends_at');
  if (starts && ends && ends <= starts) throw new HttpError(400, 'ends_at must be after starts_at.');
  return {
    name: text(b.name, 'name', 1, 160),
    tier: oneOf(b.tier, 'tier', ['task', 'release', 'promo'] as const, 'promo'),
    priority: int(b.priority, 'priority', -100, 100, 0),
    starts_at: starts, ends_at: ends,
    holdout_pct: int(b.holdout_pct, 'holdout_pct', 0, 50, 0),
    flag_key: b.flag_key === undefined || b.flag_key === null || b.flag_key === '' ? null : text(b.flag_key, 'flag_key', 1, 60),
    max_impressions: int(b.max_impressions, 'max_impressions', 1, 100, 3),
    per_seconds: int(b.per_seconds, 'per_seconds', 60, 31536000, 86400),
    min_gap_seconds: int(b.min_gap_seconds, 'min_gap_seconds', 0, 31536000, 3600),
  };
}

export async function saveCampaign(g: GrowthCtx, id: string | undefined, b: Record<string, unknown>) {
  await g.need('growth.write');
  const f = campaignFields(b);
  if (id && !ID.test(id)) throw new HttpError(400, 'Not a campaign id.');
  const cid = id ?? newId('cmp');
  if (f.flag_key && !(await rows(g.deps.ro, 'SELECT 1 FROM feature_flags WHERE key = $1', [f.flag_key])).length) throw new HttpError(400, 'No such feature flag.');
  const r = await g.deps.admin.query(`
    INSERT INTO campaigns(id, name, tier, priority, starts_at, ends_at, holdout_pct, flag_key, max_impressions, per_seconds, min_gap_seconds, created_by)
    VALUES ($1,$2,$3,$4,coalesce($5, now()),$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, priority = EXCLUDED.priority, starts_at = coalesce($5, campaigns.starts_at),
      ends_at = EXCLUDED.ends_at, holdout_pct = EXCLUDED.holdout_pct, flag_key = EXCLUDED.flag_key, max_impressions = EXCLUDED.max_impressions,
      per_seconds = EXCLUDED.per_seconds, min_gap_seconds = EXCLUDED.min_gap_seconds, updated_at = now()
    RETURNING *`, [cid, f.name, f.tier, f.priority, f.starts_at, f.ends_at, f.holdout_pct, f.flag_key, f.max_impressions, f.per_seconds, f.min_gap_seconds, g.adminId]);
  await g.audit(id ? 'update_campaign' : 'create_campaign', null, { campaign: cid, name: f.name, tier: f.tier });
  return { campaign: r.rows[0] };
}

export async function setTargets(g: GrowthCtx, id: string, b: Record<string, unknown>) {
  await g.need('growth.write');
  const plan = /^[a-z0-9_-]{1,40}$/;
  const t = {
    plan_ids: list(b.plan_ids, 'plan_ids', plan), exclude_plan_ids: list(b.exclude_plan_ids, 'exclude_plan_ids', plan),
    platforms: list(b.platforms, 'platforms', /^(darwin|win32|linux)$/), locales: list(b.locales, 'locales', /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/),
    min_app_version: b.min_app_version ? text(b.min_app_version, 'min_app_version', 1, 20) : null,
    signup_after: date(b.signup_after, 'signup_after'), signup_before: date(b.signup_before, 'signup_before'),
    user_ids: list(b.user_ids, 'user_ids', /^usr_[a-z0-9]{1,40}$/),
  };
  const r = await g.deps.admin.query(`
    INSERT INTO campaign_targets(campaign_id, plan_ids, exclude_plan_ids, platforms, locales, min_app_version, signup_after, signup_before, user_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (campaign_id) DO UPDATE SET plan_ids = $2, exclude_plan_ids = $3, platforms = $4, locales = $5, min_app_version = $6,
      signup_after = $7, signup_before = $8, user_ids = $9 RETURNING *`,
    [id, t.plan_ids, t.exclude_plan_ids, t.platforms, t.locales, t.min_app_version, t.signup_after, t.signup_before, t.user_ids]).catch((e) => {
    if ((e as { code?: string }).code === '23503') throw new HttpError(404, 'No such campaign.');
    throw e;
  });
  await g.audit('set_campaign_targets', null, { campaign: id, ...t });
  return { target: r.rows[0] };
}

/** live / paused / ended / scheduled. Going live needs at least one ready creative. */
export async function setStatus(g: GrowthCtx, id: string, b: Record<string, unknown>) {
  await g.need('growth.publish');
  const status = oneOf(b.status, 'status', ['scheduled', 'live', 'paused', 'ended'] as const);
  if (status === 'live' || status === 'scheduled') {
    const ready = await rows(g.deps.ro, `SELECT 1 FROM creatives WHERE campaign_id = $1 AND status = 'ready'`, [id]);
    if (!ready.length) throw new HttpError(409, 'A campaign goes live only with at least one ready creative.');
  }
  const r = await g.deps.admin.query(`UPDATE campaigns SET status = $2, paused_reason = CASE WHEN $2 = 'paused' THEN $3 ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING id, status`,
    [id, status, typeof b.reason === 'string' ? b.reason.slice(0, 200) : 'paused by an admin']);
  if (!r.rowCount) throw new HttpError(404, 'No such campaign.');
  await g.audit('set_campaign_status', null, { campaign: id, status });
  return r.rows[0];
}

// ── creatives ────────────────────────────────────────────────────────────────────────────────────

export async function saveCreative(g: GrowthCtx, campaignId: string, b: Record<string, unknown>) {
  await g.need('growth.write');
  const placement = oneOf(b.placement, 'placement', PLACEMENTS);
  const kind = oneOf(b.kind, 'kind', ['image', 'clip', 'card'] as const);
  const [p] = await rows(g.deps.ro, 'SELECT * FROM placements WHERE id = $1', [placement]);
  if (!p.allowed_kinds.includes(kind)) throw new HttpError(400, `The ${placement} placement does not take ${kind} creatives.`);
  let card: unknown = null;
  if (kind === 'card') {
    const v = validateCard(b.card);
    if (!v.ok) throw new HttpError(400, `The card does not validate: ${v.errors.slice(0, 5).join('; ')}`);
    card = v.value;
  }
  let action: unknown = null;
  if (b.cta_action !== undefined && b.cta_action !== null) {
    const v = validateAction(b.cta_action, 'cta_action');
    if (!v.ok) throw new HttpError(400, v.errors.join('; '));
    action = v.value;
  }
  const headline = typeof b.headline === 'string' ? b.headline.trim().slice(0, 120) : '';
  const bodyText = typeof b.body === 'string' ? b.body.trim().slice(0, 400) : '';
  if (kind !== 'card' && !headline) throw new HttpError(400, 'An image or clip creative needs a headline (it is also the text people read when media cannot load).');
  const id = newId('crv');
  const r = await g.deps.admin.query(`
    INSERT INTO creatives(id, campaign_id, placement_id, kind, contract_version, headline, body, cta_label, cta_action, card, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11)
    ON CONFLICT (campaign_id, placement_id) DO UPDATE SET kind = EXCLUDED.kind, contract_version = EXCLUDED.contract_version, headline = EXCLUDED.headline,
      body = EXCLUDED.body, cta_label = EXCLUDED.cta_label, cta_action = EXCLUDED.cta_action, card = EXCLUDED.card, status = 'draft', error = NULL, updated_at = now()
    RETURNING *`, [id, campaignId, placement, kind, p.contract_version, headline, bodyText,
      typeof b.cta_label === 'string' && b.cta_label.trim() ? b.cta_label.trim().slice(0, 40) : null,
      action === null ? null : JSON.stringify(action), card === null ? null : JSON.stringify(card), g.adminId]).catch((e) => {
    if ((e as { code?: string }).code === '23503') throw new HttpError(404, 'No such campaign.');
    throw e;
  });
  await g.audit('save_creative', null, { campaign: campaignId, creative: r.rows[0].id, placement, kind });
  return { creative: r.rows[0] };
}

const MEDIA_TYPES: Record<string, 'image' | 'clip'> = { 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'video/mp4': 'clip', 'video/webm': 'clip', 'video/quicktime': 'clip' };
const MAX_SOURCE = { image: 10_000_000, clip: 60_000_000 };

/** The raw upload (the console proxies the file). It is stored as the source and queued for the media worker. */
export async function uploadMedia(g: GrowthCtx, creativeId: string, req: IncomingMessage) {
  await g.need('growth.write');
  if (!g.deps.s3) throw new HttpError(503, 'Media storage is not configured on this server.');
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const kind = MEDIA_TYPES[type];
  if (!kind) throw new HttpError(415, 'Upload a PNG, JPEG or WebP image, or an MP4, WebM or MOV clip.');
  const [cr] = await rows(g.deps.ro, 'SELECT id, kind FROM creatives WHERE id = $1', [creativeId]);
  if (!cr) throw new HttpError(404, 'No such creative.');
  if (cr.kind === 'clip' && kind !== 'clip') throw new HttpError(400, 'A clip creative needs a video.');
  if (cr.kind === 'image' && kind !== 'image') throw new HttpError(400, 'An image creative needs an image.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_SOURCE[kind]) throw new HttpError(413, `The file is larger than ${MAX_SOURCE[kind] / 1e6} MB.`); chunks.push(c as Buffer); }
  if (!size) throw new HttpError(400, 'The upload is empty.');
  const bytes = Buffer.concat(chunks);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = `source/${creativeId}/${sha}`;
  await g.deps.s3.put(MEDIA_BUCKET, key, bytes);
  await g.deps.admin.query(`DELETE FROM creative_media WHERE creative_id = $1`, [creativeId]);
  await g.deps.admin.query(`INSERT INTO creative_media(creative_id, role, width, s3_key, mime, bytes, sha256) VALUES ($1,'source',0,$2,$3,$4,$5)`, [creativeId, key, type, size, sha]);
  const job = await g.deps.admin.query(`INSERT INTO media_jobs(creative_id, source_key, kind) VALUES ($1,$2,$3) RETURNING id`, [creativeId, key, kind]);
  await g.deps.admin.query(`UPDATE creatives SET status = 'processing', error = NULL, updated_at = now() WHERE id = $1`, [creativeId]);
  await g.audit('upload_creative_media', null, { creative: creativeId, bytes: size, sha256: sha, type });
  return { job: job.rows[0].id, bytes: size, sha256: sha };
}

/** A creative becomes 'ready' (servable) only when its card validates and its media, if it has any, is processed. */
export async function publishCreative(g: GrowthCtx, creativeId: string) {
  await g.need('growth.publish');
  const [cr] = await rows(g.deps.ro, 'SELECT * FROM creatives WHERE id = $1', [creativeId]);
  if (!cr) throw new HttpError(404, 'No such creative.');
  if (cr.kind === 'card') {
    const v = validateCard(cr.card);
    if (!v.ok) throw new HttpError(409, `The card no longer validates: ${v.errors.slice(0, 3).join('; ')}`);
    const posterNeeded = v.value!.blocks.some((bl) => bl.type === 'image');
    if (posterNeeded && !(await rows(g.deps.ro, `SELECT 1 FROM creative_media WHERE creative_id = $1 AND role IN ('image','poster')`, [creativeId])).length) {
      throw new HttpError(409, 'The card shows an image: upload one first.');
    }
  } else {
    const want = cr.kind === 'clip' ? ['mp4', 'poster'] : ['image'];
    const have = (await rows(g.deps.ro, 'SELECT DISTINCT role FROM creative_media WHERE creative_id = $1', [creativeId])).map((r) => r.role);
    const missing = want.filter((w) => !have.includes(w));
    if (missing.length) throw new HttpError(409, `The media is not processed yet (missing ${missing.join(', ')}).`);
  }
  await g.deps.admin.query(`UPDATE creatives SET status = 'ready', error = NULL, updated_at = now() WHERE id = $1`, [creativeId]);
  await g.audit('publish_creative', null, { creative: creativeId });
  return { id: creativeId, status: 'ready' };
}

// ── audiences and previews ───────────────────────────────────────────────────────────────────────

/** How many active people a target would reach (before frequency and holdout), and how many of them are ad-free or opted out. */
export async function audienceSize(deps: AdminDeps, b: Record<string, unknown>) {
  const plans = list(b.plan_ids, 'plan_ids', /^[a-z0-9_-]{1,40}$/), excl = list(b.exclude_plan_ids, 'exclude_plan_ids', /^[a-z0-9_-]{1,40}$/);
  const [r] = await rows(deps.ro, `
    WITH p AS (SELECT u.id, coalesce(s.plan_id, 'free') AS plan, coalesce((pl.features->>'ad_free')::boolean, false) AS ad_free, coalesce(pp.in_app, true) AS in_app
                 FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' LEFT JOIN plans pl ON pl.id = s.plan_id
                 LEFT JOIN user_promo_prefs pp ON pp.user_id = u.id WHERE u.status = 'active')
    SELECT count(*)::int AS matched, count(*) FILTER (WHERE ad_free)::int AS ad_free, count(*) FILTER (WHERE NOT in_app)::int AS opted_out
      FROM p WHERE ($1::text[] IS NULL OR plan = ANY($1)) AND ($2::text[] IS NULL OR NOT plan = ANY($2))`, [plans, excl]);
  return { ...r, reachable_promo: r.matched - r.ad_free - r.opted_out };
}

/** What one person would see on a placement right now, and why every other campaign is not shown. Reads only. */
export async function previewFor(deps: AdminDeps, b: Record<string, unknown>) {
  const userId = text(b.user_id, 'user_id', 5, 60);
  const placement = oneOf(b.placement, 'placement', PLACEMENTS) as Placement;
  const c = await deps.ro.connect();
  try {
    // As that person (row-level security), read-only: the preview sees exactly their exposure and plan, and changes nothing.
    await c.query('BEGIN READ ONLY');
    await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const q = new URLSearchParams({ placement, contract: String(b.contract ?? 1), ...(typeof b.platform === 'string' ? { platform: b.platform } : {}) });
    const ctx = await contextFor(c, userId, q);
    const d = decide(ctx, await candidatesFor(c, placement), await exposureFor(c, userId), new Date());
    return { plan: ctx.plan, ad_free: ctx.adFree, in_app: ctx.inApp, decision: d.kind === 'show' ? { kind: 'show', campaign: d.candidate.campaign.id, creative: d.candidate.creative.id } : d };
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

// ── releases ─────────────────────────────────────────────────────────────────────────────────────

export async function listReleases(deps: AdminDeps) {
  return { releases: await rows(deps.ro, `SELECT r.*, (SELECT json_agg(x ORDER BY x.id) FROM release_rollouts x WHERE x.release_id = r.id) AS rollouts,
    (SELECT rollout_pct FROM feature_flags f WHERE f.key = r.flag_key) AS current_pct FROM releases r ORDER BY r.created_at DESC LIMIT 100`) };
}

export async function saveRelease(g: GrowthCtx, b: Record<string, unknown>) {
  await g.need('releases.write');
  const version = text(b.version, 'version', 5, 40);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) throw new HttpError(400, 'version must look like 1.5.0.');
  const channel = oneOf(b.channel, 'channel', ['canary', 'beta', 'stable'] as const, 'stable');
  const flag = b.flag_key ? text(b.flag_key, 'flag_key', 1, 60) : null;
  if (flag && !(await rows(g.deps.ro, 'SELECT 1 FROM feature_flags WHERE key = $1', [flag])).length) throw new HttpError(400, 'No such feature flag.');
  const id = `rel_${version.replace(/[^0-9A-Za-z.-]/g, '-')}_${channel}`;
  const r = await g.deps.admin.query(`INSERT INTO releases(id, version, channel, title, notes_md, flag_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, notes_md = EXCLUDED.notes_md, flag_key = EXCLUDED.flag_key RETURNING *`,
    [id, version, channel, text(b.title, 'title', 1, 160), typeof b.notes_md === 'string' ? b.notes_md.slice(0, 20000) : '', flag, g.adminId]);
  await g.audit('save_release', null, { release: id, version, channel });
  return { release: r.rows[0] };
}

/** Move a release's feature to a rollout stage: its flag is switched on for that share of people, and the stage is recorded. 0 pauses. */
export async function stageRelease(g: GrowthCtx, id: string, b: Record<string, unknown>) {
  await g.need('releases.write');
  const pct = int(b.stage_pct, 'stage_pct', 0, 100);
  const [rel] = await rows(g.deps.ro, 'SELECT * FROM releases WHERE id = $1', [id]);
  if (!rel) throw new HttpError(404, 'No such release.');
  const c = await g.deps.admin.connect();
  try {
    await c.query('BEGIN');
    if (rel.flag_key) await c.query(`UPDATE feature_flags SET enabled = $2 > 0, rollout_pct = $2, updated_by = $3, updated_at = now() WHERE key = $1`, [rel.flag_key, pct, g.adminId]);
    await c.query(`INSERT INTO release_rollouts(release_id, stage_pct, note, set_by) VALUES ($1,$2,$3,$4)`, [id, pct, typeof b.note === 'string' ? b.note.slice(0, 300) : null, g.adminId]);
    await c.query(`UPDATE releases SET status = CASE WHEN $2 = 0 THEN 'paused' WHEN $2 = 100 THEN 'complete' ELSE 'rolling_out' END,
      published_at = coalesce(published_at, CASE WHEN $2 > 0 THEN now() END) WHERE id = $1`, [id, pct]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  await g.audit('stage_release', null, { release: id, stage_pct: pct, flag: rel.flag_key });
  return { id, stage_pct: pct };
}

/** Tell people about a release: an announcement linked to it (the inbox shows it as a release note). */
export async function announceRelease(g: GrowthCtx, id: string) {
  await g.need('releases.write');
  const [rel] = await rows(g.deps.ro, 'SELECT * FROM releases WHERE id = $1', [id]);
  if (!rel) throw new HttpError(404, 'No such release.');
  const aid = newId('ann');
  const notes = (rel.notes_md || rel.title).slice(0, 4000);
  await g.deps.admin.query(`INSERT INTO announcements(id, title, body, level, kind, release_id, created_by) VALUES ($1,$2,$3,'info','release',$4,$5)`,
    [aid, `${rel.title} (${rel.version})`.slice(0, 160), notes, id, g.adminId]);
  await g.audit('announce_release', null, { release: id, announcement: aid });
  return { announcement: aid };
}

// ── the funnel, guardrails and auto-pause ───────────────────────────────────────────────────────

export const GUARDRAILS = { minImpressions: 50, maxDismissRate: 0.35, maxOptOutRate: 0.05 };

export async function overview(deps: AdminDeps, days = 30) {
  const per = await rows(deps.ro, `
    SELECT k.id, k.name, k.status, k.tier, k.holdout_pct,
           count(*) FILTER (WHERE e.type = 'served')::int AS served, count(*) FILTER (WHERE e.type = 'impression')::int AS impressions, count(*) FILTER (WHERE e.type = 'view')::int AS views,
           count(*) FILTER (WHERE e.type = 'click')::int AS clicks, count(*) FILTER (WHERE e.type = 'dismiss')::int AS dismissals,
           count(*) FILTER (WHERE e.type = 'conversion')::int AS conversions, count(*) FILTER (WHERE e.type = 'holdout')::int AS held_out
      FROM campaigns k LEFT JOIN promo_events e ON e.campaign_id = k.id AND e.ts > now() - make_interval(days => $1)
     GROUP BY k.id ORDER BY max(e.ts) DESC NULLS LAST, k.created_at DESC LIMIT 100`, [days]);
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 10000 : null);
  const [prefs] = await rows(deps.ro, `SELECT count(*) FILTER (WHERE NOT in_app)::int AS in_app_off, count(*) FILTER (WHERE email_marketing)::int AS email_on,
    count(*) FILTER (WHERE unsubscribed_at > now() - make_interval(days => $1))::int AS unsubscribed_recently, (SELECT count(*)::int FROM users WHERE status = 'active') AS active
    FROM user_promo_prefs`, [days]);
  return {
    days, guardrails: GUARDRAILS, prefs,
    campaigns: per.map((c) => ({ ...c, reach_rate: rate(c.impressions, c.served), ctr: rate(c.clicks, c.impressions), dismiss_rate: rate(c.dismissals, c.impressions), conversion_rate: rate(c.conversions, c.impressions),
      breaching: c.impressions >= GUARDRAILS.minImpressions && (c.dismissals / c.impressions) > GUARDRAILS.maxDismissRate })),
  };
}

/** Pause any live promotion whose dismiss rate went past the guardrail. Run on a timer by main.ts; also callable from the console. */
export async function sweepGuardrails(deps: AdminDeps): Promise<string[]> {
  const bad = await rows(deps.ro, `
    SELECT k.id FROM campaigns k JOIN promo_events e ON e.campaign_id = k.id AND e.ts > now() - interval '7 days'
     WHERE k.status = 'live' AND k.tier = 'promo'
     GROUP BY k.id HAVING count(*) FILTER (WHERE e.type = 'impression') >= $1
        AND count(*) FILTER (WHERE e.type = 'dismiss')::float / nullif(count(*) FILTER (WHERE e.type = 'impression'), 0) > $2`,
    [GUARDRAILS.minImpressions, GUARDRAILS.maxDismissRate]);
  for (const { id } of bad) {
    await deps.admin.query(`UPDATE campaigns SET status = 'paused', paused_reason = 'guardrail: dismiss rate', updated_at = now() WHERE id = $1 AND status = 'live'`, [id]);
    await deps.admin.query('INSERT INTO admin_audit(admin_user_id, action, target_user_id, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6)', ['system', 'guardrail_pause', null, 'campaign', id, JSON.stringify({ campaign: id })]);
  }
  return bad.map((b) => b.id);
}

// ── routing (/admin/growth/<a>/<id>/<act>) ──────────────────────────────────────────────────────

export async function route(g: GrowthCtx, m: string, parts: string[], req: IncomingMessage, body: () => Promise<Record<string, unknown>>, q: URLSearchParams) {
  const [a, id, act] = parts;
  const read = () => g.need('growth.read');
  if (m === 'GET' && a === 'overview') { await read(); return overview(g.deps, Number(q.get('days') ?? 30) || 30); }
  if (m === 'GET' && a === 'campaigns' && !id) { await read(); return listCampaigns(g.deps); }
  if (m === 'POST' && a === 'campaigns' && !id) return saveCampaign(g, undefined, await body());
  if (m === 'PUT' && a === 'campaigns' && id && !act) return saveCampaign(g, id, await body());
  if (m === 'PUT' && a === 'campaigns' && id && act === 'targets') return setTargets(g, id, await body());
  if (m === 'POST' && a === 'campaigns' && id && act === 'status') return setStatus(g, id, await body());
  if (m === 'POST' && a === 'campaigns' && id && act === 'creatives') return saveCreative(g, id, await body());
  if (m === 'POST' && a === 'creatives' && id && act === 'media') return uploadMedia(g, id, req);
  if (m === 'POST' && a === 'creatives' && id && act === 'publish') return publishCreative(g, id);
  if (m === 'POST' && a === 'audience') { await read(); return audienceSize(g.deps, await body()); }
  if (m === 'POST' && a === 'preview') { await read(); return previewFor(g.deps, await body()); }
  if (m === 'GET' && a === 'releases') { await read(); return listReleases(g.deps); }
  if (m === 'POST' && a === 'releases' && !id) return saveRelease(g, await body());
  if (m === 'POST' && a === 'releases' && id && act === 'stage') return stageRelease(g, id, await body());
  if (m === 'POST' && a === 'releases' && id && act === 'announce') return announceRelease(g, id);
  if (m === 'GET' && a === 'templates') { await read(); return email.listTemplates(g.deps); }
  if (m === 'POST' && a === 'templates') { await g.need('growth.write'); const b = await body(); const r = await email.saveTemplate(g.deps, g.adminId, b); await g.audit('save_email_template', null, { template: r.template.id, name: r.template.name }); return r; }
  if (m === 'POST' && a === 'campaigns' && id && act === 'email') {
    await g.need('growth.publish');
    const b = await body();
    const r = await email.sendCampaignEmail(g.deps, g.deps.email ?? {}, g.adminId, id, b);
    await g.audit('send_campaign_email', null, { campaign: id, template: b.template_id, sent: r.sent, failed: r.failed, remaining: r.remaining });
    return r;
  }
  if (m === 'GET' && a === 'campaigns' && id && act === 'deliveries') { await read(); return email.deliveries(g.deps, id); }
  if (m === 'POST' && a === 'guardrails' && id === 'sweep') { await g.need('growth.publish'); const paused = await sweepGuardrails(g.deps); await g.audit('guardrail_sweep', null, { paused }); return { paused }; }
  throw new HttpError(404, 'Not found.');
}
