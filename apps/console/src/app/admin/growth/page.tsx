import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { sweepGuardrails } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Growth' };

const pct = (v: number | null) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(1)}%`);

export default async function Growth({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/growth/overview?days=30', person.id);
  const canPublish = permissions.includes('growth.publish');
  return (
    <>
      <PageHeader title="Growth" subtitle="What people saw in the app, what they did with it, and whether it is helping. The last 30 days, from the events the app reports." />
      <Flash q={q} />
      <Notice icon="info">The admin decides what is eligible; the app decides how it is drawn; a person&apos;s ad-free plan or their own &quot;no promotions&quot; switch decides whether anything promotional appears. Release notes and task notices still reach everyone.</Notice>
      {res.ok ? (<>
        <Section title="Choices people made" actions={canPublish ? <form action={sweepGuardrails}><button className="btn">Check guardrails now</button></form> : undefined}>
          <div className="table-wrap"><table className="dt"><tbody>
            <tr><td>Active people</td><td className="num">{num(res.data.prefs.active)}</td></tr>
            <tr><td>Switched in-app promotions off</td><td className="num">{num(res.data.prefs.in_app_off)}</td></tr>
            <tr><td>Agreed to marketing email</td><td className="num">{num(res.data.prefs.email_on)}</td></tr>
            <tr><td>Unsubscribed in this period</td><td className="num">{num(res.data.prefs.unsubscribed_recently)}</td></tr>
          </tbody></table></div>
          <p className="muted" style={{ fontSize: 12 }}>Guardrail: a live promotion with at least {res.data.guardrails.minImpressions} impressions and more than {pct(res.data.guardrails.maxDismissRate)} of them dismissed is paused automatically (checked every 10 minutes).</p>
        </Section>
        <Section title="Campaigns" count={res.data.campaigns.length}>
          <div className="table-wrap"><table className="dt"><thead><tr><th>Campaign</th><th>Status</th><th>Tier</th><th className="right" title="Sent to a device by the server (once a day per person)">Served</th><th className="right" title="Shown, as the app reported it">Impressions</th><th className="right" title="Impressions as a share of served: low means the app is not drawing what it is sent">Reached</th><th className="right">Clicks</th><th className="right">CTR</th><th className="right">Dismissed</th><th className="right">Converted</th><th className="right">Held out</th></tr></thead>
            <tbody>{(res.data.campaigns as any[]).map((c) => (
              <tr key={c.id}><td><a href={`/admin/growth/campaigns/${encodeURIComponent(c.id)}`}>{c.name}</a></td>
                <td><StatusBadge status={c.status === 'live' ? 'active' : c.status === 'paused' ? 'disabled' : 'pending'}>{c.status}</StatusBadge>{c.breaching ? <span title="over the dismiss guardrail"> ⚠</span> : null}</td>
                <td>{c.tier}</td><td className="num">{num(c.served)}</td><td className="num">{num(c.impressions)}</td><td className="num">{pct(c.reach_rate)}</td><td className="num">{num(c.clicks)}</td><td className="num">{pct(c.ctr)}</td>
                <td className="num">{pct(c.dismiss_rate)}</td><td className="num">{pct(c.conversion_rate)}</td><td className="num">{num(c.held_out)}</td></tr>))}
              {!res.data.campaigns.length && <tr><td colSpan={9} className="dt-empty">No campaigns yet. <a href="/admin/growth/campaigns">Create one</a>.</td></tr>}</tbody></table></div>
          <p className="muted" style={{ fontSize: 12 }}>A campaign with a holdout shows nothing to a fixed share of eligible people; compare what they go on to do with those who saw it before deciding it works.</p>
        </Section>
      </>) : <ErrorState message={res.error} />}
    </>
  );
}
