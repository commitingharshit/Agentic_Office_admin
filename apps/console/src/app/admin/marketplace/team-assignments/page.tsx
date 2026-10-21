import Link from 'next/link';
import { DataTable, FilterBar, type Column } from '../../../../components/admin/DataTable';
import { ErrorState, Flash, Notice, PageHeader, StatusBadge } from '../../../../components/admin/bits';
import { load } from '../../../../lib/admin-api';
import { listQuery } from '../../../../lib/marketplace';
import { assignmentRows, type AssignmentRow } from '../../../../lib/marketplace-agents';
import { adminContext } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Team Assignments' };

export default async function TeamAssignments({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  const { person } = await adminContext();
  const res = await load<any>(`/admin/marketplace/team-assignments${listQuery(q, { team: true, listing: true })}`, person.id);
  const rows = res.ok ? assignmentRows(res.data) : [];
  return (
    <>
      <PageHeader title="Team assignments" subtitle="What each team has pinned, read-only. Team owners and admins change assignments from the app; this page never does." />
      <Flash q={q} />
      <FilterBar base="/admin/marketplace/team-assignments" query={q} fields={[{ name: 'team', label: 'Team id', placeholder: 'team_…', width: 220 }, { name: 'listing', label: 'Listing', placeholder: 'publisher/slug', width: 220 }]} />
      {res.ok ? (
        <>
          {rows.some((r) => r.status === 'blocked') && <Notice tone="bad" icon="alert">At least one pinned version was revoked or quarantined. Members cannot install it, and an installed copy is disabled at its next sync.</Notice>}
          <DataTable<AssignmentRow> base="/admin/marketplace/team-assignments" query={q} rowKey={(r) => r.id} rows={rows} emptyTitle="No assignments" emptyHint="No team has assigned anything, or the filters exclude everything."
            columns={[
              { key: 'listing', label: 'Listing', render: (r) => <><b>{r.title}</b><div className="faint mono">{r.listingId}</div></> },
              { key: 'type', label: 'Type' },
              { key: 'team', label: 'Team', render: (r) => <Link className="mono" href={`/admin/marketplace/team-assignments?team=${encodeURIComponent(r.teamId)}`}>{r.teamId}</Link> },
              { key: 'mode', label: 'Mode' },
              { key: 'pin', label: 'Pinned to', render: (r) => <><span className="mono">{r.version}</span> <span className="faint mono">{r.sha}</span></> },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status === 'blocked' ? 'failed' : 'active'}>{r.statusText}</StatusBadge> },
            ] as Column<AssignmentRow>[]} />
          <p className="hint">Shown: the {rows.length} most recent assignments.</p>
        </>) : <ErrorState message={res.error} />}
    </>
  );
}
