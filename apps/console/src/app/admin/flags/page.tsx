import { ConfirmForm } from '../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { deleteFlag, saveFlag } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Feature Flags' };

export default async function Flags({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/flags', person.id);
  const canWrite = permissions.includes('flags.write');
  return (
    <>
      <PageHeader title="Feature Flags" subtitle="Switch behaviour on or off for everyone, a plan, or a share of people. The server decides; the app only asks." />
      <Flash q={q} />
      <Notice icon="info">A person always lands in the same slice of a rollout. <b>killswitch.managed_inference</b>, when switched on, makes the server refuse managed inference for the people it covers, whatever the app does.</Notice>
      {canWrite && (
        <Section title="Add or change a flag">
          <form action={saveFlag} className="form-row">
            <label className="field"><span>Key</span><input name="key" required pattern="[a-z0-9][a-z0-9_.\-]{0,59}" placeholder="new_editor" /></label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}><span>What it does</span><input name="description" /></label>
            <label className="field"><span>Rollout %</span><input name="rollout_pct" type="number" min="0" max="100" defaultValue="100" style={{ width: 90 }} /></label>
            <label className="field"><span>Only these plans (comma-separated)</span><input name="plan_ids" placeholder="all plans" /></label>
            <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><input type="checkbox" name="enabled" /><span>On</span></label>
            <button className="btn primary">Save flag</button></form>
        </Section>)}
      <Section title="Flags" count={res.ok ? res.data.flags.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Key</th><th>State</th><th className="right">Rollout</th><th>Plans</th><th>What it does</th><th>Changed</th><th /></tr></thead>
            <tbody>{(res.data.flags as any[]).map((f) => (
              <tr key={f.key}><td className="mono">{f.key}</td><td><StatusBadge status={f.enabled ? 'active' : 'disabled'}>{f.enabled ? 'on' : 'off'}</StatusBadge></td><td className="num">{f.rollout_pct}%</td><td>{f.plan_ids ? f.plan_ids.join(', ') : 'all'}</td><td>{f.description}</td><td>{ago(f.updated_at)}</td>
                <td className="right">{canWrite ? <ConfirmForm action={deleteFlag} fields={{ key: f.key }} label="Delete" title={`Delete ${f.key}?`} body="The flag is removed. Anything that depends on it falls back to its default." confirmLabel="Delete flag" /> : null}</td></tr>))}
              {!res.data.flags.length && <tr><td colSpan={7} className="dt-empty">No flags yet. Nothing is switched by flags until you add one.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
    </>
  );
}
