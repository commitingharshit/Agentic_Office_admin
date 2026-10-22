// Splits a documentation page (markdown) into chunks by heading, each carrying the heading trail so the text stands alone.
// A page may start with front matter `route: /admin/coupons`, the console page it describes; chunks inherit it. A section may name its own
// page with a line `Page: /admin/coupons` (group files describe several pages); that route wins for the section.
import { createHash } from 'node:crypto';

export interface Chunk { id: string; source: string; heading: string; route: string | null; body: string; hash: string }

export const MAX_CHUNK_CHARS = 2400;
const ROUTE_RE = /^\/admin(\/[A-Za-z0-9._\[\]-]+)*$/;

export function parseFrontMatter(md: string): { meta: Record<string, string>; text: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta: {}, text: md };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) { const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, ''); }
  return { meta, text: md.slice(m[0].length) };
}

export function chunkMarkdown(source: string, md: string): Chunk[] {
  const { meta, text } = parseFrontMatter(md);
  const route = meta['route'] && ROUTE_RE.test(meta['route']) ? meta['route'] : null;
  const title = meta['title'] ?? source;
  const trail: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: title, lines: [] }];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      trail.length = level - 1;
      trail[level - 1] = h[2]!;
      sections.push({ heading: [title, ...trail.filter(Boolean)].join(' › '), lines: [] });
    } else sections[sections.length - 1]!.lines.push(line);
  }
  const out: Chunk[] = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (body.length < 20) continue;
    const own = /^Page:\s*(\/admin\S*)\s*$/m.exec(body)?.[1];
    const secRoute = own && ROUTE_RE.test(own) ? own : route;
    // A long section is split on paragraph boundaries; no chunk is cut mid-word.
    const parts: string[] = [];
    let cur = '';
    for (const para of body.split(/\n{2,}/)) {
      if (cur && cur.length + para.length + 2 > MAX_CHUNK_CHARS) { parts.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${para}` : para;
      while (cur.length > MAX_CHUNK_CHARS) { const cut = cur.lastIndexOf(' ', MAX_CHUNK_CHARS); parts.push(cur.slice(0, cut > 0 ? cut : MAX_CHUNK_CHARS)); cur = cur.slice(cut > 0 ? cut + 1 : MAX_CHUNK_CHARS); }
    }
    if (cur.trim()) parts.push(cur);
    for (const p of parts) {
      const id = `${source}#${out.length}`;
      out.push({ id, source, heading: s.heading.slice(0, 300), route: secRoute, body: p, hash: createHash('sha256').update(`${source}\0${s.heading}\0${secRoute ?? ''}\0${p}`).digest('hex') });
    }
  }
  return out;
}
