import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

const TONES: Record<string, string> = {
  active: 'ok', succeeded: 'ok', live: 'ok', ok: 'ok', settled: 'ok', paid: 'ok', enabled: 'ok',
  disabled: 'bad', deleted: 'bad', failed: 'bad', revoked: 'bad', expired: 'warn', cancelled: 'warn', past_due: 'warn', degraded: 'warn', unavailable: 'bad',
  running: 'info', open: 'info', pending: 'info', admin: 'accent', superadmin: 'accent', free: '', beta: 'accent',
};
export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge ${TONES[status] ?? ''}`.trim()}>{children ?? status}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Section({ title, count, children, actions }: { title: string; count?: number; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}{count !== undefined && <span className="count">{count}</span>}{actions && <span style={{ marginLeft: 'auto' }}>{actions}</span>}</h2>
      {children}
    </section>
  );
}

export function EmptyState({ icon = 'inbox', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="ico"><Icon name={icon} size={20} /></div><h3>{title}</h3>{children && <div className="empty-body">{children}</div>}{action}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="notice bad" role="alert"><Icon name="alert" /><div><b>This could not be loaded.</b> {message}</div></div>;
}

export function Notice({ tone = '', icon = 'info', children }: { tone?: 'warn' | 'bad' | 'ok' | ''; icon?: IconName; children: ReactNode }) {
  return <div className={`notice ${tone}`.trim()}><Icon name={icon} /><div>{children}</div></div>;
}

export function Skeleton({ w = '100%', h = 14 }: { w?: string | number; h?: number }) { return <div className="skeleton" style={{ width: w, height: h }} />; }

export function Flash({ q }: { q: Record<string, string | undefined> }) {
  if (q.err) return <div className="msg err" role="alert">{q.err}</div>;
  if (q.msg) return <div className="msg ok" role="status">{q.msg}</div>;
  return null;
}

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export function Avatar({ name, seed }: { name: string; seed: string }) {
  return <span className="avatar" style={{ background: `hsl(${hue(seed)} 38% 42%)` }} aria-hidden="true">{(name || '?').trim().charAt(0).toUpperCase()}</span>;
}
export function Person({ id, email, name, href }: { id: string; email?: string | null; name?: string | null; href?: string }) {
  const label = email ?? id;
  const inner = <><Avatar name={name || label} seed={email ?? id} /><span className="who"><b>{label}</b>{name && <span>{name}</span>}</span></>;
  return <span className="person">{href ? <Link href={href} style={{ display: 'contents' }}>{inner}</Link> : inner}</span>;
}

export const ago = (v: string | Date | null | undefined) => {
  if (!v) return '—';
  const t = +new Date(v), s = Math.round((Date.now() - t) / 1000);
  if (!Number.isFinite(t)) return '—';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
export const when = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const num = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString('en-US');
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
