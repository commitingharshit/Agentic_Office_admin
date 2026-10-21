import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, when } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { refundOrder, rejectOrder, reconcileOrder, settleOrder } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment' };
const inr = (n: number, c: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c.toUpperCase() }).format(n);

export default async function Order({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const { person, permissions } = await adminContext();
  const r = await load<any>(`/admin/payments/${encodeURIComponent(id)}`, person.id);
  if (!r.ok && /No such order/.test(r.error)) notFound();
  if (!r.ok) return <ErrorState message={r.error} />;
  const { order: o, attempts, events, invoice, period } = r.data;
  const write = permissions.includes('payments.write');
  const waiting = o.status === 'observed' || o.status === 'review';
  return (
    <>
      <PageHeader title={`Order ${o.id.slice(0, 14)}…`} subtitle={<>For <Link href={`/admin/users/${o.user_id}`}>{o.email}</Link> · {o.plan_id} · {inr(o.amount, o.currency)} {o.billing_interval ? `/ ${o.billing_interval}` : ''}</>} actions={<StatusBadge status={o.status} />} />
      <Flash q={q} />
      {waiting && <Notice tone="warn" icon="alert">The provider reported this as paid. That is not proof. Open your bank statement, find a credit of exactly <b>{inr(o.amount, o.currency)}</b>{o.provider_reference ? <> with reference <b className="mono">{o.provider_reference}</b></> : null}, then settle. If you cannot find it, reject.</Notice>}
      {o.review_reason && <Notice icon="info">{o.review_reason}</Notice>}
      {write && waiting && (
        <Section title="Settle after checking the bank">
          <form action={settleOrder} className="form-row" style={{ alignItems: 'flex-end' }}>
            <input type="hidden" name="id" value={o.id} />
            <label className="field"><span>Amount the bank received</span><input name="amount_received" required inputMode="decimal" placeholder={String(o.amount)} /></label>
            <label className="field"><span>Bank reference{o.status === 'review' && !o.provider_reference ? '' : ' (optional)'}</span><input name="reference" defaultValue={o.provider_reference ?? ''} /></label>
            <label className="field" style={{ flex: 1, minWidth: 240 }}><span>How you checked</span><input name="reason" required minLength={3} maxLength={500} placeholder="Found the credit in the HDFC statement, 21 Oct" /></label>
            <button className="btn primary">Settle and activate</button>
          </form>
          <form action={rejectOrder} className="form-row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
            <input type="hidden" name="id" value={o.id} />
            <label className="field" style={{ flex: 1, minWidth: 240 }}><span>Reject: why</span><input name="reason" required minLength={3} maxLength={500} placeholder="No matching bank credit" /></label>
            <button className="btn">Reject (activates nothing)</button>
          </form>
        </Section>)}
      {write && (o.status === 'pending' || o.status === 'created') && (
        <Section title="Ask the provider"><form action={reconcileOrder}><input type="hidden" name="id" value={o.id} /><button className="btn">Reconcile now</button><span className="hint"> Asks the provider what it knows. It records what it says; it does not activate anything.</span></form></Section>)}
      {write && o.status === 'settled' && (
        <Section title="Refund">
          <form action={refundOrder} className="form-row" style={{ alignItems: 'flex-end' }}><input type="hidden" name="id" value={o.id} />
            <label className="field" style={{ flex: 1, minWidth: 240 }}><span>Why</span><input name="reason" required minLength={3} maxLength={500} /></label>
            <button className="btn">Refund and return to Free</button></form>
          <p className="hint">Records the refund and takes the plan back. Sending the money back is done in your bank or with the provider, outside this console.</p>
        </Section>)}
      <Section title="What happened">
        <div className="table-wrap"><table className="dt"><tbody>
          <tr><td>Created</td><td>{when(o.created_at)}</td></tr>
          {o.observed_at && <tr><td>Provider reported paid</td><td>{when(o.observed_at)}</td></tr>}
          {o.settled_at && <tr><td>Settled</td><td>{when(o.settled_at)} by <span className="mono">{o.settled_by ?? '—'}</span></td></tr>}
          {invoice && <tr><td>Invoice</td><td className="mono">{invoice.number}</td></tr>}
          {period && <tr><td>Plan period</td><td>{when(period.starts_at)} to {when(period.ends_at)}</td></tr>}
        </tbody></table></div>
      </Section>
      <Section title="Provider attempts" count={attempts.length}>
        <div className="table-wrap"><table className="dt"><tbody>{(attempts as any[]).map((a) => <tr key={a.id}><td>{a.provider}</td><td className="mono">{a.provider_payment_id ?? '—'}</td><td><StatusBadge status={a.status} /></td><td className="muted">{a.error ?? ''}</td><td>{when(a.created_at)}</td></tr>)}
          {!attempts.length && <tr><td className="muted">None.</td></tr>}</tbody></table></div>
      </Section>
      <Section title="Notices received" count={events.length}>
        <div className="table-wrap"><table className="dt"><thead><tr><th>When</th><th>Event</th><th>Signature</th><th>Outcome</th></tr></thead><tbody>{(events as any[]).map((e) => <tr key={e.id}><td>{when(e.received_at)}</td><td>{e.event}</td><td><StatusBadge status={e.signature_ok ? 'active' : 'failed'}>{e.signature_ok ? 'valid' : 'bad'}</StatusBadge></td><td className="muted">{e.outcome ?? ''}</td></tr>)}
          {!events.length && <tr><td colSpan={4} className="muted">None.</td></tr>}</tbody></table></div>
      </Section>
    </>
  );
}
