import Link from 'next/link';
import { load } from '../../lib/admin-api';
import { ENTITY_LABEL, entityHref, trailHref } from '../../lib/entities';
import { adminContext } from '../../lib/session';
import { Section } from './bits';
import { Timeline } from './Feed';

type Row = { id: number; admin_user_id: string; admin_email: string | null; action: string; detail: Record<string, unknown>; at: string };

/** The last administrator actions on one thing, with a link to its full audit trail. Shows nothing to an admin who may not read the audit log. */
export async function EntityHistory({ type, id, title = 'History' }: { type: string; id: string; title?: string }) {
  const { person, permissions } = await adminContext();
  if (!permissions.includes('audit.read')) return null;
  const r = await load<{ entries: Row[]; total: number }>(`/admin/audit?targetType=${encodeURIComponent(type)}&targetId=${encodeURIComponent(id)}&pageSize=10`, person.id);
  if (!r.ok) return <Section title={title}><p className="faint">The history could not be loaded: {r.error}</p></Section>;
  const shown = r.data.entries.filter((e) => !/^(view_|list_)/.test(e.action));
  return (
    <Section title={title} count={r.data.total} actions={<Link href={trailHref(type, id)}>Full audit trail</Link>}>
      {shown.length === 0
        ? <p className="faint">No administrator has changed this {ENTITY_LABEL[type]?.toLowerCase() ?? 'item'} yet.</p>
        : <Timeline items={shown.map((e) => ({
            at: e.at,
            title: e.action.replace(/^marketplace\./, '').replace(/_/g, ' '),
            detail: <>by <Link href={entityHref('user', e.admin_user_id) ?? '#'}>{e.admin_email ?? e.admin_user_id}</Link></>,
          }))} />}
    </Section>
  );
}
