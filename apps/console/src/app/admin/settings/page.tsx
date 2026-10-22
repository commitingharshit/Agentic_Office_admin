import { Person, ErrorState, Flash, Notice, PageHeader, Section, StatusBadge, ago } from '../../../components/admin/bits';
import { adminMfaRequired } from '../../../lib/session';
import { load } from '../../../lib/admin-api';
import { adminContext } from '../../../lib/session';
import { addAdmin, revokeAdminInvite, setAdminRole } from '../actions';
import { keycloakMode } from '../../../lib/keycloak';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const admins = await load<any>('/admin/admins', person.id);
  const canWrite = permissions.includes('roles.write');
  const kc = keycloakMode();
  const mfa = kc ? process.env.KEYCLOAK_ADMIN_OTP === 'enforced' : adminMfaRequired();
  const issuer = (process.env.KEYCLOAK_ISSUER ?? '').replace(/\/+$/, '');
  const accountUrl = `${issuer}/account/#/security/signingin`;
  const ann = await load<any>('/admin/announcements', person.id);
  const inv = await load<any>('/admin/admin-invites', person.id);
  const pay = await load<any>('/admin/payments', person.id);
  const payOn = pay.ok && !!pay.data.provider;
  type Integration = { name: string; on: boolean; label?: string; steps: string[] };
  const integrations: Integration[] = [
    { name: 'Sign-in (Google, Microsoft, email)', on: true, label: kc ? 'Handled by Keycloak' : undefined, steps: [
      'Open the Keycloak console (tailnet only) and choose the agentic-office realm → Identity providers.',
      'Add Google or Microsoft. Keycloak shows the redirect address to paste into the Google Cloud or Microsoft Entra app.',
      'Paste the client ID and secret into Keycloak, never here, and save. The button shows on the sign-in page at once.'] },
    { name: 'Email delivery', on: ann.ok ? ann.data.channels.email.configured : false, steps: [
      'Create an API key with an email provider (Resend today) and verify the sending domain there.',
      'On the server, put RESEND_API_KEY and AO_MAIL_FROM in the API service environment file, mode 600.',
      'Recreate the API service. This row turns to connected; announcement emails are then sent and recorded.'] },
    { name: 'Payments (YouPI, experimental)', on: payOn, label: payOn ? 'Provider on' : undefined, steps: [
      'Get a sandbox merchant account from the payment provider first; test with that before any real money.',
      'Run deploy/scripts/enable-payments-youpi.sh in a terminal. It asks for the API address, merchant id and webhook secret without showing them and writes them to the server file, mode 600.',
      'It recreates the API. This row turns on; checkout then opens in the app, and a plan activates only after you settle the order on the Payments page.'] },
    { name: 'Managed AI models', on: false, label: 'Per plan', steps: [
      'Set the model provider key on the API service environment (never in this console).',
      'Choose which models each plan may use on Billing & Plans → the plan → Allowed models.'] },
  ];
  return (
    <>
      <PageHeader title="Settings" subtitle="Who can administer Agentic Office, and how the console is protected." />
      <Flash q={q} />
      <Section title="Administrators" count={admins.ok ? admins.data.admins.length : undefined}>
        {admins.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Person</th><th>Status</th><th>Last active</th><th>Admin role</th></tr></thead>
            <tbody>{(admins.data.admins as any[]).map((a) => (
              <tr key={a.id}><td><Person id={a.id} email={a.email} name={a.display_name} href={`/admin/users/${a.id}`} /></td><td><StatusBadge status={a.status} /></td><td>{ago(a.last_active_at)}</td>
                <td>{canWrite && a.id !== person.id ? (
                  <form action={setAdminRole} className="form-row"><input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value="/admin/settings" />
                    <select name="admin_role" defaultValue={a.admin_role} aria-label={`Role for ${a.email}`}>{(admins.data.roles as string[]).map((r) => <option key={r} value={r}>{r}</option>)}</select><button className="btn sm">Save</button></form>
                ) : <StatusBadge status="admin">{a.admin_role}</StatusBadge>}</td></tr>))}</tbody></table></div>
        ) : <ErrorState message={admins.error} />}
        {canWrite && (
          <form action={addAdmin} className="form-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <input name="email" type="email" required placeholder="their@email.com" aria-label="Email of the new administrator" style={{ minWidth: 260 }} />
            <select name="admin_role" defaultValue="support" aria-label="Admin role for the new administrator">{(admins.ok ? (admins.data.roles as string[]) : ['superadmin', 'engineer', 'support', 'finance', 'analyst']).map((r) => <option key={r} value={r}>{r}</option>)}</select>
            <button className="btn">Add administrator</button>
          </form>)}
        {inv.ok && inv.data.invites.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}><table className="dt"><thead><tr><th>Waiting to sign in</th><th>Role</th><th>Added</th><th /></tr></thead>
            <tbody>{(inv.data.invites as any[]).map((i) => (
              <tr key={i.email}><td>{i.email}</td><td><StatusBadge status="admin">{i.admin_role}</StatusBadge></td><td>{ago(i.created_at)}</td>
                <td className="right">{canWrite && <form action={revokeAdminInvite}><input type="hidden" name="email" value={i.email} /><button className="btn sm">Remove</button></form>}</td></tr>))}</tbody></table></div>)}
        <p className="hint">Superadmin can do everything. Engineer manages plans and devices; support manages users and sessions; finance manages credits, coupons and plans; analyst reads. Add someone above by email: if they already have an account they are promoted now, otherwise they become an administrator the first time they sign in with that verified email.</p>
      </Section>
      <Section title="Integrations">
        <div className="table-wrap"><table className="dt"><tbody>{integrations.map((i) => (
          <tr key={i.name}><td style={{ verticalAlign: 'top', width: '34%' }}>{i.name}</td>
            <td><details><summary className="muted">{i.on ? 'Connected.' : 'Not set up.'} How to connect</summary><ol style={{ lineHeight: 1.6, margin: '8px 0 0' }}>{i.steps.map((t) => <li key={t}>{t}</li>)}</ol></details></td>
            <td className="right" style={{ verticalAlign: 'top' }}><StatusBadge status={i.on ? 'active' : 'disabled'}>{i.on ? (i.label ?? 'connected') : 'not configured'}</StatusBadge></td></tr>))}</tbody></table></div>
        <p className="hint">Secrets are never typed into this console. They live in the server's environment files and in Keycloak, so a stolen console session cannot read them.</p>
      </Section>
      <Section title="Two-step verification (authenticator app)">
        <Notice tone={mfa ? 'ok' : 'warn'} icon={mfa ? 'check' : 'alert'}>{mfa ? 'Administrators must verify with an authenticator app before they can use this console.' : kc ? 'An authenticator app is available but not required for administrators yet. Set it up for your own account now; once every administrator has done so, set KEYCLOAK_ADMIN_OTP=enforced to remove this warning.' : 'Two-step verification is switched off for the console. Turn it on by setting ADMIN_REQUIRE_MFA=true.'}</Notice>
        {kc && (
          <ol style={{ lineHeight: 1.7, marginTop: 10 }}>
            <li>Open <a href={accountUrl} target="_blank" rel="noreferrer">your Keycloak security page</a> and sign in if asked.</li>
            <li>Open <b>Account security → Signing in</b>, then under <b>Authenticator application</b> choose <b>Set up</b>. Keycloak shows a <b>QR code</b>; that is the one to scan.</li>
            <li>Scan it with Google Authenticator, Microsoft Authenticator, 1Password or Authy. If you cannot scan, use “Unable to scan?” to type the key.</li>
            <li>Enter the 6-digit code it shows, give the device a name, and save. Keep the recovery codes if Keycloak offers them.</li>
          </ol>)}
        <p className="hint">Keycloak asks for the code at sign-in once an authenticator is registered. Enforcing it for the <b>admin</b> role is a Keycloak realm setting (a conditional OTP step in the browser flow), not something this page can switch.</p>
      </Section>
    </>
  );
}
