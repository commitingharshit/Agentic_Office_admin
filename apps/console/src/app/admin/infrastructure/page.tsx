import { MetricCard } from '../../../components/admin/MetricCard';
import { ErrorState, Notice, PageHeader, Section, StatusBadge, ago, bytes, num, when } from '../../../components/admin/bits';
import { walHealthy, walText } from '../../../components/admin/wal';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Infrastructure' };

export default async function Infra() {
  const { person } = await adminContext();
  const [health, rel, status] = await Promise.all([load<any>('/admin/health', person.id), load<any>('/admin/reliability?days=30', person.id), load<any>('/admin/status', person.id)]);
  if (!health.ok) return <><PageHeader title="Infrastructure" /><ErrorState message={health.error} /></>;
  const h = health.data;
  const conns = (h.connections as any[]).reduce((a, c) => a + c.n, 0);
  const backupOk = h.backup.configured && !h.backup.error && (h.backup.age_hours ?? 99) < 36;
  return (
    <>
      <PageHeader title="Infrastructure" subtitle="What the platform is running on, read from the database and the backup store. Nothing here exposes a host secret." />
      <div className="grid kpis">
        <MetricCard label="Database" value={bytes(Number(h.db.bytes))} hint={`${num(conns)} of ${num(h.db.max_connections)} connections`} />
        <MetricCard label="Latest backup" value={h.backup.age_hours != null ? `${h.backup.age_hours} h ago` : h.backup.configured ? 'none yet' : 'not configured'} hint={h.backup.drill ? (h.backup.drill.ok ? 'restore drill passed' : 'restore drill FAILED') : 'no restore drill recorded'} />
        <MetricCard label="Sync, last 24 h" value={num(h.sync.events_24h)} hint={h.sync.p95_lag_s != null ? `p95 lag ${Math.round(h.sync.p95_lag_s)} s` : 'no events'} />
        <MetricCard label="Devices reporting" value={num(h.devices.reporting)} hint={h.devices.reporting ? 'in the last day' : 'none have reported'} />
      </div>
      <Section title="Services" count={status.ok ? status.data.services.length : undefined}>
        {status.ok && status.data.services.length ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Service</th><th>State</th><th className="right">Answer time</th><th className="right">90 days</th><th>Checked</th><th>In this state since</th></tr></thead>
            <tbody>{(status.data.services as any[]).map((s) => (
              <tr key={s.id}><td>{s.label}</td><td><StatusBadge status={s.state === 'up' ? 'active' : s.state === 'degraded' ? 'degraded' : 'failed'}>{s.state}</StatusBadge></td>
                <td className="num">{s.latencyMs != null ? `${s.latencyMs} ms` : '—'}</td><td className="num">{s.uptime90d != null ? `${s.uptime90d}%` : '—'}</td><td className="muted">{ago(s.checkedAt)}</td><td className="muted">{when(s.since)}</td></tr>))}</tbody></table></div>
        ) : <Notice tone="warn" icon="alert">{status.ok ? 'No service has reported yet. The checks start with the API and the prober; if this stays empty the prober is not running.' : `Service status could not be read: ${status.error}`}</Notice>}
        <p className="faint">The same list, without the details, is public at <span className="mono">/status</span> on the app's sign-in address. A service not confirmed for 3 minutes is shown as down.</p>
      </Section>
      <Section title="Checks">
        <div className="table-wrap"><table className="dt"><tbody>
          <tr><td>Postgres</td><td className="muted">{String(h.db.version).split(' ').slice(0, 2).join(' ')} · up since {new Date(h.db.started_at).toLocaleDateString('en-GB')}</td><td className="right"><StatusBadge status="active">reachable</StatusBadge></td></tr>
          <tr><td>Backups</td><td className="muted">{h.backup.configured ? (h.backup.error ? `error: ${h.backup.error}` : `latest ${h.backup.latest ?? '—'}${h.backup.bytes ? ` · ${bytes(Number(h.backup.bytes))}` : ''}`) : 'no backup store configured'}</td><td className="right"><StatusBadge status={backupOk ? 'active' : 'failed'}>{backupOk ? 'healthy' : 'check'}</StatusBadge></td></tr>
          <tr><td>WAL archiving</td><td className="muted">{walText(h.wal)}</td><td className="right"><StatusBadge status={walHealthy(h.wal) ? 'active' : 'failed'}>{walHealthy(h.wal) ? 'healthy' : 'check'}</StatusBadge></td></tr>
        </tbody></table></div>
      </Section>
      <Section title="Largest tables" count={h.tables.length}>
        <div className="table-wrap"><table className="dt"><thead><tr><th>Table</th><th className="right">Rows (approx.)</th><th className="right">Size</th></tr></thead>
          <tbody>{(h.tables as any[]).map((t) => <tr key={t.table}><td className="mono">{t.table}</td><td className="num">{num(t.rows)}</td><td className="num">{bytes(Number(t.bytes))}</td></tr>)}</tbody></table></div>
      </Section>
      <Section title="App versions in use" count={rel.ok ? rel.data.versions.length : undefined}>
        {rel.ok && rel.data.versions.length ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Version</th><th className="right">Runs</th><th className="right">People</th></tr></thead>
            <tbody>{(rel.data.versions as any[]).map((v) => <tr key={v.version}><td className="mono">{v.version}</td><td className="num">{num(v.runs)}</td><td className="num">{num(v.users)}</td></tr>)}</tbody></table></div>
        ) : <Notice icon="info">App versions are only known from people who share usage. None have, so this list is empty.</Notice>}
      </Section>
    </>
  );
}
