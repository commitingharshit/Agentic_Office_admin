// The knowledge base: index the documentation folder into help_chunks (embedding only what changed) and search it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type pg from 'pg';
import { chunkMarkdown, type Chunk } from './chunk.ts';

export interface Embedder { readonly embedModel: string; embed(texts: string[]): Promise<number[][]> }
export interface Hit { id: string; source: string; heading: string; route: string | null; body: string; score: number }

/** Every .md file under dir (not COVERAGE.md), as docs-relative paths with forward slashes. Hidden folders and node_modules are skipped. */
export function listDocs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.') || n === 'node_modules' || n === 'COVERAGE.md') continue;   // COVERAGE.md is the writers' checklist, not an answer
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.md')) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface IndexReport { pages: number; chunks: number; embedded: number; removed: number; withoutRoute: string[] }

/** Brings help_chunks in line with the folder. Unchanged chunks keep their stored embedding; a changed model re-embeds all. */
export async function indexDocs(admin: Pick<pg.Pool, 'query'>, dir: string, embedder: Embedder): Promise<IndexReport> {
  const pages = listDocs(dir);
  const chunks: Chunk[] = pages.flatMap((p) => chunkMarkdown(p, readFileSync(join(dir, p), 'utf8')));
  const have = new Map((await admin.query('SELECT id, content_hash, model FROM help_chunks')).rows.map((r: { id: string; content_hash: string; model: string }) => [r.id, r]));
  const todo = chunks.filter((c) => { const h = have.get(c.id); return !h || h.content_hash !== c.hash || h.model !== embedder.embedModel; });
  const vectors = todo.length ? await embedder.embed(todo.map((c) => `${c.heading}\n\n${c.body}`)) : [];
  if (vectors.length !== todo.length) throw new Error('embedder returned the wrong number of vectors');
  todo.forEach((c, i) => { if (!vectors[i]!.length || !vectors[i]!.every(Number.isFinite)) throw new Error(`bad embedding for ${c.id}`); });
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i]!;
    await admin.query(
      `INSERT INTO help_chunks(id, source, heading, route, body, content_hash, model, embedding) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET source=EXCLUDED.source, heading=EXCLUDED.heading, route=EXCLUDED.route, body=EXCLUDED.body, content_hash=EXCLUDED.content_hash, model=EXCLUDED.model, embedding=EXCLUDED.embedding, indexed_at=now()`,
      [c.id, c.source, c.heading, c.route, c.body, c.hash, embedder.embedModel, vectors[i]]);
  }
  const keep = new Set(chunks.map((c) => c.id));
  const gone = [...have.keys()].filter((id) => !keep.has(id));
  if (gone.length) await admin.query('DELETE FROM help_chunks WHERE id = ANY($1)', [gone]);
  const routed = new Set(chunks.filter((c) => c.route).map((c) => c.source));
  return { pages: pages.length, chunks: chunks.length, embedded: todo.length, removed: gone.length, withoutRoute: pages.filter((p) => !routed.has(p) && !p.startsWith('okf/') && !p.startsWith('plans/')) };
}

export class Index {
  private cache: Array<Hit & { v: number[]; model: string }> | null = null;
  private readonly ro: Pick<pg.Pool, 'query'>;
  constructor(ro: Pick<pg.Pool, 'query'>) { this.ro = ro; }
  invalidate(): void { this.cache = null; }
  async size(): Promise<number> { return (await this.load()).length; }
  private async load() {
    if (!this.cache) this.cache = (await this.ro.query('SELECT id, source, heading, route, body, model, embedding FROM help_chunks')).rows.map((r: any) => ({ id: r.id, source: r.source, heading: r.heading, route: r.route, body: r.body, score: 0, v: r.embedding as number[], model: r.model as string }));
    return this.cache;
  }
  /** The k chunks closest to the question vector, best first. Chunks embedded with another model are ignored. */
  async search(vector: number[], model: string, k = 5): Promise<Hit[]> {
    return (await this.load()).filter((c) => c.model === model && c.v.length === vector.length)
      .map((c) => ({ id: c.id, source: c.source, heading: c.heading, route: c.route, body: c.body, score: cosine(vector, c.v) }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  }
}
