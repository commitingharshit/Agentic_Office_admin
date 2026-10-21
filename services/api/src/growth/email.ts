// Campaign email through Resend: templates, sends to people who agreed to marketing email, Resend's signed delivery webhooks,
// and a one-click unsubscribe that works without signing in.
//
// Rules this file keeps:
//   - marketing email goes only to active people with user_promo_prefs.email_marketing = true and no unsubscribe since;
//   - every template carries {{unsubscribe_url}} in both its HTML and its text, and every message carries List-Unsubscribe and
//     List-Unsubscribe-Post (RFC 8058) headers;
//   - nothing is sent unless the unsubscribe link can work for every recipient: a public base URL (AO_PUBLIC_URL) and a signing key
//     (AO_UNSUBSCRIBE_KEY) must be configured, or the send is refused;
//   - a send is resumable: each person is recorded once per campaign email, so running it again continues where it stopped;
//   - a complaint or a permanent bounce switches that person's marketing email off.
// Security, account and billing email never goes through here.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { AdminDeps } from '../api/admin.ts';
import { HttpError } from '../api/errors.ts';

const rows = async (p: pg.Pool, sql: string, args: unknown[] = []) => (await p.query(sql, args)).rows;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const BATCH = 500;

export interface EmailConfig { publicUrl?: string; unsubscribeKey?: Buffer; webhookSecret?: Buffer }
export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const pub = env.AO_PUBLIC_URL?.trim().replace(/\/+$/, '');
  const key = env.AO_UNSUBSCRIBE_KEY?.trim();
  const wh = env.RESEND_WEBHOOK_SECRET?.trim();
  return {
    publicUrl: pub && /^https:\/\//.test(pub) ? pub : undefined,
    unsubscribeKey: key && key.length >= 32 ? Buffer.from(key) : undefined,
    // Resend (Svix) secrets look like "whsec_<base64>"; the key is the decoded part.
    webhookSecret: wh ? Buffer.from(wh.startsWith('whsec_') ? wh.slice(6) : wh, 'base64') : undefined,
  };
}

// ── unsubscribe links ────────────────────────────────────────────────────────────────────────────

