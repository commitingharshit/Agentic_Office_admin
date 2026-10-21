'use server';
// Growth actions: the same pattern as ../actions.ts (who is asking is checked again on the server, the admin API is called as
// them, and the page reloads with the outcome in its address). The admin API checks the permission and writes the audit row.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { adminApi, AdminApiError, adminUpload } from '../../../lib/admin-api';
import { validateCard } from '../../../lib/promo-card';
import { requireAdmin } from '../../../lib/session';

const field = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const opt = (f: FormData, k: string) => field(f, k) || undefined;
const num = (f: FormData, k: string) => (field(f, k) ? Number(field(f, k)) : undefined);
const csv = (f: FormData, k: string) => field(f, k) ? field(f, k).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
const done = (to: string, key: 'msg' | 'err', text: string): never => redirect(`${to}${to.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(text)}`);
const enc = encodeURIComponent;

async function act(back: string, ok: string | ((r: any) => string), fn: (acting: string) => Promise<any>): Promise<never> {
  const admin = await requireAdmin(back);
  let r: any;
  try { r = await fn(admin.id); } catch (e) { return done(back, 'err', e instanceof AdminApiError ? e.message : 'That did not work.'); }
  revalidatePath('/admin/growth', 'layout');
  return done(typeof r?.__back === 'string' ? r.__back : back, 'msg', typeof ok === 'function' ? ok(r) : ok);
}

const campaignBody = (f: FormData) => ({
  name: field(f, 'name'), tier: opt(f, 'tier'), priority: num(f, 'priority'), starts_at: opt(f, 'starts_at'), ends_at: opt(f, 'ends_at'),
  holdout_pct: num(f, 'holdout_pct'), flag_key: field(f, 'flag_key') || null, max_impressions: num(f, 'max_impressions'),
  per_seconds: num(f, 'per_hours') !== undefined ? Math.round(num(f, 'per_hours')! * 3600) : undefined,
  min_gap_seconds: num(f, 'gap_minutes') !== undefined ? Math.round(num(f, 'gap_minutes')! * 60) : undefined,
});

export async function createCampaign(f: FormData) {
  await act('/admin/growth/campaigns', 'Campaign created. Add a creative, publish it, then put the campaign live.', async (acting) => {
    const r = await adminApi('/admin/growth/campaigns', { acting, method: 'POST', body: campaignBody(f) });
    return { __back: `/admin/growth/campaigns/${enc(r.campaign.id)}` };
  });
}
export async function updateCampaign(f: FormData) {
  const id = field(f, 'id'), back = `/admin/growth/campaigns/${enc(id)}`;
  await act(back, 'Campaign saved.', (acting) => adminApi(`/admin/growth/campaigns/${enc(id)}`, { acting, method: 'PUT', body: campaignBody(f) }));
}
export async function saveTargets(f: FormData) {
  const id = field(f, 'id'), back = `/admin/growth/campaigns/${enc(id)}`;
  await act(back, 'Audience saved.', (acting) => adminApi(`/admin/growth/campaigns/${enc(id)}/targets`, {
    acting, method: 'PUT',
    body: { plan_ids: csv(f, 'plan_ids'), exclude_plan_ids: csv(f, 'exclude_plan_ids'), platforms: csv(f, 'platforms'), locales: csv(f, 'locales'),
      min_app_version: opt(f, 'min_app_version'), signup_after: opt(f, 'signup_after'), signup_before: opt(f, 'signup_before'), user_ids: csv(f, 'user_ids') },
  }));
}
export async function setCampaignStatus(f: FormData) {
  const id = field(f, 'id'), back = `/admin/growth/campaigns/${enc(id)}`, status = field(f, 'status');
  await act(back, `Campaign ${status}.`, (acting) => adminApi(`/admin/growth/campaigns/${enc(id)}/status`, { acting, method: 'POST', body: { status, reason: opt(f, 'reason') } }));
}

/** Save the creative for one placement. A card is checked here first (same validator as the server and the app), so the editor
 *  says what is wrong before anything is sent. */
