import Link from 'next/link';
import { ValidationReport } from '../../../../components/admin/marketplace';
import { ErrorState, Flash, Notice, PageHeader, Section, StatusBadge } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { PACKAGE_HELP } from '../../../../lib/marketplace-agents';
import { LISTING_TYPES, PUBLISHABLE_TYPES, VISIBILITIES, summarizeValidation, unpackValidation } from '../../../../lib/marketplace';
import { adminContext } from '../../../../lib/session';
import { submitPackage } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Publish to the Marketplace' };

export default async function Publish({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const type = PUBLISHABLE_TYPES.includes(q.type) ? q.type : '';
  const pubs = type && permissions.includes('marketplace.write') ? await load<any>('/admin/marketplace/publishers', person.id) : null;
  const result = unpackValidation(q.vr);
  const summary = result ? summarizeValidation(result) : null;
  return (
    <>
      <PageHeader title="Publish New" subtitle="Upload a package ZIP. The server validates it; nothing is listed until a reviewer approves and publishes it." />
      <Flash q={q} />
      {!permissions.includes('marketplace.write') && <Notice tone="warn" icon="alert">Your role cannot submit packages (needs marketplace.write).</Notice>}
      {result && summary && (
        <Section title="Validation result">
          <ValidationReport report={result} title="Server validation" />
          {q.version ? <p className="hint">Recorded as version <Link className="mono" href={`/admin/marketplace/versions/${q.version}`}>{q.version}</Link> in state <b>{q.state}</b>. {summary.outcome === 'verified' ? 'It is waiting in the review queue.' : summary.outcome === 'unverified' ? 'It is in the queue but cannot be approved until a rescan verifies it.' : 'It was rejected automatically and will not enter the queue.'}</p>
            : <p className="hint">Nothing was recorded for this upload.</p>}
        </Section>)}
      <Section title="Step 1: what are you publishing?">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          {LISTING_TYPES.map((t) => PUBLISHABLE_TYPES.includes(t)
            ? <Link key={t} href={`/admin/marketplace/publish?type=${t}`} className="card" aria-current={type === t ? 'true' : undefined} style={{ padding: 14, outline: type === t ? '2px solid var(--accent, #4f46e5)' : undefined }}><b>{t}</b><div className="muted">Available</div></Link>
            : <div key={t} className="card" aria-disabled="true" style={{ padding: 14, opacity: 0.55 }}><b>{t}</b><div className="muted">Not available from this page</div></div>)}
        </div>
      </Section>
      {type && (
        <Section title={`Step 2: upload the ${type} package`}>
          {pubs && !pubs.ok ? <ErrorState message={pubs.error} /> : (
            <form action={submitPackage} className="form-row">
              <input type="hidden" name="type" value={type} />
              <label className="field"><span>Package (.zip)</span><input type="file" name="package" accept=".zip,application/zip" required /></label>
              <label className="field"><span>Publisher (existing only)</span>
                <select name="publisher" required defaultValue="">{<option value="" disabled>Choose a publisher</option>}{(pubs?.data.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.displayName} ({p.id}){p.verified ? ' ✓' : ''}</option>)}</select></label>
              <label className="field"><span>Visibility</span><select name="visibility" defaultValue="private">{VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
              <label className="field"><span>Team id (team visibility only)</span><input name="team" placeholder="team id" /></label>
              <button className="btn primary" disabled={!permissions.includes('marketplace.write')}>Upload and validate</button>
            </form>)}
          {pubs?.ok && !(pubs.data.items as any[]).length && <p className="hint">No publishers exist yet. A superadmin creates them under <Link href="/admin/marketplace/publishers">Publishers</Link>.</p>}
          <p className="hint">A {type} package contains: {PACKAGE_HELP[type] ?? 'see the package format reference.'}</p>
          <p className="hint">Maximum 64 MiB. The manifest id must start with the chosen publisher. Only roles with review permission can ask for public or org visibility; the server refuses it otherwise.</p>
          <p className="hint"><StatusBadge status="pending">note</StatusBadge> A result of “not verified” means a required check, such as the skill security scan, did not run. It is never shown as success.</p>
        </Section>)}
    </>
  );
}
