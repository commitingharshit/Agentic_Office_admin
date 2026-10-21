import { Notice, PageHeader, Section, StatusBadge } from '../../../../components/admin/bits';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Marketplace Settings' };

export default async function MarketplaceSettings() {
  const { person, role, permissions } = await adminContext();
  const mine = permissions.filter((p) => p.startsWith('marketplace.'));
  const rows: Array<[string, React.ReactNode, string]> = [
    ['Your role', <StatusBadge key="r" status="admin">{role}</StatusBadge>, 'As the admin API reports it for you. The marketplace permissions below come from /admin/marketplace/me, the table the marketplace API itself enforces.'],
    ['Your marketplace permissions', mine.length ? mine.join(', ') : 'none', 'marketplace.read lists; write submits and deprecates; review claims, approves, rejects and publishes; moderate quarantines, revokes and deletes reviews.'],
    ['Roles source', 'Set on the API service', 'AO_MARKETPLACE_ROLES (adminName:role, comma separated) on accounts-sync. Without it every admin is read-only (analyst). The console cannot read this value.'],
    ['Skill security scanner', 'Not reported by the API', 'The API exposes no scanner status endpoint. When the scanner is down, skill submissions answer 503 scanner_unavailable and say so on the Publish page.'],
    ['OfficeCLI render check (templates)', 'Not reported by the API', 'When it is unavailable the template check is recorded as skipped and the version stays “not verified”.'],
  ];
  return (
    <>
      <PageHeader title="Settings" subtitle={`Effective marketplace configuration, read-only. Signed in as ${person.email}.`} />
      <Notice icon="info">Nothing here can be changed from the console. It shows only what the admin API tells this console; anything it does not expose is marked as such rather than guessed.</Notice>
      <Section title="Configuration">
        <div className="table-wrap"><table className="dt"><tbody>{rows.map(([k, v, hint]) => <tr key={k}><td>{k}</td><td>{v}</td><td className="muted">{hint}</td></tr>)}</tbody></table></div>
      </Section>
    </>
  );
}
