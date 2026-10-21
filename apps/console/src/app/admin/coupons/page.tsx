import { ConfirmForm } from '../../../components/admin/client';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, num } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { createCoupon, toggleCoupon } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Coupons' };

export default async function Coupons({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const [list, plans] = await Promise.all([load<any>('/admin/coupons', person.id), load<any>('/admin/plans', person.id)]);
  const canWrite = permissions.includes('coupons.write');
  return (
    <>
      <PageHeader title="Coupons" subtitle="A coupon turns into a credit grant when someone redeems it. It is never a credential." />
      <Flash q={q} />
      {canWrite && (
        <Section title="New coupon">
          <form action={createCoupon} className="form-row">
            <label className="field"><span>Code (blank to generate)</span><input name="code" placeholder="WELCOME-2026" /></label>
            <label className="field"><span>Credits</span><input name="amount" type="number" min="1" required style={{ width: 110 }} /></label>
            <label className="field"><span>Pool</span><select name="pool"><option value="promo">Promotional</option><option value="paid">Paid</option></select></label>
            <label className="field"><span>Max uses</span><input name="max_redemptions" type="number" min="1" style={{ width: 90 }} /></label>
            <label className="field"><span>Credits last (days)</span><input name="grant_valid_days" type="number" min="1" style={{ width: 110 }} /></label>
            <label className="field"><span>Also sets plan</span><select name="plan_id"><option value="">None</option>{plans.ok && (plans.data.plans as any[]).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field"><span>Code valid until</span><input name="expires_at" type="date" /></label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}><span>Note</span><input name="note" /></label>
            <button className="btn primary">Create</button></form>
        </Section>)}
      <Section title="All coupons" count={list.ok ? list.data.coupons.length : undefined}>
        {list.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Code</th><th className="right">Credits</th><th>Pool</th><th>Used</th><th>Plan</th><th>Valid until</th><th>Note</th><th>State</th><th /></tr></thead>
            <tbody>{(list.data.coupons as any[]).map((c) => (
              <tr key={c.code}><td className="mono">{c.code}</td><td className="num">{num(c.amount)}</td><td>{c.pool}</td><td>{num(c.redeemed_count)}{c.max_redemptions ? ` / ${num(c.max_redemptions)}` : ''}</td><td>{c.plan_id ?? '—'}</td>
                <td>{c.expires_at ? new Date(c.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td><td>{c.note ?? ''}</td><td><StatusBadge status={c.active ? 'active' : 'disabled'} /></td>
                <td className="right">{canWrite ? <ConfirmForm action={toggleCoupon} fields={{ code: c.code, to: c.active ? 'disable' : 'enable' }} label={c.active ? 'Disable' : 'Enable'} tone={c.active ? 'danger' : 'primary'} title={`${c.active ? 'Disable' : 'Enable'} ${c.code}?`} body={c.active ? 'Nobody can redeem it any more. Credits already granted stay.' : 'People can redeem it again.'} /> : null}</td></tr>))}
              {!list.data.coupons.length && <tr><td colSpan={9} className="dt-empty">No coupons yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={list.error} />}
      </Section>
    </>
  );
}