export async function saveCreative(f: FormData) {
  const id = field(f, 'campaign_id'), back = `/admin/growth/campaigns/${enc(id)}`;
  const kind = field(f, 'kind');
  let card: unknown;
  if (kind === 'card') {
    try { card = JSON.parse(field(f, 'card')); } catch { return done(back, 'err', 'The card is not valid JSON.'); }
    const v = validateCard(card);
    if (!v.ok) return done(back, 'err', `The card does not validate: ${v.errors.slice(0, 3).join('; ')}`);
  }
  const action = field(f, 'cta_command') ? { command: field(f, 'cta_command'), ...(field(f, 'cta_arg') ? { arg: field(f, 'cta_arg') } : {}) } : undefined;
  await act(back, 'Creative saved as a draft. Publish it when it is ready.', (acting) => adminApi(`/admin/growth/campaigns/${enc(id)}/creatives`, {
    acting, method: 'POST', body: { placement: field(f, 'placement'), kind, headline: field(f, 'headline'), body: field(f, 'body'), cta_label: opt(f, 'cta_label'), cta_action: action, card },
  }));
}
export async function uploadCreativeMedia(f: FormData) {
  const id = field(f, 'campaign_id'), creative = field(f, 'creative_id'), back = `/admin/growth/campaigns/${enc(id)}`;
  const file = f.get('file');
  if (!(file instanceof File) || !file.size) return done(back, 'err', 'Choose a file to upload.');
  await act(back, 'Uploaded. The media worker is preparing it (a clip takes a few seconds); publish once it shows as processed.', async (acting) =>
    adminUpload(`/admin/growth/creatives/${enc(creative)}/media`, { acting, type: file.type || 'application/octet-stream', bytes: await file.arrayBuffer() }));
}
export async function publishCreative(f: FormData) {
  const id = field(f, 'campaign_id'), creative = field(f, 'creative_id'), back = `/admin/growth/campaigns/${enc(id)}`;
  await act(back, 'Creative published: it can be served once the campaign is live.', (acting) => adminApi(`/admin/growth/creatives/${enc(creative)}/publish`, { acting, method: 'POST', body: {} }));
}
export async function previewForPerson(f: FormData) {
  const id = field(f, 'campaign_id'), back = `/admin/growth/campaigns/${enc(id)}`;
  await act(back, (r) => r.decision.kind === 'show' ? `They would see campaign ${r.decision.campaign} (${r.plan}${r.ad_free ? ', ad-free' : ''}).`
    : r.decision.kind === 'holdout' ? `They are in the holdout for ${r.decision.campaignId}: shown nothing, counted for comparison.`
    : `Nothing would show. Why, per campaign: ${Object.entries(r.decision.reasons ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ') || 'no live campaign on this placement'}.`,
  (acting) => adminApi('/admin/growth/preview', { acting, method: 'POST', body: { user_id: field(f, 'user_id'), placement: field(f, 'placement') } }));
}
export async function sweepGuardrails() {
  await act('/admin/growth', (r) => r.paused.length ? `Paused ${r.paused.join(', ')}.` : 'Every live promotion is within its guardrails.',
    (acting) => adminApi('/admin/growth/guardrails/sweep', { acting, method: 'POST', body: {} }));
}

export async function saveRelease(f: FormData) {
  await act('/admin/growth/releases', 'Release saved. Move it through the stages when the build is out.', (acting) => adminApi('/admin/growth/releases', {
    acting, method: 'POST', body: { version: field(f, 'version'), channel: opt(f, 'channel'), title: field(f, 'title'), notes_md: field(f, 'notes_md'), flag_key: opt(f, 'flag_key') },
  }));
}
export async function stageRelease(f: FormData) {
  const id = field(f, 'id'), pct = Number(field(f, 'stage_pct'));
  await act('/admin/growth/releases', pct === 0 ? 'Rollout paused: the feature is off for everyone it covered.' : `Rolled out to ${pct}%.`,
    (acting) => adminApi(`/admin/growth/releases/${enc(id)}/stage`, { acting, method: 'POST', body: { stage_pct: pct, note: opt(f, 'note') } }));
}
export async function announceRelease(f: FormData) {
  const id = field(f, 'id');
  await act('/admin/growth/releases', 'Release note posted to everyone\'s inbox.', (acting) => adminApi(`/admin/growth/releases/${enc(id)}/announce`, { acting, method: 'POST', body: {} }));
}
