import Link from 'next/link';
import { DataTable, Pager, type Column } from '../../../components/admin/DataTable';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, num, when } from '../../../components/admin/bits';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { createPlan, updatePlan } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Billing & Plans' };
type Sub = { user_id: string; email: string; plan_id: string; status: string; started_at: string; ends_at: string | null; source: string | null };
const money = (cents: number | null, currency: string, interval: string | null) =>
  cents === null ? 'No price set' : cents === 0 ? 'Free' : `${new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)}${interval ? ` / ${interval}` : ''}`;

function PlanForm({ p }: { p?: any }) {
  return (
    <div className="form-row" style={{ alignItems: 'flex-end' }}>
      {p ? <input type="hidden" name="id" value={p.id} /> : <label className="field"><span>Id (lower-case)</span><input name="id" required pattern="[a-z0-9_-]{1,40}" placeholder="pro" /></label>}
      <label className="field"><span>Name</span><input name="name" required defaultValue={p?.name ?? ''} placeholder="Pro" /></label>
      <label className="field" style={{ flex: 1, minWidth: 220 }}><span>What it is for</span><input name="description" defaultValue={p?.description ?? ''} /></label>
      <label className="field"><span>Price</span><input name="price" type="number" min="0" step="0.01" defaultValue={p?.price_cents == null ? '' : (p.price_cents / 100).toString()} placeholder="not set" style={{ width: 100 }} /></label>
      <label className="field"><span>Currency</span><input name="currency" defaultValue={p?.currency ?? 'inr'} maxLength={3} style={{ width: 70 }} /></label>
      <label className="field"><span>Billed</span><select name="billing_interval" defaultValue={p?.billing_interval ?? ''}><option value="">Not billed</option><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
      <label className="field"><span>Credits each month</span><input name="monthly_credits" type="number" min="0" step="1" defaultValue={p?.monthly_credits ?? 0} style={{ width: 130 }} /></label>
      <label className="field"><span>Runs at once</span><input name="max_concurrent_runs" type="number" min="1" max="100" defaultValue={p?.max_concurrent_runs ?? ''} placeholder="1" style={{ width: 90 }} /></label>
      <label className="field"><span>Longest job (s)</span><input name="max_job_seconds" type="number" min="10" max="86400" defaultValue={p?.max_job_seconds ?? ''} placeholder="600" style={{ width: 110 }} /></label>
      <label className="field"><span>Requests / min</span><input name="requests_per_minute" type="number" min="1" max="10000" defaultValue={p?.requests_per_minute ?? ''} placeholder="20" style={{ width: 110 }} /></label>
      <label className="field" style={{ minWidth: 200 }}><span>Models (blank = all)</span><input name="allowed_models" defaultValue={(p?.allowed_models ?? []).join(', ')} placeholder="model-a, model-b" /></label>
      <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><input type="checkbox" name="top_up_eligible" defaultChecked={p?.top_up_eligible ?? false} /><span>May buy top-ups</span></label>
      <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><input type="checkbox" name="managed_inference" defaultChecked={p?.managed_inference ?? false} /><span>Agentic Office compute</span></label>
      {p && <label className="field" style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><input type="checkbox" name="active" defaultChecked={p.active} disabled={p.id === 'free'} /><span>On (people can choose it)</span></label>}
      <button className="btn primary">{p ? 'Save' : 'Create plan'}</button>
    </div>
  );
}

export default async function Billing({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const params = new URLSearchParams({ pageSize: '25' });
  for (const k of ['plan', 'status', 'page']) if (q[k]) params.set(k, q[k]);
  const [plans, subs] = await Promise.all([load<any>('/admin/plans', person.id), load<any>(`/admin/subscriptions?${params}`, person.id)]);
  const canWrite = permissions.includes('plans.write');
  const columns: Column<Sub>[] = [
    { key: 'user', label: 'User', render: (s) => <Link href={`/admin/users/${s.user_id}`}>{s.email}</Link> },
    { key: 'plan', label: 'Plan', render: (s) => <StatusBadge status={s.plan_id} /> },
    { key: 'status', label: 'Status', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'since', label: 'Since', render: (s) => when(s.started_at) },
    { key: 'ends', label: 'Ends', render: (s) => s.ends_at ? when(s.ends_at) : '—' },
    { key: 'source', label: 'Source', render: (s) => s.source ?? '—' },
  ];
  return (
    <>
      <PageHeader title="Billing & Plans" subtitle="What each plan costs and gives, and who is on it." />
      <Flash q={q} />
      <Notice icon="info">Prices live in the database and are in rupees. A plan can be switched on only once it has a price (0 for a free plan); the Max plans start as drafts with no price or credits until you set them. A payment never activates a plan by itself: see <Link href="/admin/payments">Payments</Link>. The plan a person is on is also written to their Keycloak account.</Notice>
      <Section title="Plans" count={plans.ok ? plans.data.plans.length : undefined}>
        {plans.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Plan</th><th>Price</th><th className="right">Credits / month</th><th>Compute</th><th className="right">Subscribers</th><th>State</th><th /></tr></thead>
            <tbody>{(plans.data.plans as any[]).map((p) => (
              <tr key={p.id}>
                <td>{p.name} <span className="faint mono">{p.id}</span>{p.description ? <div className="muted" style={{ fontSize: 12 }}>{p.description}</div> : null}</td>
                <td>{money(p.price_cents, p.currency, p.billing_interval)}</td><td className="num">{num(p.monthly_credits)}</td><td>{p.managed_inference ? 'Included' : 'Own key or local'}<div className="muted" style={{ fontSize: 12 }}>{p.max_concurrent_runs ?? 1} at once · {p.requests_per_minute ?? 20}/min · {p.allowed_models?.length ? p.allowed_models.length + ' models' : 'all models'}</div></td>
                <td className="num">{num(p.subscribers)}</td><td><StatusBadge status={p.active ? 'active' : 'disabled'}>{p.active ? 'on' : 'draft'}</StatusBadge></td>
                <td className="right">{canWrite ? <details><summary className="btn sm">Edit</summary><form action={updatePlan} style={{ marginTop: 10, textAlign: 'left' }}><PlanForm p={p} /></form></details> : null}</td>
              </tr>))}</tbody></table></div>
        ) : <ErrorState message={plans.error} />}
      </Section>
      {canWrite && (
        <Section title="New plan">
          <form action={createPlan}><PlanForm /></form>
        </Section>)}
      <Section title="Subscriptions" count={subs.ok ? subs.data.total : undefined}>
        {subs.ok ? <>
          <DataTable<Sub> columns={columns} rows={subs.data.subscriptions} base="/admin/billing" query={q} rowKey={(s) => `${s.user_id}${s.started_at}`} emptyTitle="No explicit subscriptions" emptyHint={`${subs.data.on_default_plan} active users are on the default free plan.`} />
          <Pager base="/admin/billing" query={q} page={subs.data.page} pageSize={subs.data.pageSize} total={subs.data.total} />
          <div className="hint" style={{ marginTop: 8 }}>{num(subs.data.on_default_plan)} active users are on the default free plan without a subscription row.</div></>
          : <ErrorState message={subs.error} />}
      </Section>
    </>
  );
}
