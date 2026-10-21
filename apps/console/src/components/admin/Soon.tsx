import { EmptyState, Notice, PageHeader } from './bits';
import type { IconName } from './Icon';

/** A module that is planned but not built. It says what it will show and what it is waiting for; it never shows invented numbers. */
export function Soon({ title, icon, summary, needs }: { title: string; icon: IconName; summary: string; needs: string[] }) {
  return (
    <>
      <PageHeader title={title} subtitle={summary} />
      <div className="table-wrap">
        <EmptyState icon={icon} title="Not available yet">
          <div style={{ maxWidth: 520 }}>This module has no data source today, so it shows nothing rather than made-up figures. It needs:</div>
          <ul style={{ textAlign: 'left', margin: '8px auto 0', maxWidth: 520 }}>{needs.map((n) => <li key={n}>{n}</li>)}</ul>
        </EmptyState>
      </div>
      <Notice icon="info">Usage details reach this console only with a person's consent (off by default), so pages like this will state how many people share, out of how many.</Notice>
    </>
  );
}
