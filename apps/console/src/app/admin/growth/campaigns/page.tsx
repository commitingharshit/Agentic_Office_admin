import { ErrorState, Flash, PageHeader, Section, StatusBadge, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { createCampaign } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campaigns' };

export default async function Campaigns({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/growth/campaigns', person.id);
  const canWrite = permissions.includes('growth.write');
  return (
    <>
      <PageHeader title="Campaigns" subtitle="A campaign is one message with a creative for each place it can appear: above the assistant's composer, in the inbox, or on the bottom strip." />
      <Flash q={q} />
      {canWrite && (
        <Section title="New campaign">
          <form action={createCampaign} className="form-row">
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span>Name</span><input name="name" required maxLength={160} placeholder="Financial Modeling Toolkit launch" /></label>
            <label className="field"><span>Kind</span><select name="tier" defaultValue="promo"><option value="promo">Promotion</option><option value="release">Release note</option><option value="task">Task notice</option></select></label>
            <label className="field"><span>Priority</span><input name="priority" type="number" min="-100" max="100" defaultValue="0" style={{ width: 80 }} /></label>
            <label className="field"><span>Starts</span><input name="starts_at" type="datetime-local" /></label>
            <label className="field"><span>Ends</span><input name="ends_at" type="datetime-local" /></label>
            <label className="field"><span>Holdout %</span><input name="holdout_pct" type="number" min="0" max="50" defaultValue="0" style={{ width: 80 }} /></label>
            <label className="field"><span>Max shows</span><input name="max_impressions" type="number" min="1" max="100" defaultValue="2" style={{ width: 80 }} /></label>
            <label className="field"><span>per (hours)</span><input name="per_hours" type="number" min="1" max="8760" defaultValue="24" style={{ width: 80 }} /></label>
            <label className="field"><span>Gap (minutes)</span><input name="gap_minutes" type="number" min="0" max="525600" defaultValue="60" style={{ width: 90 }} /></label>
            <button className="btn primary">Create</button>
          </form>
        </Section>)}
      <Section title="All campaigns" count={res.ok ? res.data.campaigns.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Status</th><th>Kind</th><th>Creatives</th><th>Window</th><th>Changed</th></tr></thead>
            <tbody>{(res.data.campaigns as any[]).map((c) => (
              <tr key={c.id}><td><a href={`/admin/growth/campaigns/${encodeURIComponent(c.id)}`}>{c.name}</a></td>
                <td><StatusBadge status={c.status === 'live' ? 'active' : c.status === 'paused' ? 'disabled' : 'pending'}>{c.status}</StatusBadge>{c.paused_reason ? <span className="muted"> ({c.paused_reason})</span> : null}</td>
                <td>{c.tier}</td><td>{(c.creatives ?? []).map((cr: any) => `${cr.placement} (${cr.status})`).join(', ') || '-'}</td>
                <td>{new Date(c.starts_at).toLocaleDateString('en-GB')} - {c.ends_at ? new Date(c.ends_at).toLocaleDateString('en-GB') : 'open'}</td><td>{ago(c.updated_at)}</td></tr>))}
              {!res.data.campaigns.length && <tr><td colSpan={6} className="dt-empty">No campaigns yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
    </>
  );
}
