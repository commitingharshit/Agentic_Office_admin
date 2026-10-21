import Link from 'next/link';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payments' };
const STATUSES = ['', 'observed', 'review', 'pending', 'settled', 'failed', 'expired', 'cancelled', 'refunded', 'rejected'];
const inr = (n: number, c: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c.toUpperCase() }).format(n);

export default async function Payments({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const qs = new URLSearchParams(); if (q.status) qs.set('status', q.status);
  const r = await load<any>(`/admin/payments?${qs}`, person.id);
  return (
    <>
      <PageHeader title="Payments" subtitle="Every order and what the payment provider told us. A plan is activated only when you confirm the bank received the money." />
      <Flash q={q} />
      {r.ok && !r.data.provider && <Notice tone="warn" icon="alert">No payment provider is switched on, so people cannot check out. Existing orders can still be reviewed.</Notice>}
      {r.ok && r.data.provider?.experimental && <Notice tone="warn" icon="alert">The {r.data.provider.id} provider is experimental. A notice from it is an observation, never proof the money arrived.</Notice>}
      {!r.ok ? <ErrorState message={r.error} /> : <>
        <div className="form-row" style={{ gap: 18, margin: '8px 0' }}>
          <span><b>{num(r.data.counts.observed)}</b> to check</span><span><b>{num(r.data.counts.review)}</b> in review</span><span><b>{num(r.data.counts.pending)}</b> open checkouts</span><span><b>{num(r.data.counts.settled)}</b> settled</span>
          <form method="get" className="form-row" style={{ marginLeft: 'auto' }}><select name="status" defaultValue={q.status ?? ''} aria-label="Status">{STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}</select><button className="btn sm">Filter</button></form>
        </div>
        <Section title="Orders" count={r.data.orders.length}>
          <div className="table-wrap"><table className="dt"><thead><tr><th>Order</th><th>Person</th><th>Plan</th><th className="right">Amount</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>{(r.data.orders as any[]).map((o) => (
              <tr key={o.id}><td><Link href={`/admin/payments/${o.id}`} className="mono">{o.id.slice(0, 16)}…</Link></td><td><Link href={`/admin/users/${o.user_id}`}>{o.email}</Link></td><td>{o.plan_id}</td>
                <td className="num">{inr(o.amount, o.currency)}</td><td><StatusBadge status={o.status} /></td><td>{ago(o.created_at)}</td></tr>))}
              {!r.data.orders.length && <tr><td colSpan={6} className="muted">No orders{q.status ? ` with status ${q.status}` : ' yet'}.</td></tr>}</tbody></table></div>
        </Section></>}
    </>
  );
}
