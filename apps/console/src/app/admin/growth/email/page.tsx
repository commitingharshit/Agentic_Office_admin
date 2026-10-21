import { ErrorState, Flash, Notice, PageHeader, Section, ago } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { adminContext } from '../../../../lib/session';
import { saveEmailTemplate } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Campaign email' };
const HTML = '<p>Hi {{name}},</p>\n<p>The Financial Modeling Toolkit is here: sources and uses, debt schedules and returns, checked for you.</p>\n<p><a href="https://agenticoffice.ai/toolkit">Explore the toolkit</a></p>\n<p style="font-size:12px;color:#888">You get this because you agreed to product email. <a href="{{unsubscribe_url}}">Unsubscribe</a>.</p>';
const TEXT = 'Hi {{name}},\n\nThe Financial Modeling Toolkit is here: https://agenticoffice.ai/toolkit\n\nUnsubscribe: {{unsubscribe_url}}';

export default async function Email({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person, permissions } = await adminContext();
  const res = await load<any>('/admin/growth/templates', person.id);
  const canWrite = permissions.includes('growth.write');
  return (
    <>
      <PageHeader title="Campaign email" subtitle="Templates for a campaign's email, sent through Resend to people who agreed to product email. Send one from its campaign's page." />
      <Flash q={q} />
      <Notice icon="info">Every template must contain <b>{'{{unsubscribe_url}}'}</b> in its HTML and its text; every message also carries one-click unsubscribe headers. The server refuses to send until a public address for the unsubscribe link (AO_PUBLIC_URL) and its key are set. Account, security and billing email never goes through here.</Notice>
      {canWrite && (
        <Section title="New template">
          <form action={saveEmailTemplate} style={{ display: 'grid', gap: 8 }}>
            <div className="form-row">
              <label className="field" style={{ flex: 1 }}><span>Name</span><input name="name" required maxLength={120} /></label>
              <label className="field" style={{ flex: 2 }}><span>Subject ({'{{name}}'} allowed)</span><input name="subject" required maxLength={200} defaultValue="{{name}}, meet the Financial Modeling Toolkit" /></label>
            </div>
            <label className="field"><span>HTML</span><textarea name="html" rows={8} className="mono" defaultValue={HTML} /></label>
            <label className="field"><span>Plain text</span><textarea name="text" rows={5} className="mono" defaultValue={TEXT} /></label>
            <button className="btn primary" style={{ justifySelf: 'start' }}>Save template</button>
          </form>
        </Section>)}
      <Section title="Templates" count={res.ok ? res.data.templates.length : undefined}>
        {res.ok ? (
          <div className="table-wrap"><table className="dt"><thead><tr><th>Name</th><th>Subject</th><th className="right">Version</th><th>Changed</th></tr></thead>
            <tbody>{(res.data.templates as any[]).map((t) => <tr key={t.id}><td>{t.name}</td><td>{t.subject}</td><td className="num">{t.version}</td><td>{ago(t.updated_at)}</td></tr>)}
              {!res.data.templates.length && <tr><td colSpan={4} className="dt-empty">No templates yet.</td></tr>}</tbody></table></div>
        ) : <ErrorState message={res.error} />}
      </Section>
    </>
  );
}
