import Link from 'next/link';
import { EmptyState, ErrorState, Flash, Notice, PageHeader, Person, Section, StatusBadge, ago } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { approveAccess, declineAccess } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Access requests' };

export default async function Access({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const all = q.show === 'all';
  const r = await load<any>(`/admin/access-requests?status=${all ? 'all' : 'pending'}`, person.id);
  const canWrite = permissions.includes('roles.write');
  return (
    <>
      <PageHeader title="Access requests" subtitle="People who signed in and asked to become administrators. Nobody is let in until you approve."
        actions={<Link className="btn sm" href={all ? '/admin/access' : '/admin/access?show=all'}>{all ? 'Show waiting only' : 'Show history'}</Link>} />
      <Flash q={q} />
      {!canWrite && <Notice icon="info">You can see requests, but only an administrator who manages roles can decide them.</Notice>}
      {!r.ok ? <ErrorState message={r.error} /> : (
        <Section title={all ? 'All requests' : 'Waiting for a decision'} count={r.data.requests.length}>
          {r.data.requests.length ? (
            <div className="table-wrap"><table className="dt"><thead><tr><th>Person</th><th>Said</th><th>Asked</th><th>State</th>{canWrite && <th>Decide</th>}</tr></thead>
              <tbody>{(r.data.requests as any[]).map((x) => (
                <tr key={x.id}>
                  <td><Person id={x.user_id} email={x.email} name={x.display_name} href={`/admin/users/${x.user_id}`} /></td>
                  <td className="muted">{x.note ?? '—'}</td><td>{ago(x.created_at)}</td>
                  <td><StatusBadge status={x.status === 'approved' ? 'active' : x.status === 'declined' ? 'failed' : 'pending'}>{x.status}{x.decided_role ? ` as ${x.decided_role}` : ''}</StatusBadge></td>
                  {canWrite && <td>{x.status === 'pending' ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <form action={approveAccess} className="form-row"><input type="hidden" name="id" value={x.id} />
                        <select name="admin_role" defaultValue="analyst" aria-label={`Role for ${x.email}`}>{(r.data.roles as string[]).map((role) => <option key={role} value={role}>{role}</option>)}</select>
                        <button className="btn primary sm">Approve</button></form>
                      <form action={declineAccess} className="form-row"><input type="hidden" name="id" value={x.id} /><input name="note" placeholder="Reason (optional)" aria-label="Reason" maxLength={300} /><button className="btn sm">Decline</button></form>
                    </div>) : <span className="muted">{x.decided_by ? `by ${x.decided_by}` : ''}</span>}</td>}
                </tr>))}</tbody></table></div>
          ) : <EmptyState icon="inbox" title="No one is waiting">When someone signs in to the console and asks for access, they show up here and in the notification bell.</EmptyState>}
          <p className="hint">Choose the narrowest role that does the job: analyst only reads; support manages users and sessions; finance handles credits, coupons and payments; engineer manages plans and devices; superadmin does everything.</p>
        </Section>)}
    </>
  );
}
