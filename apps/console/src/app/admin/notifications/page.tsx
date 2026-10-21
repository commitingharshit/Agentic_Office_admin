import Link from 'next/link';
import { EmptyState, ErrorState, PageHeader, Section, StatusBadge } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notifications' };
const tone: Record<string, string> = { action: 'Needs you', warn: 'Look at', info: 'For your information' };

export default async function Notifications() {
  const { person } = await adminContext();
  const r = await load<{ items: Array<{ id: string; level: string; title: string; detail: string; href: string }> }>('/admin/attention', person.id);
  return (
    <>
      <PageHeader title="Notifications" subtitle="What needs a person right now, read from the database each time you open this page. It lists only what your role can open." />
      {!r.ok ? <ErrorState message={r.error} /> : (
        <Section title="Right now" count={r.data.items.length}>
          {r.data.items.length ? (
            <div className="table-wrap"><table className="dt"><tbody>{r.data.items.map((i) => (
              <tr key={i.id}><td style={{ width: 150 }}><StatusBadge status={i.level === 'action' ? 'failed' : i.level === 'warn' ? 'pending' : 'active'}>{tone[i.level] ?? i.level}</StatusBadge></td>
                <td><Link href={i.href}><b>{i.title}</b></Link><div className="muted" style={{ fontSize: 12 }}>{i.detail}</div></td></tr>))}</tbody></table></div>
          ) : <EmptyState title="Nothing needs attention">New payments to check, stuck checkouts, bad webhook signatures and open tickets will appear here.</EmptyState>}
          <p className="hint">Alerts are not sent anywhere by themselves: the bell in the top bar shows this same list. Email or chat delivery needs a provider key and is not switched on.</p>
        </Section>)}
    </>
  );
}