export const unsubscribeToken = (key: Buffer, userId: string) => createHmac('sha256', key).update(`unsubscribe:${userId}`).digest('base64url');
export function unsubscribeOk(key: Buffer, userId: string, token: string): boolean {
  if (!/^usr_[a-z0-9]{1,40}$/.test(userId)) return false;
  const a = Buffer.from(unsubscribeToken(key, userId)), b = Buffer.from(token ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const unsubscribeUrl = (cfg: Required<Pick<EmailConfig, 'publicUrl' | 'unsubscribeKey'>>, userId: string) =>
  `${cfg.publicUrl}/v1/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(cfg.unsubscribeKey, userId)}`;

/** The person's marketing email off, recorded with when. Used by the link, the one-click POST and complaints/bounces. */
export async function unsubscribe(c: pg.PoolClient | pg.Pool, userId: string) {
  await c.query(`INSERT INTO user_promo_prefs(user_id, email_marketing, unsubscribed_at) VALUES ($1, false, now())
    ON CONFLICT (user_id) DO UPDATE SET email_marketing = false, unsubscribed_at = coalesce(user_promo_prefs.unsubscribed_at, now()), updated_at = now()`, [userId]);
}

// ── templates ────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
/** {{name}} and {{unsubscribe_url}} are the only placeholders. In HTML the values are escaped. */
export function render(t: { subject: string; html: string; text: string }, v: { name: string; unsubscribe_url: string }) {
  const fill = (s: string, html: boolean) => s.replace(/\{\{\s*(name|unsubscribe_url)\s*\}\}/g, (_m, k: 'name' | 'unsubscribe_url') => (html ? esc(v[k]) : v[k]));
  return { subject: fill(t.subject, false).replace(/[\r\n]+/g, ' '), html: fill(t.html, true), text: fill(t.text, false) };
}

export async function listTemplates(deps: AdminDeps) {
  return { templates: await rows(deps.ro, 'SELECT id, name, subject, version, updated_by, updated_at, length(html) AS html_bytes FROM email_templates ORDER BY updated_at DESC') };
}
export async function saveTemplate(deps: AdminDeps, adminId: string, b: Record<string, unknown>) {
  const str = (k: string, min: number, max: number) => { const s = typeof b[k] === 'string' ? (b[k] as string).trim() : ''; if (s.length < min || s.length > max) throw new HttpError(400, `${k} must be ${min}-${max} characters.`); return s; };
  const name = str('name', 1, 120), subject = str('subject', 1, 200), html = str('html', 1, 200_000), text = str('text', 1, 20_000);
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(html) || !/\{\{\s*unsubscribe_url\s*\}\}/.test(text)) throw new HttpError(400, 'A marketing template must contain {{unsubscribe_url}} in both its HTML and its text.');
  if (/<script|javascript:|on\w+\s*=/i.test(html)) throw new HttpError(400, 'Email HTML must not contain scripts or event handlers.');
  const id = typeof b.id === 'string' && ID.test(b.id) ? b.id : `tpl_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const r = await deps.admin.query(`INSERT INTO email_templates(id, name, subject, html, text, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET name = $2, subject = $3, html = $4, text = $5, version = email_templates.version + 1, updated_by = $6, updated_at = now()
    RETURNING id, name, subject, version`, [id, name, subject, html, text, adminId]);
  return { template: r.rows[0] };
}

// ── sending ──────────────────────────────────────────────────────────────────────────────────────

/** Send (or continue sending) a campaign's email. Each call handles up to 500 people; `remaining` says whether to call again. */
export async function sendCampaignEmail(deps: AdminDeps, cfg: EmailConfig, adminId: string, campaignId: string, b: Record<string, unknown>) {
  if (!deps.mailer) throw new HttpError(409, 'Email is not configured on this server (RESEND_API_KEY, AO_MAIL_FROM), so nothing was sent.');
  if (!cfg.publicUrl || !cfg.unsubscribeKey) throw new HttpError(409, 'Marketing email needs a working unsubscribe link: set AO_PUBLIC_URL (a public https address for this API) and AO_UNSUBSCRIBE_KEY. Nothing was sent.');
  const templateId = typeof b.template_id === 'string' && ID.test(b.template_id) ? b.template_id : '';
  const [t] = await rows(deps.ro, 'SELECT * FROM email_templates WHERE id = $1', [templateId]);
  if (!t) throw new HttpError(404, 'No such template.');
  const [k] = await rows(deps.ro, `SELECT k.id, k.status, t.plan_ids, t.exclude_plan_ids, t.user_ids FROM campaigns k LEFT JOIN campaign_targets t ON t.campaign_id = k.id WHERE k.id = $1`, [campaignId]);
  if (!k) throw new HttpError(404, 'No such campaign.');
  if (k.status !== 'live' && k.status !== 'scheduled') throw new HttpError(409, 'Put the campaign live (or scheduled) before emailing it.');
  // One send per campaign and template: reuse it, so a second call continues (or, once finished, finds nobody left).
  let [send] = await rows(deps.ro, `SELECT id FROM campaign_emails WHERE campaign_id = $1 AND template_id = $2 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`, [campaignId, templateId]);
  if (!send) {
    const id = `mail_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    send = (await deps.admin.query(`INSERT INTO campaign_emails(id, campaign_id, template_id, status, created_by) VALUES ($1,$2,$3,'sending',$4) RETURNING id`, [id, campaignId, templateId, adminId])).rows[0];
  }
  const people = await rows(deps.ro, `
    SELECT u.id, u.email, coalesce(u.display_name, '') AS name FROM users u
      JOIN user_promo_prefs p ON p.user_id = u.id AND p.email_marketing AND p.unsubscribed_at IS NULL
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
     WHERE u.status = 'active' AND u.email IS NOT NULL
       AND ($2::text[] IS NULL OR coalesce(s.plan_id, 'free') = ANY($2)) AND ($3::text[] IS NULL OR NOT coalesce(s.plan_id, 'free') = ANY($3))
       AND ($4::text[] IS NULL OR u.id = ANY($4))
       -- a person gets a campaign's email at most once, whichever of its sends or templates
       AND NOT EXISTS (SELECT 1 FROM email_deliveries d JOIN campaign_emails e ON e.id = d.campaign_email_id WHERE e.campaign_id = $5 AND d.user_id = u.id AND d.status <> 'failed')
       AND NOT EXISTS (SELECT 1 FROM email_deliveries d WHERE d.campaign_email_id = $1 AND d.user_id = u.id)
     ORDER BY u.created_at LIMIT ${BATCH}`, [send.id, k.plan_ids, k.exclude_plan_ids, k.user_ids, campaignId]);
  let sent = 0, failed = 0;
  for (const p of people) {
    const link = unsubscribeUrl({ publicUrl: cfg.publicUrl, unsubscribeKey: cfg.unsubscribeKey }, p.id);
    const m = render(t, { name: p.name, unsubscribe_url: link });
    try {
      const r = await deps.mailer({ to: p.email, subject: m.subject, text: m.text, html: m.html,
        headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: [{ name: 'campaign', value: campaignId.replace(/[^A-Za-z0-9_-]/g, '_') }] });
      await deps.admin.query(`INSERT INTO email_deliveries(campaign_email_id, user_id, status, provider_id, created_by) VALUES ($1,$2,'sent',$3,$4) ON CONFLICT DO NOTHING`, [send.id, p.id, r.id, adminId]);
      sent++;
    } catch (e) {
      if ((e as { code?: string }).code === '23503') continue;
      await deps.admin.query(`INSERT INTO email_deliveries(campaign_email_id, user_id, status, error, created_by) VALUES ($1,$2,'failed',$3,$4) ON CONFLICT DO NOTHING`,
        [send.id, p.id, String((e as Error).message).slice(0, 200), adminId]).catch(() => undefined);
      failed++;
    }
  }
  const remaining = people.length === BATCH;
  if (!remaining) await deps.admin.query(`UPDATE campaign_emails SET status = 'sent', sent_at = now() WHERE id = $1`, [send.id]);
  return { send: send.id, sent, failed, remaining };
}

export async function deliveries(deps: AdminDeps, campaignId: string) {
  return { sends: await rows(deps.ro, `
    SELECT e.id, e.template_id, e.status, e.created_at, e.sent_at,
           (SELECT json_object_agg(status, n) FROM (SELECT d.status, count(*)::int AS n FROM email_deliveries d WHERE d.campaign_email_id = e.id GROUP BY d.status) x) AS by_status
      FROM campaign_emails e WHERE e.campaign_id = $1 ORDER BY e.created_at DESC`, [campaignId]) };
}

// ── Resend's webhook ─────────────────────────────────────────────────────────────────────────────

/** Svix signature check: HMAC-SHA256 of "<id>.<timestamp>.<body>" with the secret; any one of the "v1,<sig>" entries may match.
 *  A timestamp more than 5 minutes from now is refused, so an old captured request cannot be replayed later. */
export function verifySvix(secret: Buffer, headers: Record<string, string | string[] | undefined>, body: string, now = Date.now()): string {
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v ?? ''; };
  const id = h('svix-id'), ts = h('svix-timestamp'), sigs = h('svix-signature');
  if (!id || !/^\d{9,11}$/.test(ts) || !sigs) throw new HttpError(400, 'Missing webhook signature headers.');
  if (Math.abs(now / 1000 - Number(ts)) > 300) throw new HttpError(400, 'The webhook timestamp is too old or in the future.');
  const want = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest();
  const ok = sigs.split(' ').some((s) => {
    const [v, b64] = s.split(',');
    if (v !== 'v1' || !b64) return false;
    const got = Buffer.from(b64, 'base64');
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!ok) throw new HttpError(401, 'The webhook signature does not match.');
  return id;
}

const STATUS: Record<string, string> = {
  'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'delivery_delayed', 'email.bounced': 'bounced',
  'email.complained': 'complained', 'email.opened': 'opened', 'email.clicked': 'clicked',
};
// A later, weaker event never overwrites a stronger one (an "opened" after "clicked" keeps "clicked"); bounces and complaints stick.
const RANK: Record<string, number> = { failed: 0, sent: 1, delivery_delayed: 2, delivered: 3, opened: 4, clicked: 5, bounced: 9, complained: 10 };

/** Apply one Resend event. Returns what happened, for the response body and the tests. */
export async function handleResendWebhook(admin: pg.Pool, cfg: EmailConfig, headers: Record<string, string | string[] | undefined>, raw: string) {
  if (!cfg.webhookSecret) throw new HttpError(404, 'Not found.');
  const eventId = verifySvix(cfg.webhookSecret, headers, raw);
  let ev: { type?: string; data?: { email_id?: string; bounce?: { type?: string } } };
  try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'The webhook body is not JSON.'); }
  const fresh = await admin.query(`INSERT INTO webhook_events(provider, event_id, type) VALUES ('resend', $1, $2) ON CONFLICT DO NOTHING`, [eventId, String(ev.type ?? '?').slice(0, 60)]);
  if (!fresh.rowCount) return { duplicate: true };
  const status = STATUS[ev.type ?? ''];
  const providerId = ev.data?.email_id;
  if (!status || typeof providerId !== 'string') return { ignored: ev.type ?? 'unknown' };
  const [d] = (await admin.query(`SELECT id, user_id, status FROM email_deliveries WHERE provider_id = $1`, [providerId])).rows;
  if (!d) return { unknown_email: true };
  if ((RANK[status] ?? 0) > (RANK[d.status] ?? 0)) await admin.query(`UPDATE email_deliveries SET status = $2, last_event_at = now() WHERE id = $1`, [d.id, status]);
  else await admin.query(`UPDATE email_deliveries SET last_event_at = now() WHERE id = $1`, [d.id]);
  const permanent = status === 'bounced' && String(ev.data?.bounce?.type ?? 'Permanent').toLowerCase() !== 'transient';
  if (status === 'complained' || permanent) await unsubscribe(admin, d.user_id);
  return { status, unsubscribed: status === 'complained' || permanent };
}

/** The unsubscribe page (GET) asks to confirm; the form, and mail clients' one-click POST, unsubscribe. No sign-in needed. */
export function unsubscribePage(done: boolean, action?: string): string {
  const body = done
    ? '<h1>You are unsubscribed</h1><p>Agentic Office will not send you marketing email any more. Messages about your account, security and billing still arrive.</p>'
    : `<h1>Unsubscribe from Agentic Office marketing email?</h1><form method="post" action="${esc(action ?? '')}"><button type="submit">Unsubscribe</button></form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<style>body{font:16px system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#222}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer}</style>
</head><body>${body}</body></html>`;
}
