import Link from 'next/link';
import { AreaChart } from '../../../components/admin/Charts';
import { MetricCard } from '../../../components/admin/MetricCard';
import { ErrorState, Flash, Notice, PageHeader, Section, num } from '../../../components/admin/bits';
import { Tabs } from '../../../components/admin/DataTable';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { grantCreditsByEmail } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Compute & Credits' };
const BY = [{ key: 'model', label: 'By model' }, { key: 'user', label: 'By user' }, { key: 'day', label: 'By day' }];

export default async function Compute({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const by = BY.some((b) => b.key === q.by) ? q.by : 'model';
  const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
  const { person, permissions } = await adminContext();
  const [res, daily] = await Promise.all([load<any>(`/admin/usage/summary?by=${by}&days=${days}`, person.id), load<any>(`/admin/usage/summary?by=day&days=${days}`, person.id)]);
  if (!res.ok) return <><PageHeader title="Compute & Credits" /><ErrorState message={res.error} /></>;
  const d = res.data, t = d.totals;
  return (
    <>
      <PageHeader title="Compute & Credits" subtitle="Inference that Agentic Office pays for, and the credits that pay for it."
        actions={<form method="get" className="form-row"><input type="hidden" name="by" value={by} /><select name="days" defaultValue={String(days)} aria-label="Date range">{[7, 30, 90].map((n) => <option key={n} value={n}>Last {n} days</option>)}</select><button className="btn sm">Apply</button></form>} />
      <Flash q={q} />
      <Notice icon="info">{d.note}</Notice>
      {permissions.includes('credits.write') && (
        <Section title="Add credits by hand">
          <form action={grantCreditsByEmail} className="form-row">
            <label className="field"><span>Their email</span><input name="email" type="email" required placeholder="someone@example.com" style={{ minWidth: 230 }} /></label>
            <label className="field"><span>Type</span><select name="kind"><option value="grant">Grant</option><option value="refund">Refund</option><option value="adjust">Adjust (±)</option></select></label>
            <label className="field"><span>Pool</span><select name="pool"><option value="paid">Paid</option><option value="promo">Promotional</option></select></label>
            <label className="field"><span>Amount</span><input name="amount" type="number" step="1" required style={{ width: 110 }} /></label>
            <label className="field"><span>Expires after (days, promo)</span><input name="valid_days" type="number" min="1" style={{ width: 110 }} /></label>
            <label className="field" style={{ flex: 1, minWidth: 220 }}><span>Reason (kept in the ledger)</span><input name="reason" required minLength={3} /></label>
            <button className="btn primary">Record</button></form>
        </Section>)}
      <div className="grid kpis">
        <MetricCard icon="compute" label="Managed requests" value={num(t.requests)} hint={`last ${days} days`} />
        <MetricCard icon="billing" label="Credits spent" value={num(d.credits.spent)} hint={`${num(d.credits.granted)} granted`} />
        <MetricCard icon="runs" label="Tokens" value={num(t.tokens_in + t.tokens_out)} hint={`${num(t.tokens_in)} in · ${num(t.tokens_out)} out`} />
        <MetricCard icon="gift" label="Outstanding credits" value={num(d.credits.outstanding_promo + d.credits.outstanding_paid)} hint={`${num(d.credits.outstanding_promo)} promo · ${num(d.credits.outstanding_paid)} paid`} />
      </div>
      {daily.ok && daily.data.rows.length > 1 && <Section title="Credits spent per day"><div className="card"><div className="card-body"><AreaChart data={daily.data.rows.map((r: any) => r.cost)} labels={daily.data.rows.map((r: any) => r.key)} unit="credits" /></div></div></Section>}
      <Tabs base="/admin/compute" param="by" current={by} tabs={BY} />
      <div className="table-wrap"><table className="dt"><thead><tr><th>{by === 'user' ? 'User' : by === 'day' ? 'Day' : 'Model'}</th><th className="right">Requests</th><th className="right">Tokens in</th><th className="right">Tokens out</th><th className="right">Credits</th></tr></thead>
        <tbody>{d.rows.map((r: any) => <tr key={r.key}><td>{by === 'user' ? <Link href={`/admin/users/${r.key}`}>{r.label ?? r.key}</Link> : r.key}</td><td className="num">{num(r.requests)}</td><td className="num">{num(r.tokens_in)}</td><td className="num">{num(r.tokens_out)}</td><td className="num">{num(r.cost)}</td></tr>)}
          {!d.rows.length && <tr><td colSpan={5} className="dt-empty">No managed inference in this period.</td></tr>}</tbody></table></div>
    </>
  );
}
