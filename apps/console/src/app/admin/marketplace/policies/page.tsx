import { ErrorState, Flash, Notice, PageHeader, Section } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { policyToForm } from '../../../../lib/marketplace-agents';
import { adminContext } from '../../../../lib/session';
import { saveOrgPolicy } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Policies' };

export default async function Policies({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const canPolicy = permissions.includes('marketplace.policy');
  // The API refuses even a read of the policy document without marketplace.policy, so without it the page does not ask.
  const res = canPolicy ? await load<any>('/admin/marketplace/policies/org', person.id) : null;
  const f = policyToForm(res?.ok ? res.data : null);
  return (
    <>
      <PageHeader title="Install policy" subtitle="The organization-wide rules every install is checked against. Teams can add stricter rules; a deny anywhere wins." />
      <Flash q={q} />
      {!canPolicy && <Notice tone="warn" icon="alert">Your role cannot read or change the organization policy (needs marketplace.policy).</Notice>}
      {res && !res.ok && <ErrorState message={res.error} />}
      {res?.ok && res.data.configured === false && <Notice icon="info">No policy has been saved yet, so installs are unrestricted. Saving one takes effect on the next sync of each desktop.</Notice>}
      <Section title="Organization policy">
        <form action={saveOrgPolicy} className="form-row">
          <fieldset disabled={!canPolicy || (res ? !res.ok : false)} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
            <label className="field"><span>Mode</span>
              <select name="mode" defaultValue={f.mode}><option value="open">open: allowed unless a rule denies it</option><option value="allowlist">allowlist: denied unless a rule allows it</option></select></label>
            <label className="field"><span>Minimum publisher trust</span>
              <select name="minTrust" defaultValue={f.minTrust}><option value="">no minimum</option>{['private', 'community', 'verified', 'official'].map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            <label className="field"><span><input type="checkbox" name="requireCleanScan" defaultChecked={f.requireCleanScan} /> Require a clean security scan</span></label>
            <label className="field"><span>Rules, one per line: allow|deny listing|publisher|type value</span>
              <textarea name="rules" rows={8} defaultValue={f.rules} placeholder={'deny type hook\nallow publisher acme\ndeny listing acme/old-agent'} spellCheck={false} /></label>
            <button className="btn primary">Save policy</button>
          </fieldset>
        </form>
        <p className="hint">Every change is checked again by the API and recorded in the audit log with who made it. Allowed kinds: listing (publisher/slug), publisher (id), type (agent, bundle, skill, template, ...).</p>
      </Section>
    </>
  );
}
