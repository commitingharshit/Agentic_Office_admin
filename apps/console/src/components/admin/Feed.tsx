import type { ReactNode } from 'react';
import { ago } from './bits';
import { Icon, type IconName } from './Icon';

const KIND: Record<string, IconName> = { admin: 'security', signup: 'user', credits: 'billing', coupon: 'coupons' };
export function ActivityFeed({ events }: { events: Array<{ at: string; kind: string; label: string; actor: string | null; target: string | null }> }) {
  return (
    <ul className="feed">
      {events.map((e, i) => (
        <li key={i}>
          <span className="ico"><Icon name={KIND[e.kind] ?? 'info'} size={14} /></span>
          <span><b style={{ fontWeight: 500 }}>{e.label.replace(/_/g, ' ')}</b>{e.target && <span className="faint mono"> · {e.target.slice(0, 18)}</span>}</span>
          <span className="t" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
        </li>))}
    </ul>
  );
}

export function Timeline({ items }: { items: Array<{ at?: string | null; title: ReactNode; detail?: ReactNode; tone?: 'ok' | 'bad' }> }) {
  return <ol className="timeline">{items.map((it, i) => <li key={i} className={it.tone}><div><b style={{ fontWeight: 500 }}>{it.title}</b>{it.at && <span className="faint"> · {new Date(it.at).toLocaleString('en-GB')}</span>}</div>{it.detail && <div className="muted">{it.detail}</div>}</li>)}</ol>;
}
