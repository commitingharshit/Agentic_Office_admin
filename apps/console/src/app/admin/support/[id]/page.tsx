import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Timeline } from '../../../../components/admin/Feed';
import { ErrorState, Flash, PageHeader, Section, StatusBadge } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { replyTicket, setTicketStatus } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ticket' };

export default async function Ticket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>(`/admin/tickets/${encodeURIComponent(id)}`, person.id);
  if (!res.ok) { if (/No such/.test(res.error)) notFound(); return <><PageHeader title="Ticket" /><ErrorState message={res.error} /></>; }
  const { ticket: t, messages } = res.data;
  const canWrite = permissions.includes('support.write');
  return (
    <>
      <PageHeader title={t.subject} subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><StatusBadge status={t.status} /><Link href={`/admin/users/${t.user_id}`}>{t.email}</Link></span>}
        actions={canWrite ? <form action={setTicketStatus} className="form-row"><input type="hidden" name="id" value={t.id} /><select name="status" defaultValue={t.status} aria-label="Status"><option value="open">Open</option><option value="pending">Waiting for the person</option><option value="closed">Closed</option></select><button className="btn sm">Set</button></form> : undefined} />
      <Flash q={q} />
      <Section title="Conversation" count={messages.length}>
        <Timeline items={messages.map((m: any) => ({ at: m.created_at, title: m.author === 'admin' ? 'Support' : t.email, detail: <span style={{ whiteSpace: 'pre-wrap' }}>{m.body}</span> }))} />
      </Section>
      {canWrite && t.status !== 'closed' && (
        <Section title="Reply">
          <form action={replyTicket} className="form-row"><input type="hidden" name="id" value={t.id} />
            <label className="field" style={{ flex: 1, minWidth: 280 }}><span>Message</span><textarea name="body" required rows={4} maxLength={4000} style={{ width: '100%' }} /></label>
            <button className="btn primary">Send reply</button></form>
        </Section>)}
    </>
  );
}
