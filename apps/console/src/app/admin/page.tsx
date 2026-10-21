import Link from 'next/link';
import { AreaChart, BarChart } from '../../components/admin/Charts';
import { ActivityFeed } from '../../components/admin/Feed';
import { MetricCard } from '../../components/admin/MetricCard';
import { EmptyState, ErrorState, Flash, PageHeader, StatusBadge, ago, bytes, num } from '../../components/admin/bits';
import { walHealthy, walText } from '../../components/admin/wal';
import { load } from '../../lib/admin-api';
import { adminContext } from '../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pctChange = (now: number, before: number) => (before > 0 ? ((now - before) / before) * 100 : null);

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const days = [7, 14, 30, 90].includes(Number(q.days)) ? Number(q.days) : 14;
  const [ov, series, feed, health] = await Promise.all([
    load<any>('/admin/overview', person.id),
    load<any>(`/admin/overview/series?days=${days}`, person.id),
    load<any>('/admin/activity?limit=12', person.id),
    permissions.includes('overview.read') ? load<any>('/admin/health', person.id) : Promise.resolve({ ok: false as const, error: 'no access' }),
  ]);
  const s = series.ok ? series.data.series as any[] : [];
  const labels = s.map((r) => day(r.day));
  const t = ov.ok ? ov.data.totals : null;
  const half = Math.floor(s.length / 2);
  const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const trend = (k: string) => s.map((r) => Number(r[k] ?? 0));
  const h = health.ok ? health.data : null;
  const conns = h ? (h.connections as any[]).reduce((a, c) => a + c.n, 0) : null;

  return (
    <>
      <PageHeader title="Overview" subtitle="How Agentic Office is doing, from what the server actually records."
        actions={<form method="get" className="form-row"><select name="days" defaultValue={String(days)} aria-label="Date range">{[7, 14, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}</select><button className="btn sm">Apply</button></form>} />
      <Flash q={q} />
      {!ov.ok && <ErrorState message={ov.error} />}
      {t && (
        <div className="grid kpis">
          <MetricCard icon="users" label="Registered users" value={num(t.users)} hint={`${num(t.disabled)} disabled`} />
          <MetricCard icon="user" label="New this week" value={num(t.signups_7d)} trend={trend('signups')} hint={`${num(t.signups_30d)} in 30 days`} delta={s.length >= 4 && pctChange(sum(s.slice(half), 'signups'), sum(s.slice(0, half), 'signups')) !== null ? { pct: pctChange(sum(s.slice(half), 'signups'), sum(s.slice(0, half), 'signups'))!, of: 'vs earlier half' } : undefined} />
          <MetricCard icon="sessions" label="Active this week" value={num(t.wau)} hint={`${num(t.dau)} today · by last activity`} />
          <MetricCard icon="device" label="Devices" value={num(t.devices)} hint={`${num(t.active_sessions)} sessions in the last hour`} />
          <MetricCard icon="runs" label={`Synced events (${days} d)`} value={num(series.ok ? series.data.totals.sync_events : 0)} trend={trend('sync_events')} hint="encrypted on the devices" />
          <MetricCard icon="compute" label={`Managed requests (${days} d)`} value={num(series.ok ? series.data.totals.model_requests : 0)} trend={trend('model_requests')} hint={`${num(series.ok ? series.data.totals.tokens : 0)} tokens`} />
          <MetricCard icon="billing" label={`Credits spent (${days} d)`} value={num(series.ok ? series.data.totals.credits_spent : 0)} trend={trend('credits_spent')} hint={`${num(series.ok ? series.data.totals.credits_granted : 0)} granted`} />
          <MetricCard icon="security" label="Admin actions" value={num(series.ok ? series.data.totals.admin_actions : 0)} trend={trend('admin_actions')} hint="changes, not page views" />
        </div>)}

      <div className="grid wide section">
        <div className="card">
          <div className="card-head"><h3>User growth and activity</h3><span className="sub">last {days} days</span></div>
          {series.ok ? (
            <div className="card-body">
              <div className="muted" style={{ marginBottom: 6 }}>Sign-ups per day</div>
              <AreaChart data={trend('signups')} labels={labels} />
              <div className="muted" style={{ margin: '16px 0 6px' }}>Active people per day <span className="faint">(synced or used a model)</span></div>
              <BarChart data={trend('active_users')} labels={labels} />
            </div>) : <div className="card-body"><ErrorState message={series.error} /></div>}
        </div>
        <div className="card">
          <div className="card-head"><h3>Platform health</h3><Link href="/admin/infrastructure" className="sub">Details</Link></div>
          {h ? (
            <div className="card-body" style={{ display: 'grid', gap: 12 }}>
              <HealthRow label="Database" value={`${bytes(Number(h.db.bytes))} · ${num(conns)} / ${num(h.db.max_connections)} connections`} ok />
              <HealthRow label="Backups" value={h.backup.configured ? (h.backup.error ? `error: ${h.backup.error}` : h.backup.age_hours != null ? `latest ${h.backup.age_hours} h ago` : 'no backup yet') : 'not configured'} ok={!!h.backup.configured && !h.backup.error && (h.backup.age_hours ?? 99) < 36} warn={!h.backup.configured} />
              <HealthRow label="Restore drill" value={h.backup.drill ? (h.backup.drill.ok ? 'last drill passed' : 'last drill FAILED') : 'none recorded'} ok={!!h.backup.drill?.ok} warn={!h.backup.drill} />
              <HealthRow label="WAL archiving" value={walText(h.wal)} ok={walHealthy(h.wal)} warn={h.wal.mode !== 'on'} />
              <HealthRow label="Sync" value={`${num(h.sync.events_24h)} events in 24 h${h.sync.p95_lag_s != null ? ` · p95 lag ${Math.round(h.sync.p95_lag_s)} s` : ''}`} ok />
              <HealthRow label="Devices reporting" value={h.devices.reporting ? `${h.devices.reporting} in the last day` : 'none have reported'} warn={!h.devices.reporting} ok={!!h.devices.reporting} />
            </div>) : <div className="card-body"><ErrorState message={health.ok ? '' : health.error} /></div>}
        </div>
      </div>

      <div className="grid wide section">
        <div className="card">
          <div className="card-head"><h3>Compute and credits</h3><Link href="/admin/compute" className="sub">Open</Link></div>
          {series.ok ? (
            <div className="card-body">
              {series.data.totals.model_requests + series.data.totals.credits_granted + series.data.totals.credits_spent === 0
                ? <EmptyState icon="compute" title="No managed compute used yet">Requests made through Agentic Office's own models, and credit grants and spend, appear here. Bring-your-own-key and local-model use never reaches this server.</EmptyState>
                : <><div className="muted" style={{ marginBottom: 6 }}>Credits granted and spent per day</div><BarChart data={trend('credits_granted')} alt={trend('credits_spent')} labels={labels} /><div className="legend" style={{ padding: '10px 0 0' }}><span><i />Granted</span><span><i className="alt" />Spent</span></div></>}
            </div>) : <div className="card-body"><ErrorState message={series.error} /></div>}
        </div>
        <div className="card">
          <div className="card-head"><h3>Recent activity</h3><Link href="/admin/audit" className="sub">Audit log</Link></div>
          {feed.ok ? (feed.data.events.length ? <ActivityFeed events={feed.data.events} /> : <EmptyState title="Nothing yet" />) : <div className="card-body"><ErrorState message={feed.error} /></div>}
        </div>
      </div>

      <div className="section" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted">Quick actions</span>
        <Link className="btn sm" href="/admin/users">Find a user</Link><Link className="btn sm" href="/admin/coupons">Create a coupon</Link><Link className="btn sm" href="/admin/billing">Manage plans</Link>
        <span className="faint" style={{ marginLeft: 'auto' }}>{ov.ok ? `Updated ${ago(ov.data.at)}` : ''}</span>
      </div>
    </>
  );
}

function HealthRow({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><span className="muted">{label}</span><span style={{ textAlign: 'right' }}><StatusBadge status={ok ? 'ok' : warn ? 'degraded' : 'unavailable'}>{value}</StatusBadge></span></div>;
}
