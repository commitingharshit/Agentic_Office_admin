import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { announceRelease, saveRelease, stageRelease } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Releases' };
const STAGES = [0, 1, 5, 25, 50, 100];

export default async function Releases({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/growth/releases', person.id);
  const flags = await load<any>('/admin/flags', person.id);
  const canWrite = permissions.includes('releases.write');
  return (
    <>
      <PageHeader title="Releases" subtitle="What shipped, the feature it switches on, and how far that feature is rolled out. The rollout moves the release's feature flag; the same person always lands in the same slice." />
      <Flash q={q} />
      <Notice icon="info">Rolling out here changes what a build that is already installed does (its feature flag). Shipping a new app binary is separate: this console does not distribute or sign builds. Pausing stops further people getting the feature; it does not undo what they already did with it.</Notice>
      {canWrite && (
        <Section title="New release">
          <form action={saveRelease} className="form-row">
            <label className="field"><span>Version</span><input name="version" required placeholder="1.5.0" pattern="\d+\.\d+\.\d+.*" style={{ width: 100 }} /></label>
            <label className="field"><span>Channel</span><select name="channel" defaultValue="stable"><option>canary</option><option>beta</option><option>stable</option></select></label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Title</span><input name="title" required maxLength={160} placeholder="A new agent planner" /></label>
            <label className="field"><span>Feature flag</span><select name="flag_key" defaultValue=""><option value="">none</option>{flags.ok && (flags.data.flags as any[]).map((f) => <option key={f.key} value={f.key}>{f.key}</option>)}</select></label>
            <label className="field" style={{ flexBasis: '100%' }}><span>Release notes (shown in the inbox)</span><textarea name="notes_md" rows={4} /></label>
            <button className="btn primary">Save release</button>
          </form>
        </Section>)}
      <Section title="Releases" count={res.ok ? res.data.releases.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Version</th><th>Channel</th><th>Title</th><th>Status</th><th>Flag</th><th className="right">Rolled out</th><th>History</th><th /></tr></thead>
            <tbody>{(res.data.releases as any[]).map((r) => (
              <tr key={r.id}><td className="mono">{r.version}</td><td>{r.channel}</td><td>{r.title}</td>
                <td><StatusBadge status={r.status === 'complete' ? 'active' : r.status === 'paused' ? 'disabled' : 'pending'}>{r.status}</StatusBadge></td>
                <td className="mono">{r.flag_key ?? '-'}</td><td className="num">{r.current_pct ?? '-'}{r.current_pct !== null && r.current_pct !== undefined ? '%' : ''}</td>
                <td>{(r.rollouts ?? []).map((x: any) => `${x.stage_pct}%`).join(' → ') || '-'}{r.rollouts?.length ? <span className="muted"> ({ago(r.rollouts[r.rollouts.length - 1].set_at)})</span> : null}</td>
                <td className="right">{canWrite ? (<div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  {r.flag_key && STAGES.map((s) => (<form key={s} action={stageRelease}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="stage_pct" value={s} /><button className={s === 0 ? 'btn' : 'btn'} title={s === 0 ? 'Pause the rollout' : `Roll out to ${s}%`}>{s === 0 ? 'Pause' : `${s}%`}</button></form>))}
                  <form action={announceRelease}><input type="hidden" name="id" value={r.id} /><button className="btn primary">Post release note</button></form></div>) : null}</td></tr>))}
              {!res.data.releases.length && <tr><td colSpan={8} className="dt-empty">No releases yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
    </>
  );
}
