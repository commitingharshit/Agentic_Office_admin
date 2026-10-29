import Link from 'next/link';
import { ConfirmForm, CopyId } from '../../../../components/admin/client';
import { DataTable, Tabs, type Column } from '../../../../components/admin/DataTable';
import { Timeline } from '../../../../components/admin/Feed';
import { MetricCard } from '../../../../components/admin/MetricCard';
import { Avatar, EmptyState, ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago, num, when } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { grantCredits, keycloakSignOut, revokeBrowserSessions, revokeDevice, setAdminRole, setPlan, setRole, setStatus, signOutEverywhere } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'User' };
const TABS = [
  { key: 'overview', label: 'Overview' }, { key: 'auth', label: 'Authentication & Devices' }, { key: 'sessions', label: 'Workspace Sessions' },
  { key: 'memories', label: 'Memories' }, { key: 'runs', label: 'Agent Runs' }, { key: 'usage', label: 'Usage & Credits' }, { key: 'support', label: 'Support & Communications' }, { key: 'audit', label: 'Security & Audit' }, { key: 'marketplace', label: 'Marketplace' },
];

export default async function UserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const q = await searchParams;
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'overview';
  const { person, permissions, role: myRole } = await adminContext();
  const can = (p: string) => permissions.includes(p);
  const detail = await load<any>(`/admin/users/${encodeURIComponent(id)}`, person.id);
  if (!detail.ok) { return <><PageHeader title="User" /><ErrorState message={detail.error} /></>; }
  const u = detail.data.user;
  const self = id === person.id;
  const [credits, plans, auth, sessions, runs, audit, admins, kc, signIns] = await Promise.all([
    ['overview', 'usage'].includes(tab) && can('credits.read') ? load<any>(`/admin/users/${encodeURIComponent(id)}/credits`, person.id) : null,
    tab === 'overview' && can('plans.read') ? load<any>('/admin/plans', person.id) : null,
    tab === 'auth' && can('sessions.read') ? load<any>(`/admin/auth-sessions?user_id=${encodeURIComponent(id)}`, person.id) : null,
    tab === 'sessions' && can('sessions.read') ? load<any>(`/admin/sessions?user_id=${encodeURIComponent(id)}&pageSize=50`, person.id) : null,
    tab === 'runs' && can('runs.read') ? load<any>(`/admin/runs?user_id=${encodeURIComponent(id)}&pageSize=50`, person.id) : null,
    tab === 'audit' && can('audit.read') ? load<any>(`/admin/audit?target=${encodeURIComponent(id)}&pageSize=50`, person.id) : null,
    tab === 'overview' && u.role === 'admin' && can('roles.read') ? load<any>('/admin/admins', person.id) : null,
    tab === 'auth' && can('sessions.read') ? load<any>(`/admin/users/${encodeURIComponent(id)}/keycloak`, person.id) : null,
    tab === 'auth' && can('sessions.read') ? load<any>(`/admin/users/${encodeURIComponent(id)}/sign-ins`, person.id) : null,
  ]);
  const mems = tab === 'memories' && can('users.read') ? await load<any>(`/admin/users/${encodeURIComponent(id)}/memories`, person.id) : null;
  const mkt = tab === 'marketplace' && can('marketplace.read') ? await load<any>(`/admin/marketplace/users/${encodeURIComponent(id)}/installs`, person.id) : null;
  const label = u.email ?? u.id;

  return (
    <>
      <PageHeader
        title={label}
        subtitle={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><StatusBadge status={u.status} />{u.role === 'admin' && <StatusBadge status="admin" />}<span className="faint">·</span><CopyId value={u.id} short={40} /></span>}
        actions={can('users.write') && !self ? (
          <>
            {u.status === 'active'
              ? <ConfirmForm action={setStatus} fields={{ id, to: 'disable' }} label="Disable account" title={`Disable ${label}?`} body="They are signed out of every device and cannot sign in until you enable the account again. Their data is kept." confirmLabel="Disable account" />
              : <ConfirmForm action={setStatus} fields={{ id, to: 'enable' }} label="Enable account" title={`Enable ${label}?`} body="They will be able to sign in again." tone="primary" confirmLabel="Enable account" />}
            <ConfirmForm action={signOutEverywhere} fields={{ id }} label="Sign out everywhere" title="Sign out of every device?" body="Every device and browser session of this person ends now. They can sign in again." tone="" confirmLabel="Sign out everywhere" />
          </>) : undefined} />
      <Flash q={q} />
      <Tabs base={`/admin/users/${id}`} current={tab} tabs={TABS} />

      {tab === 'overview' && (
        <>
          <div className="grid kpis">
            <MetricCard icon="user" label="Status" value={<StatusBadge status={u.status} />} hint={`joined ${new Date(u.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`} />
            <MetricCard icon="billing" label="Plan" value={credits?.ok ? credits.data.plan_id : '—'} hint={credits?.ok ? `${num(credits.data.promo)} promo · ${num(credits.data.paid)} paid credits` : 'no access to billing'} />
            <MetricCard icon="device" label="Devices" value={num(u.devices)} hint={`${num(u.workspaces)} workspaces`} />
            <MetricCard icon="sessions" label="Work sessions" value={num(u.sessions)} hint={`last active ${ago(u.last_active_at)}`} />
            <MetricCard icon="coupons" label="Memories" value={num(u.memories)} hint={`${(Number(u.storage_bytes) / 1e6).toFixed(1)} MB of documents stored, encrypted`} />
          </div>
          <Notice icon="info"><span>Documents and transcripts are encrypted on this person's devices; this console shows ids, counts, timings and states only. Memories are the exception: their text is readable under Memories, and every view is audited.</span></Notice>

          <Section title="Account">
            <div className="card"><div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 16px' }}>
              <span className="muted">Name</span><span>{u.display_name ?? '—'}</span><span className="muted">Email</span><span>{u.email ?? '—'}</span>
              <span className="muted">Sign-in</span><span>{u.providers ?? 'email and password'}</span><span className="muted">Joined</span><span>{when(u.created_at)}</span>
              <span className="muted">Last active</span><span>{when(u.last_active_at)} <span className="faint">({ago(u.last_active_at)})</span></span>
            </div></div>
          </Section>

          {can('credits.write') && (
            <Section title="Grant or adjust credits">
              <form action={grantCredits} className="form-row"><input type="hidden" name="id" value={id} />
                <label className="field"><span>Type</span><select name="kind"><option value="grant">Grant</option><option value="refund">Refund</option><option value="adjust">Adjust (±)</option></select></label>
                <label className="field"><span>Pool</span><select name="pool"><option value="paid">Paid</option><option value="promo">Promotional</option></select></label>
                <label className="field"><span>Amount</span><input name="amount" type="number" step="1" required style={{ width: 110 }} /></label>
                <label className="field"><span>Expires after (days, promo)</span><input name="valid_days" type="number" min="1" style={{ width: 110 }} /></label>
                <label className="field" style={{ flex: 1, minWidth: 220 }}><span>Reason (kept in the ledger)</span><input name="reason" required minLength={3} /></label>
                <button className="btn primary">Record</button></form>
            </Section>)}

          {can('plans.write') && plans?.ok && (
            <Section title="Plan">
              <form action={setPlan} className="form-row"><input type="hidden" name="id" value={id} />
                <label className="field"><span>Plan</span><select name="plan_id" defaultValue={credits?.ok ? credits.data.plan_id : 'free'}>{(plans.data.plans as any[]).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <button className="btn primary">Set plan</button></form>
            </Section>)}

          {can('roles.write') && !self && (
            <Section title="Administrator access">
              <div className="form-row">
                <form action={setRole} className="form-row"><input type="hidden" name="id" value={id} />
                  <label className="field"><span>Account type</span><select name="role" defaultValue={u.role}><option value="user">User</option><option value="admin">Administrator</option></select></label>
                  <button className="btn">Change role</button></form>
                {u.role === 'admin' && admins?.ok && (
                  <form action={setAdminRole} className="form-row"><input type="hidden" name="id" value={id} />
                    <label className="field"><span>Administrator role</span><select name="admin_role" defaultValue={(admins.data.admins as any[]).find((a) => a.id === id)?.admin_role ?? 'superadmin'}>{(admins.data.roles as string[]).map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
                    <button className="btn">Set role</button></form>)}
              </div>
              <p className="hint">You are signed in as {myRole}. Superadmins can do everything; engineers, support, finance and analysts each get a narrower set. The last superadmin cannot be changed away.</p>
            </Section>)}
        </>)}

      {tab === 'auth' && (
        <>
          {kc?.ok && kc.data.configured && (
            <Section title="Keycloak" actions={kc.data.linked && !kc.data.error && can('users.write') ? <ConfirmForm action={keycloakSignOut} fields={{ id }} label="End Keycloak sessions" title="End every Keycloak session?" body="This also signs them out of every desktop device. They can sign in again." confirmLabel="End sessions" /> : undefined}>
              {!kc.data.linked ? <Notice icon="info">This person has not signed in through Keycloak yet.</Notice>
                : kc.data.error ? <ErrorState message={kc.data.error} />
                : (
                  <>
                    <div className="card"><div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 16px' }}>
                      <span className="muted">Account</span><span><StatusBadge status={kc.data.user.enabled ? 'active' : 'disabled'} /></span>
                      <span className="muted">Email verified</span><span>{kc.data.user.emailVerified ? 'Yes' : 'No'}</span>
                      <span className="muted">Authenticator app</span><span>{kc.data.user.totp ? 'Set up' : 'Not set up'}</span>
                      <span className="muted">Created</span><span>{kc.data.user.createdAt ? when(new Date(kc.data.user.createdAt).toISOString()) : '—'}</span>
                    </div></div>
                    <div className="table-wrap" style={{ marginTop: 12 }}><table className="dt"><thead><tr><th>Signed in at</th><th>Address</th><th>App</th><th>Last active</th></tr></thead>
                      <tbody>{kc.data.sessions.map((s: any) => <tr key={s.id}><td>{when(new Date(s.started).toISOString())}</td><td className="mono">{s.ip ?? '—'}</td><td>{s.clients.join(', ') || '—'}</td><td>{ago(new Date(s.lastAccess).toISOString())}</td></tr>)}
                        {!kc.data.sessions.length && <tr><td colSpan={4} className="dt-empty">No live Keycloak sessions.</td></tr>}</tbody></table></div>
                    <div className="table-wrap" style={{ marginTop: 12 }}><table className="dt"><thead><tr><th>When</th><th>Event</th><th>Address</th><th>App</th><th>Result</th></tr></thead>
                      <tbody>{kc.data.events.map((e: any, i: number) => <tr key={i}><td>{when(new Date(e.time).toISOString())}</td><td className="mono">{e.type.replace(/_/g, ' ').toLowerCase()}</td><td className="mono">{e.ip ?? '—'}</td><td>{e.client ?? '—'}</td><td>{e.error ? <StatusBadge status="failed">{e.error.replace(/_/g, ' ')}</StatusBadge> : <StatusBadge status="active">ok</StatusBadge>}</td></tr>)}
                        {!kc.data.events.length && <tr><td colSpan={5} className="dt-empty">No recent events.</td></tr>}</tbody></table></div>
                  </>)}
            </Section>)}
          {signIns?.ok && (
            <Section title="Sign-in history" count={signIns.data.sign_ins.length}>
              <div className="table-wrap"><table className="dt"><thead><tr><th>When</th><th>Through</th><th>App</th><th>Device</th><th>Address</th></tr></thead>
                <tbody>{signIns.data.sign_ins.map((e: any, i: number) => <tr key={i}><td>{when(e.created_at)}</td><td>{e.provider}</td><td>{e.client ?? '—'}</td><td>{[e.device_name, e.platform].filter(Boolean).join(' · ') || '—'}</td><td className="mono">{e.ip ?? '—'}</td></tr>)}
                  {!signIns.data.sign_ins.length && <tr><td colSpan={5} className="dt-empty">No sign-ins recorded yet. They are recorded from the moment people sign in through Keycloak.</td></tr>}</tbody></table></div>
            </Section>)}
          <Section title="Sign-in methods" count={detail.data.identities.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Provider</th><th>Email</th><th>Type</th><th>Linked</th><th>State</th></tr></thead>
              <tbody>{detail.data.identities.map((i: any, k: number) => <tr key={k}><td>{i.provider}</td><td>{i.email ?? '—'}</td><td>{i.purpose === 'sign_in' ? 'sign-in' : 'connected account'}</td><td>{when(i.created_at)}</td><td>{i.revoked_at ? <StatusBadge status="revoked" /> : <StatusBadge status="active" />}</td></tr>)}
                {!detail.data.identities.length && <tr><td colSpan={5} className="dt-empty">No linked providers (signs in with email and password).</td></tr>}</tbody></table></div>
          </Section>
          {auth?.ok ? (
            <>
              <Section title="Device sign-ins" count={auth.data.devices.length} actions={undefined}>
                <div className="table-wrap"><table className="dt"><thead><tr><th>Device</th><th>Platform</th><th>Signed in</th><th>Last used</th><th>Expires</th><th>State</th><th /></tr></thead>
                  <tbody>{auth.data.devices.map((d: any) => <tr key={d.id}><td>{d.device_name ?? '—'} <span className="faint mono">{d.id.slice(0, 12)}</span></td><td>{d.platform ?? '—'}</td><td>{when(d.created_at)}</td><td>{ago(d.last_used_at)}</td><td>{when(d.expires_at)}</td>
                    <td>{d.live ? <StatusBadge status="live" /> : <StatusBadge status="revoked">{d.revoked_at ? 'revoked' : 'expired'}</StatusBadge>}</td>
                    <td className="right">{d.live && can('users.write') ? <ConfirmForm action={revokeDevice} fields={{ id, token: d.id }} label="Sign out" title="Sign this device out?" body={`${d.device_name ?? 'This device'} will have to sign in again.`} confirmLabel="Sign out device" /> : null}</td></tr>)}
                    {!auth.data.devices.length && <tr><td colSpan={7} className="dt-empty">No desktop sign-ins.</td></tr>}</tbody></table></div>
              </Section>
              <Section title="Browser sessions" count={auth.data.browser.length} actions={can('users.write') && auth.data.browser.length ? <ConfirmForm action={revokeBrowserSessions} fields={{ id }} label="End all" title="End all browser sessions?" body="They will be asked to sign in again in the browser." confirmLabel="End all sessions" /> : undefined}>
                <div className="table-wrap"><table className="dt"><thead><tr><th>Started</th><th>Address</th><th>Browser</th><th>Expires</th><th /></tr></thead>
                  <tbody>{auth.data.browser.map((b: any) => <tr key={b.id}><td>{when(b.created_at)}</td><td className="mono">{b.ip_address ?? '—'}</td><td title={b.user_agent ?? ''}>{(b.user_agent ?? '—').slice(0, 60)}</td><td>{when(b.expires_at)}</td>
                    <td className="right">{can('users.write') ? <ConfirmForm action={revokeBrowserSessions} fields={{ id, session: b.id }} label="End" title="End this browser session?" body="That browser is signed out." confirmLabel="End session" /> : null}</td></tr>)}
                    {!auth.data.browser.length && <tr><td colSpan={5} className="dt-empty">No browser sessions.</td></tr>}</tbody></table></div>
              </Section>
            </>) : auth ? <ErrorState message={auth.error} /> : <Notice icon="alert">Your role cannot view sign-in sessions.</Notice>}
          <Section title="Registered devices" count={detail.data.devices.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Platform</th><th>App version</th><th>First seen</th><th>Last seen</th></tr></thead>
              <tbody>{detail.data.devices.map((d: any) => <tr key={d.id}><td>{d.name ?? '—'}</td><td>{d.platform ?? '—'}</td><td>{d.app_version ?? '—'}</td><td>{when(d.first_seen)}</td><td>{ago(d.last_seen)}</td></tr>)}
                {!detail.data.devices.length && <tr><td colSpan={5} className="dt-empty">No devices registered.</td></tr>}</tbody></table></div>
          </Section>
        </>)}

      {tab === 'sessions' && (sessions?.ok ? (
        <DataTable<any> base={`/admin/users/${id}`} query={{ tab: 'sessions' }} rowKey={(r) => r.id} rows={sessions.data.sessions} emptyTitle="No synced work sessions" emptyHint="Sessions appear here once this person's devices sync. Their contents stay encrypted."
          columns={[{ key: 'id', label: 'Session', render: (r) => <Link href={`/admin/sessions/${r.id}`} className="mono">{r.id.slice(0, 18)}</Link> }, { key: 'events', label: 'Events', align: 'right', render: (r) => num(r.events) }, { key: 'created', label: 'Started', render: (r) => when(r.created_at) }, { key: 'last', label: 'Last event', render: (r) => ago(r.last_event) }] as Column<any>[]} />
      ) : sessions ? <ErrorState message={sessions.error} /> : <Notice icon="alert">Your role cannot view sessions.</Notice>)}

      {tab === 'memories' && (mems?.ok ? (
        <Section title="Memories" count={(mems.data.memories as any[]).filter((r) => !r.deleted_at).length}>
          <div className="table-wrap"><table className="dt"><thead><tr><th>Type</th><th>Memory</th><th>Project</th><th>Last changed</th><th>State</th></tr></thead>
            <tbody>{(mems.data.memories as any[]).map((r) => <tr key={r.memory_id}><td>{r.kind ?? '—'}</td>
              <td style={{ whiteSpace: 'pre-wrap', maxWidth: 560 }}>{r.content ?? <span className="faint">{r.deleted_at ? 'forgotten' : 'no text synced yet'}</span>}</td>
              <td className="mono">{r.workspace_id ?? <span className="faint">personal</span>}</td><td>{ago(r.updated_at)}</td>
              <td>{r.deleted_at ? <StatusBadge status="revoked">forgotten</StatusBadge> : <StatusBadge status="active" />}</td></tr>)}
              {!mems.data.memories.length && <tr><td colSpan={5} className="dt-empty">No synced memories.</td></tr>}</tbody></table></div>
        </Section>
      ) : mems ? <ErrorState message={mems.error} /> : <Notice icon="alert">Your role cannot view memories.</Notice>)}

      {tab === 'runs' && (runs?.ok ? (
        runs.data.total === 0
          ? <div className="table-wrap"><EmptyState icon="runs" title="No agent runs shared">Run details reach this console only when the person turns on “share usage” in the app. Nothing is collected by default.</EmptyState></div>
          : <DataTable<any> base={`/admin/users/${id}`} query={{ tab: 'runs' }} rowKey={(r) => r.run_id} rows={runs.data.runs} emptyTitle="No runs"
              columns={[{ key: 'run', label: 'Run', render: (r) => <Link href={`/admin/runs/${r.run_id}`} className="mono">{r.run_id.slice(0, 18)}</Link> }, { key: 'agent', label: 'Agent', render: (r) => r.agent_id ?? '—' }, { key: 'state', label: 'State', render: (r) => <StatusBadge status={r.state} /> }, { key: 'started', label: 'Started', render: (r) => when(r.started_at) }, { key: 'tokens', label: 'Tokens', align: 'right', render: (r) => num(r.tokens_in + r.tokens_out) }] as Column<any>[]} />
      ) : runs ? <ErrorState message={runs.error} /> : <Notice icon="alert">Your role cannot view agent runs.</Notice>)}

      {tab === 'usage' && (credits?.ok ? (
        <>
          <div className="grid kpis">
            <MetricCard icon="billing" label="Paid credits" value={num(credits.data.paid)} /><MetricCard icon="gift" label="Promotional credits" value={num(credits.data.promo)} />
            <MetricCard icon="compute" label="Managed requests" value={num(credits.data.usage.requests)} hint={`${num(credits.data.usage.cost)} credits spent`} /><MetricCard icon="coupons" label="Plan" value={credits.data.plan_id} />
          </div>
          <Section title="Credit ledger" count={credits.data.ledger.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>When</th><th>Kind</th><th>Pool</th><th className="right">Amount</th><th>Why</th><th>By</th></tr></thead>
              <tbody>{credits.data.ledger.map((l: any) => <tr key={l.id}><td>{when(l.created_at)}</td><td>{l.kind}</td><td>{l.pool}</td><td className="num">{Number(l.amount) > 0 ? '+' : ''}{num(l.amount)}</td><td>{l.reason ?? l.coupon_code ?? ''}</td><td className="muted">{l.created_by ?? ''}</td></tr>)}
                {!credits.data.ledger.length && <tr><td colSpan={6} className="dt-empty">No credit movements.</td></tr>}</tbody></table></div>
          </Section>
        </>) : credits ? <ErrorState message={credits.error} /> : <Notice icon="alert">Your role cannot view credits.</Notice>)}

      {tab === 'support' && <div className="table-wrap"><EmptyState icon="support" title="No tickets or messages yet">Support tickets, messages sent to this person, and diagnostics they choose to share will be listed here once the Support and Communications modules are switched on.</EmptyState></div>}

      {tab === 'marketplace' && (mkt?.ok ? (
        <>
          <div className="grid kpis">
            <MetricCard icon="device" label="Installed" value={num((mkt.data.items as any[]).filter((i) => ['installed', 'configured', 'enabled', 'disabled', 'update_available'].includes(i.state)).length)} hint={`${num((mkt.data.items as any[]).length)} install records`} />
            <MetricCard icon="alert" label="Failed installs" value={num((mkt.data.items as any[]).filter((i) => i.state === 'failed').length)} />
            <MetricCard icon="gift" label="Favorites" value={num(mkt.data.favorites.length)} /><MetricCard icon="support" label="Reviews" value={num(mkt.data.reviews.length)} />
          </div>
          <Section title="Installed extensions" count={mkt.data.items.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Extension</th><th>Version</th><th>State</th><th>Enabled</th><th>Scan</th><th>Scope</th><th>Device</th><th>Installed</th><th>Last error</th></tr></thead>
              <tbody>{(mkt.data.items as any[]).map((i) => (
                <tr key={i.id}><td><Link className="mono" href={`/admin/marketplace/catalog?q=${encodeURIComponent(i.listingId)}`}>{i.listingId}</Link></td><td className="mono">{i.version ?? '—'}</td>
                  <td><StatusBadge status={['installed', 'enabled', 'configured'].includes(i.state) ? 'active' : i.state === 'failed' ? 'failed' : ''}>{String(i.state).replace(/_/g, ' ')}</StatusBadge></td><td>{i.enabled ? 'yes' : 'no'}</td>
                  <td>{i.scanVerdict === 'clean' ? 'clean' : i.scanVerdict === 'blocked' ? 'blocked' : i.scanVerdict ? 'not verified' : '—'}</td><td>{i.scope ?? '—'}</td><td className="mono">{i.deviceId ?? '—'}</td><td>{when(i.installedAt)}</td><td className="muted">{i.lastError ?? ''}</td></tr>))}
                {!mkt.data.items.length && <tr><td colSpan={9} className="dt-empty">This person has no marketplace installs.</td></tr>}</tbody></table></div>
          </Section>
          <Section title="Teams" count={mkt.data.teams.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Team id</th><th>Role</th></tr></thead>
              <tbody>{(mkt.data.teams as any[]).map((t) => <tr key={t.teamId}><td className="mono">{t.teamId}</td><td>{t.role}</td></tr>)}
                {!mkt.data.teams.length && <tr><td colSpan={2} className="dt-empty">Not a member of any marketplace team.</td></tr>}</tbody></table></div>
          </Section>
          <Section title="Favorites" count={mkt.data.favorites.length}>
            {mkt.data.favorites.length ? <ul>{(mkt.data.favorites as any[]).map((f) => <li key={f.listingId}><span className="mono">{f.listingId}</span> <span className="faint">{ago(f.createdAt)}</span></li>)}</ul> : <p className="hint">No favorites.</p>}
          </Section>
          <Section title="Reviews" count={mkt.data.reviews.length}>
            <div className="table-wrap"><table className="dt"><thead><tr><th>Listing</th><th>Stars</th><th>Review</th><th>When</th></tr></thead>
              <tbody>{(mkt.data.reviews as any[]).map((r) => <tr key={r.id}><td className="mono">{r.listingId}</td><td>{r.stars}</td><td>{r.body ?? <span className="faint">rating only</span>}</td><td>{ago(r.createdAt)}</td></tr>)}
                {!mkt.data.reviews.length && <tr><td colSpan={4} className="dt-empty">No reviews.</td></tr>}</tbody></table></div>
          </Section>
        </>) : mkt ? <ErrorState message={mkt.error} /> : <Notice icon="alert">Your role cannot view marketplace data.</Notice>)}

      {tab === 'audit' && (audit?.ok ? (
        audit.data.entries.length
          ? <Timeline items={audit.data.entries.map((e: any) => ({ at: e.at, title: <><span className="mono">{e.action.replace(/_/g, ' ')}</span> <span className="faint">by {e.admin_user_id}</span></>, detail: Object.keys(e.detail ?? {}).length ? <code>{JSON.stringify(e.detail)}</code> : undefined, tone: e.action === 'denied' ? 'bad' : undefined }))} />
          : <div className="table-wrap"><EmptyState title="Nothing recorded for this account yet" /></div>
      ) : audit ? <ErrorState message={audit.error} /> : <Notice icon="alert">Your role cannot read the audit log.</Notice>)}
    </>
  );
}
