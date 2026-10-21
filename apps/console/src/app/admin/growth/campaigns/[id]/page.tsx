import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, bytes } from '../../../../../components/admin/bits';
import { PromoPreview } from '../../../../../components/admin/PromoPreview';
import { load } from '../../../../../lib/admin-api';
import { adminContext } from '../../../../../lib/session';
import { previewForPerson, publishCreative, saveCreative, saveTargets, setCampaignStatus, updateCampaign, uploadCreativeMedia } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campaign' };

const SAMPLE_CARD = JSON.stringify({
  v: 1, layout: 'stack', blocks: [{ type: 'badge', text: 'New' }, { type: 'heading', text: 'Build an LBO model faster' }, { type: 'text', text: 'A verified finance toolkit for sources and uses, debt schedules and returns.' }],
  actions: [{ label: 'Explore toolkit', action: { command: 'open_marketplace_item', arg: 'lbo-toolkit' } }, { label: 'Not now', action: { command: 'dismiss' } }],
}, null, 2);
const COMMANDS = ['', 'open_url', 'open_marketplace_item', 'open_settings', 'insert_prompt', 'open_release_notes', 'open_plans'];
const local = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 16) : '');
const join = (v: string[] | null | undefined) => (v ?? []).join(', ');

export default async function Campaign({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/growth/campaigns', person.id);
  if (!res.ok) return <ErrorState message={res.error} />;
  const c = (res.data.campaigns as any[]).find((x) => x.id === id);
  if (!c) return <ErrorState message="No such campaign." />;
  const placements = res.data.placements as any[];
  const canWrite = permissions.includes('growth.write'), canPublish = permissions.includes('growth.publish');
  const byPlacement = new Map((c.creatives ?? []).map((cr: any) => [cr.placement, cr]));
  const t = c.target ?? {};
  return (
    <>
      <PageHeader title={c.name} subtitle={<><StatusBadge status={c.status === 'live' ? 'active' : c.status === 'paused' ? 'disabled' : 'pending'}>{c.status}</StatusBadge> {c.tier} · priority {c.priority} · holdout {c.holdout_pct}% · at most {c.max_impressions} shows per {Math.round(c.per_seconds / 3600)} h, {Math.round(c.min_gap_seconds / 60)} min apart</>}
        actions={canPublish ? <div style={{ display: 'flex', gap: 6 }}>{(['live', 'paused', 'ended'] as const).filter((s) => s !== c.status).map((s) => (
          <form key={s} action={setCampaignStatus}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="status" value={s} /><button className={s === 'live' ? 'btn primary' : 'btn'}>{s === 'live' ? 'Go live' : s === 'paused' ? 'Pause' : 'End'}</button></form>))}</div> : undefined} />
      <Flash q={q} />
      {c.paused_reason && <Notice tone="warn" icon="alert">Paused: {c.paused_reason}</Notice>}

      {placements.map((p) => {
        const cr: any = byPlacement.get(p.id);
        const kinds: string[] = p.allowed_kinds;
        return (
          <Section key={p.id} title={`Creative: ${p.id.replace('_', ' ')}`} actions={cr ? <StatusBadge status={cr.status === 'ready' ? 'active' : cr.status === 'rejected' ? 'disabled' : 'pending'}>{cr.status}</StatusBadge> : undefined}>
            <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{p.description}. Takes {kinds.join(', ')}{p.allow_video ? '' : ' (no video)'}; media up to {bytes(p.max_media_bytes)}; contract v{p.contract_version}.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(300px, 420px)', gap: 20, alignItems: 'start' }}>
              <div>
                {canWrite ? (
                  <form action={saveCreative} style={{ display: 'grid', gap: 8 }}>
                    <input type="hidden" name="campaign_id" value={c.id} /><input type="hidden" name="placement" value={p.id} />
                    <label className="field"><span>Kind</span><select name="kind" defaultValue={cr?.kind ?? kinds[kinds.length - 1]}>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
                    <label className="field"><span>Headline (also the text shown if media cannot load)</span><input name="headline" maxLength={120} defaultValue={cr?.headline ?? ''} /></label>
                    <label className="field"><span>Body</span><input name="body" maxLength={400} defaultValue={cr?.body ?? ''} /></label>
                    <div className="form-row">
                      <label className="field"><span>Button label</span><input name="cta_label" maxLength={40} defaultValue={cr?.cta_label ?? ''} /></label>
                      <label className="field"><span>Button action</span><select name="cta_command" defaultValue={cr?.cta_action?.command ?? ''}>{COMMANDS.map((k) => <option key={k} value={k}>{k || 'none'}</option>)}</select></label>
                      <label className="field" style={{ flex: 1 }}><span>Action argument</span><input name="cta_arg" defaultValue={cr?.cta_action?.arg ?? ''} placeholder="https://… / item id / setting" /></label>
                    </div>
                    {kinds.includes('card') && <label className="field"><span>Card (promo-card v1 JSON; used when kind is card)</span><textarea name="card" rows={10} className="mono" defaultValue={cr?.card ? JSON.stringify(cr.card, null, 2) : SAMPLE_CARD} /></label>}
                    <button className="btn primary" style={{ justifySelf: 'start' }}>Save draft</button>
                  </form>) : null}
                {cr && cr.kind !== 'card' && canWrite && (
                  <form action={uploadCreativeMedia} style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="hidden" name="campaign_id" value={c.id} /><input type="hidden" name="creative_id" value={cr.id} />
                    <input type="file" name="file" accept={cr.kind === 'clip' ? 'video/mp4,video/webm,video/quicktime' : 'image/png,image/jpeg,image/webp'} required />
                    <button className="btn">Upload {cr.kind === 'clip' ? 'clip' : 'image'}</button>
                  </form>)}
                {cr && <p className="muted" style={{ fontSize: 12 }}>Media: {(cr.media ?? []).filter((m: any) => m.role !== 'source').map((m: any) => `${m.role}${m.width ? ` ${m.width}w` : ''} (${bytes(m.bytes)})`).join(', ') || 'none yet'}{cr.job ? ` · worker: ${cr.job.status}${cr.job.error ? ` (${cr.job.error})` : ''}` : ''}{cr.error ? ` · ${cr.error}` : ''}</p>}
                {cr && canPublish && cr.status !== 'ready' && (
                  <form action={publishCreative}><input type="hidden" name="campaign_id" value={c.id} /><input type="hidden" name="creative_id" value={cr.id} /><button className="btn primary">Publish creative</button></form>)}
              </div>
              <PromoPreview placement={p.id} creative={cr ? { kind: cr.kind, headline: cr.headline, body: cr.body, cta_label: cr.cta_label, card: cr.card, disclosure: c.tier === 'promo' ? 'Featured' : c.tier === 'release' ? 'New release' : null } : { kind: 'card', card: JSON.parse(SAMPLE_CARD), disclosure: 'Featured' }} />
            </div>
          </Section>);
      })}

      <Section title="Audience">
        {canWrite ? (
          <form action={saveTargets} className="form-row">
            <input type="hidden" name="id" value={c.id} />
            <label className="field"><span>Only plans</span><input name="plan_ids" defaultValue={join(t.plan_ids)} placeholder="every plan" /></label>
            <label className="field"><span>Not plans</span><input name="exclude_plan_ids" defaultValue={join(t.exclude_plan_ids)} /></label>
            <label className="field"><span>Platforms</span><input name="platforms" defaultValue={join(t.platforms)} placeholder="darwin, win32, linux" /></label>
            <label className="field"><span>Locales</span><input name="locales" defaultValue={join(t.locales)} placeholder="en, de" /></label>
            <label className="field"><span>App at least</span><input name="min_app_version" defaultValue={t.min_app_version ?? ''} placeholder="1.5.0" style={{ width: 90 }} /></label>
            <label className="field"><span>Signed up after</span><input name="signup_after" type="datetime-local" defaultValue={local(t.signup_after)} /></label>
            <label className="field"><span>Signed up before</span><input name="signup_before" type="datetime-local" defaultValue={local(t.signup_before)} /></label>
            <label className="field" style={{ flex: 1 }}><span>Only these people (user ids)</span><input name="user_ids" defaultValue={join(t.user_ids)} /></label>
            <button className="btn primary">Save audience</button>
          </form>) : <pre className="mono">{JSON.stringify(t, null, 2)}</pre>}
        <p className="muted" style={{ fontSize: 12 }}>Promotions never reach people on an ad-free plan or who switched promotions off, whatever the audience says. Targeting uses plan, platform, locale, app version and sign-up date only: never anything from people&apos;s documents or prompts.</p>
      </Section>

      <Section title="Would this person see it?">
        <form action={previewForPerson} className="form-row">
          <input type="hidden" name="campaign_id" value={c.id} />
          <label className="field" style={{ flex: 1 }}><span>User id</span><input name="user_id" required placeholder="usr_…" /></label>
          <label className="field"><span>Placement</span><select name="placement">{placements.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select></label>
          <button className="btn">Explain</button>
        </form>
      </Section>

      {canWrite && (
        <Section title="Settings">
          <form action={updateCampaign} className="form-row">
            <input type="hidden" name="id" value={c.id} />
            <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Name</span><input name="name" defaultValue={c.name} required /></label>
            <label className="field"><span>Kind</span><select name="tier" defaultValue={c.tier}><option value="promo">Promotion</option><option value="release">Release note</option><option value="task">Task notice</option></select></label>
            <label className="field"><span>Priority</span><input name="priority" type="number" defaultValue={c.priority} style={{ width: 80 }} /></label>
            <label className="field"><span>Ends</span><input name="ends_at" type="datetime-local" defaultValue={local(c.ends_at)} /></label>
            <label className="field"><span>Holdout %</span><input name="holdout_pct" type="number" min="0" max="50" defaultValue={c.holdout_pct} style={{ width: 80 }} /></label>
            <label className="field"><span>Max shows</span><input name="max_impressions" type="number" defaultValue={c.max_impressions} style={{ width: 80 }} /></label>
            <label className="field"><span>per (hours)</span><input name="per_hours" type="number" defaultValue={Math.round(c.per_seconds / 3600)} style={{ width: 80 }} /></label>
            <label className="field"><span>Gap (minutes)</span><input name="gap_minutes" type="number" defaultValue={Math.round(c.min_gap_seconds / 60)} style={{ width: 90 }} /></label>
            <label className="field"><span>Behind flag</span><input name="flag_key" defaultValue={c.flag_key ?? ''} placeholder="none" /></label>
            <button className="btn">Save</button>
          </form>
        </Section>)}
    </>
  );
}
