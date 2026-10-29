'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { authClient } from '../../lib/auth-client';
import { HelpPanel } from './HelpPanel';
import { crumbLabel } from '../../lib/entities';
import { Icon } from './Icon';
import type { NavGroup } from './nav';

export interface ShellAdmin { email: string; name?: string | null; role: string }
const isId = (s: string) => /^[A-Za-z0-9_-]{16,}$/.test(s) || /^usr_/.test(s);

export function Shell({ nav, admin, mfaOff, healthy, alerts, helpOn, children }: { helpOn: boolean; alerts: Array<{ id: string; level: string; title: string; href: string; count: number }>; nav: NavGroup[]; admin: ShellAdmin; mfaOff: boolean; healthy: boolean | null; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const dlg = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { try { setCollapsed(localStorage.getItem('ao.sidebar') === '1'); } catch { /* storage may be blocked */ } }, []);
  const toggle = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('ao.sidebar', n ? '1' : '0'); } catch { /* ignore */ } return n; });

  const items = useMemo(() => nav.flatMap((g) => g.items.filter((i) => !i.external).map((i) => ({ ...i, group: g.label }))), [nav]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages = items.filter((i) => !q || i.label.toLowerCase().includes(q)).map((i) => ({ href: i.href, label: i.label, group: 'Go to', icon: i.icon }));
    const ask = q ? [{ href: '#help', label: `Ask the help assistant: “${query.trim()}”`, group: 'Help', icon: 'search' as const }] : [{ href: '#help', label: 'Ask the help assistant', group: 'Help', icon: 'search' as const }];
    const find = q ? [{ href: `/admin/users?q=${encodeURIComponent(query.trim())}`, label: `Find a user: “${query.trim()}”`, group: 'Search', icon: 'search' as const }] : [];
    // An id pasted from a log, a ticket or an email: open it as each kind of thing, or read its audit trail. No guessing which kind it is.
    const raw = query.trim();
    const e = encodeURIComponent(raw);
    const byId = /^[A-Za-z0-9_.:@-]{8,120}$/.test(raw) ? [
      ...(/^usr_/.test(raw) ? [{ href: `/admin/users/${e}`, label: `Open user ${raw}`, group: 'Open id', icon: 'user' as const }] : []),
      { href: `/admin/payments/${e}`, label: `Open payment ${raw}`, group: 'Open id', icon: 'billing' as const },
      { href: `/admin/runs/${e}`, label: `Open agent run ${raw}`, group: 'Open id', icon: 'runs' as const },
      { href: `/admin/sessions/${e}`, label: `Open session ${raw}`, group: 'Open id', icon: 'sessions' as const },
      { href: `/admin/support/${e}`, label: `Open ticket ${raw}`, group: 'Open id', icon: 'support' as const },
      { href: `/admin/marketplace/versions/${e}`, label: `Open marketplace version ${raw}`, group: 'Open id', icon: 'inbox' as const },
      { href: `/admin/audit?targetId=${e}`, label: `Audit trail for ${raw}`, group: 'Audit', icon: 'security' as const },
    ] : [];
    const trail = q && !byId.length ? [{ href: `/admin/audit?q=${encodeURIComponent(raw)}`, label: `Search the audit log for “${raw}”`, group: 'Audit', icon: 'security' as const }] : [];
    return [...ask, ...byId, ...find, ...trail, ...pages];
  }, [items, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      else if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (palette) { setQuery(''); setActive(0); dlg.current?.showModal(); } else dlg.current?.close(); }, [palette]);
  useEffect(() => { setMenu(false); setBell(false); setPalette(false); }, [path]);

  const crumbs = useMemo(() => {
    const segs = path.split('/').filter(Boolean).slice(1);
    const out: Array<{ href: string; label: string }> = [{ href: '/admin', label: 'Admin' }];
    let acc = '/admin';
    segs.forEach((s, n) => {
      acc += `/${s}`;
      const known = items.find((i) => i.href === acc);
      out.push({ href: acc, label: known?.label ?? (isId(s) ? crumbLabel(segs[n - 1], decodeURIComponent(s)) : s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())) });
    });
    return out;
  }, [path, items]);

  const current = (href: string) => (href === '/admin' || href === '/admin/marketplace' ? path === href : path === href || path.startsWith(`${href}/`));

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar" aria-label="Main navigation">
        <Link href="/admin" className="brand" aria-label="Agentic Office admin home"><img src="/agentic-office-icon.svg" alt="" /><span>Agentic Office <small>Admin</small></span></Link>
        <nav className="nav">
          {nav.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-label">{g.label}</span>
              {g.items.map((i) => i.external ? (
                <a key={i.href} href={i.href} target="_blank" rel="noopener noreferrer" className="nav-item" title={collapsed ? i.label : undefined}>
                  <Icon name={i.icon} /><span>{i.label}</span><span className="faint" aria-hidden="true">↗</span>
                </a>) : (
                <Link key={i.href} href={i.href} className="nav-item" aria-current={current(i.href) ? 'page' : undefined} title={collapsed ? i.label : undefined}>
                  <Icon name={i.icon} /><span>{i.label}</span>{i.soon && <span className="soon">soon</span>}
                </Link>))}
            </div>))}
        </nav>
        <div className="sidebar-foot"><button type="button" className="btn ghost sm" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={14} /><span>Collapse</span></button></div>
      </aside>

      <div className="main">
        <header className="topbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => <span key={c.href} style={{ display: 'contents' }}>{i > 0 && <span className="sep">/</span>}{i === crumbs.length - 1 ? <span className="here">{c.label}</span> : <Link href={c.href}>{c.label}</Link>}</span>)}
          </nav>
          <span className="grow" />
          <form className="search" action="/admin/users" method="get" role="search">
            <Icon name="search" size={14} />
            <input ref={searchRef} name="q" type="search" placeholder="Search users" aria-label="Search users" autoComplete="off" />
            <kbd>/</kbd>
          </form>
          <button type="button" className="btn ghost sm" onClick={() => setHelp(true)} aria-label="Open the help assistant">Help</button>
          <button type="button" className="btn ghost sm" onClick={() => setPalette(true)} aria-label="Open command palette">⌘K</button>
          <span className="health" title={healthy === null ? 'Health unknown' : healthy ? 'Admin API reachable' : 'Admin API not answering'}><i className={`dot ${healthy === null ? '' : healthy ? 'ok' : 'bad'}`} />{healthy === null ? 'unknown' : healthy ? 'Healthy' : 'Down'}</span>
          <div className="menu">
            <button type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={bell} aria-label={alerts.length ? `Notifications, ${alerts.length} need attention` : 'Notifications'} onClick={() => setBell((b) => !b)}>
              <Icon name="alert" size={14} />{alerts.length ? <b style={{ color: alerts.some((a) => a.level === 'action') ? 'var(--bad, #f48771)' : 'inherit' }}>{alerts.length}</b> : null}
            </button>
            {bell && (
              <div className="menu-panel" role="menu" style={{ minWidth: 320 }}>
                {alerts.length ? alerts.map((a) => <Link key={a.id} role="menuitem" href={a.href} style={{ display: 'block', padding: '8px 12px' }}>{a.title}</Link>) : <div className="who"><span>Nothing needs attention.</span></div>}
                <Link role="menuitem" href="/admin/notifications" style={{ display: 'block', padding: '8px 12px' }}>All notifications</Link>
              </div>)}
          </div>
          <div className="menu">
            <button type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Icon name="user" size={14} />{admin.name || admin.email.split('@')[0]}<Icon name="chevronDown" size={12} /></button>
            {menu && (
              <div className="menu-panel" role="menu">
                <div className="who"><b>{admin.email}</b><span>{admin.role}</span></div>
                <button role="menuitem" type="button" onClick={() => { const f = document.createElement('form'); f.method = 'POST'; f.action = '/admin/logout'; document.body.appendChild(f); f.submit(); }}><Icon name="signout" size={14} />Sign out</button>
              </div>)}
          </div>
        </header>
        {mfaOff && <div className="notice warn" role="alert" style={{ margin: '12px 28px 0' }}><Icon name="alert" /><div><b>Two-factor sign-in is not enforced</b> for administrators. Turn it on before real use (Keycloak's authenticator policy, or ADMIN_REQUIRE_MFA).</div></div>}
        <main className="content" id="content">{children}</main>
      </div>

      <HelpPanel open={help} onClose={() => setHelp(false)} enabled={helpOn} />
      <dialog ref={dlg} className="cmdk" onClose={() => setPalette(false)} aria-label="Command palette">
        <input autoFocus value={query} placeholder="Go to a page, or type to find a user…" aria-label="Command"
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && results[active]) { e.preventDefault(); if (results[active].href === '#help') { setPalette(false); setHelp(true); } else { router.push(results[active].href); setPalette(false); } }
          }} />
        <ul role="listbox">
          {results.map((r, i) => (
            <li key={r.href + r.label} role="option" aria-selected={i === active}>
              <Link href={r.href} data-active={i === active} onClick={(e) => { if (r.href === '#help') { e.preventDefault(); setPalette(false); setHelp(true); } else setPalette(false); }}><Icon name={r.icon} /><span>{r.label}</span><span className="faint" style={{ marginLeft: 'auto' }}>{r.group}</span></Link>
            </li>))}
          {!results.length && <li className="group">No matches</li>}
        </ul>
      </dialog>
    </div>
  );
}
