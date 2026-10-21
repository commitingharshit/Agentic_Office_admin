import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState } from './bits';
import { Icon } from './Icon';

export interface Column<T> { key: string; label: string; render?: (row: T) => ReactNode; sort?: string; align?: 'right'; }
type Query = Record<string, string | undefined>;
const href = (base: string, q: Query, patch: Query) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...patch })) if (v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
};

/** A server-rendered table: sort and page by links, so the browser never holds more than one page and back/forward just work. */
export function DataTable<T>({ columns, rows, base, query, emptyTitle = 'Nothing here yet', emptyHint, rowKey }: {
  columns: Column<T>[]; rows: T[]; base: string; query: Query; emptyTitle?: string; emptyHint?: ReactNode; rowKey: (row: T) => string;
}) {
  const sort = query.sort, dir = query.dir === 'asc' ? 'asc' : 'desc';
  if (!rows.length) return <div className="table-wrap"><EmptyState icon="inbox" title={emptyTitle}>{emptyHint}</EmptyState></div>;
  return (
    <div className="table-wrap">
      <table className="dt">
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.key} className={c.align === 'right' ? 'right' : undefined} aria-sort={c.sort && sort === c.sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              {c.sort ? <Link href={href(base, query, { sort: c.sort, dir: sort === c.sort && dir === 'desc' ? 'asc' : 'desc', page: undefined })}>{c.label}{sort === c.sort && <Icon name={dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} />}</Link> : c.label}
            </th>))}</tr>
        </thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)}>{columns.map((c) => <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Pager({ base, query, page, pageSize, total }: { base: string; query: Query; page: number; pageSize: number; total: number }) {
  const from = total ? page * pageSize + 1 : 0, to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span>{total ? `${from}–${to} of ${total.toLocaleString('en-US')}` : 'No results'}</span>
      <span className="btns">
        {page > 0 ? <Link className="btn sm" href={href(base, query, { page: String(page - 1) })}><Icon name="chevronLeft" size={14} />Previous</Link> : <span className="btn sm" aria-disabled="true"><Icon name="chevronLeft" size={14} />Previous</span>}
        {to < total ? <Link className="btn sm" href={href(base, query, { page: String(page + 1) })}>Next<Icon name="chevronRight" size={14} /></Link> : <span className="btn sm" aria-disabled="true">Next<Icon name="chevronRight" size={14} /></span>}
      </span>
    </div>
  );
}

export interface FilterField { name: string; label: string; type?: 'text' | 'select' | 'date'; options?: Array<[string, string]>; placeholder?: string; width?: number }
/** A plain GET form: filters live in the address, so a filtered view can be bookmarked and shared. */
export function FilterBar({ base, query, fields, keep = [] }: { base: string; query: Query; fields: FilterField[]; keep?: string[] }) {
  const active = fields.some((f) => query[f.name]);
  return (
    <form className="form-row" method="get" action={base} style={{ marginBottom: 14 }}>
      {keep.map((k) => query[k] ? <input key={k} type="hidden" name={k} defaultValue={query[k]} /> : null)}
      {fields.map((f) => (
        <label key={f.name} className="field">
          <span>{f.label}</span>
          {f.type === 'select'
            ? <select name={f.name} defaultValue={query[f.name] ?? ''}>{(f.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            : <input name={f.name} type={f.type === 'date' ? 'date' : 'search'} defaultValue={query[f.name] ?? ''} placeholder={f.placeholder} style={{ width: f.width ?? 220 }} />}
        </label>))}
      <button className="btn primary">Apply</button>
      {active && <Link className="btn ghost" href={base}>Clear</Link>}
    </form>
  );
}

export function Tabs({ base, current, tabs, param = 'tab' }: { base: string; current: string; tabs: Array<{ key: string; label: string; count?: number }>; param?: string }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {tabs.map((t) => <Link key={t.key} className="tab" href={t.key === tabs[0].key ? base : `${base}?${param}=${t.key}`} aria-current={current === t.key ? 'page' : undefined}>{t.label}{t.count !== undefined && <span className="faint"> {t.count}</span>}</Link>)}
    </nav>
  );
}
