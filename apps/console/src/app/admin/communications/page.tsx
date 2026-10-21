import { ConfirmForm } from '../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { createAnnouncement, emailAnnouncement, setAnnouncement } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Communications' };

export default async function Comms({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/announcements', person.id);
  const canWrite = permissions.includes('comms.write');
  const ch = res.ok ? res.data.channels : null;
  return (
    <>
      <PageHeader title="Communications" subtitle="Announcements people see inside the app. Each person sees one until they dismiss it." />
      <Flash q={q} />
      {ch && (
        <div className="grid kpis">
          <div className="card kpi"><div className="label">In-app</div><div className="value"><StatusBadge status="active">connected</StatusBadge></div></div>
          <div className="card kpi"><div className="label">Email</div><div className="value"><StatusBadge status={ch.email.configured ? 'active' : 'disabled'}>{ch.email.configured ? 'connected' : 'not configured'}</StatusBadge></div><div className="hint">{ch.email.configured ? 'A provider key is set.' : 'No email provider key is set, so nothing is emailed.'}</div></div>
          <div className="card kpi"><div className="label">WhatsApp</div><div className="value"><StatusBadge status="disabled">not configured</StatusBadge></div><div className="hint">No integration exists yet.</div></div>
        </div>)}
      {canWrite && (
        <Section title="New announcement">
          <form action={createAnnouncement} className="form-row">
            <label className="field" style={{ minWidth: 220 }}><span>Title</span><input name="title" required maxLength={160} /></label>
            <label className="field" style={{ flex: 1, minWidth: 260 }}><span>Message</span><input name="body" required maxLength={4000} /></label>
            <label className="field"><span>Kind</span><select name="level"><option value="info">Information</option><option value="warn">Warning</option></select></label>
            <label className="field"><span>Only these plans</span><input name="plan_ids" placeholder="all plans" /></label>
            <label className="field"><span>Stop showing on</span><input name="ends_at" type="date" /></label>
            <button className="btn primary">Publish</button></form>
        </Section>)}
      <Section title="Announcements" count={res.ok ? res.data.announcements.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Title</th><th>Kind</th><th>Plans</th><th>Published</th><th>Ends</th><th className="right">Read by</th><th className="right">Emailed</th><th>State</th><th /></tr></thead>
            <tbody>{(res.data.announcements as any[]).map((a) => (
              <tr key={a.id}><td title={a.body}>{a.title}</td><td>{a.level}</td><td>{a.plan_ids ? a.plan_ids.join(', ') : 'all'}</td><td>{ago(a.created_at)}</td><td>{a.ends_at ? new Date(a.ends_at).toLocaleDateString('en-GB') : '—'}</td><td className="num">{num(a.reads)}</td><td className="num">{num(a.emailed)}{a.email_failed ? <span className="faint"> · {a.email_failed} failed</span> : null}</td><td><StatusBadge status={a.active ? 'active' : 'disabled'}>{a.active ? 'live' : 'off'}</StatusBadge></td>
                <td className="right">{canWrite && a.active && ch?.email.configured ? <ConfirmForm action={emailAnnouncement} fields={{ id: a.id }} label="Email" tone="primary" phrase="SEND" title="Email this to everyone?" body="Every active person with an address who has not had it yet gets this message now. Each result is recorded." confirmLabel="Send email" /> : null}{canWrite ? <ConfirmForm action={setAnnouncement} fields={{ id: a.id, active: a.active ? 'false' : 'true' }} label={a.active ? 'Switch off' : 'Switch on'} tone={a.active ? 'danger' : 'primary'} title={a.active ? 'Stop showing this?' : 'Show this again?'} body={a.active ? 'People who have not read it will no longer see it.' : 'People who have not read it will see it.'} /> : null}</td></tr>))}
              {!res.data.announcements.length && <tr><td colSpan={9} className="dt-empty">No announcements yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
      <Notice icon="info">{ch?.email.configured ? 'Email goes out one message per person, only when you press Email, and each result comes from the provider. Templates and scheduling are not built.' : 'Email sending is built but switched off: set RESEND_API_KEY and AO_MAIL_FROM on the API service to turn it on. Until then nothing is emailed.'}</Notice>
    </>
  );
}
