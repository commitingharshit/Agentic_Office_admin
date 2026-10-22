// Measures the help assistant's retrieval with the REAL embedding model and suggests AO_HELP_MIN_SCORE. Run it once after setting a provider
// (and again after the guide or the model changes):
//   AO_HELP_BASE_URL=https://api.openai.com/v1 AO_HELP_API_KEYS=... node evals/run-help-eval.ts [docs-dir]
// It embeds the guide in memory (no database), then for each question reports the best page and score. It never calls the chat model.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown } from '../src/help/chunk.ts';
import { cosine, listDocs } from '../src/help/kb.ts';
import { providerFromEnv } from '../src/help/provider.ts';

const dir = process.argv[2] ?? join(import.meta.dirname, '..', '..', '..', 'docs', 'admin-guide');
const provider = providerFromEnv(process.env);
if (!provider) { console.error('Set AO_HELP_BASE_URL and AO_HELP_API_KEYS (or AO_HELP_API_KEY) first.'); process.exit(2); }
const qs = JSON.parse(readFileSync(join(import.meta.dirname, 'help-questions.json'), 'utf8')) as { inScope: Array<{ q: string; route: string | null }>; outOfScope: string[] };
const chunks = listDocs(dir).flatMap((p) => chunkMarkdown(p, readFileSync(join(dir, p), 'utf8')));
const cv = await provider.embed(chunks.map((c) => `${c.heading}\n\n${c.body}`));
// A detail page (/admin/users/[id]) answers for its list page (/admin/users).
const on = (got: string | null, want: string | null) => !!want && !!got && (got === want || got.startsWith(`${want}/`));
const rank = async (q: string) => { const [v] = await provider.embed([q]); return chunks.map((c, i) => ({ c, s: cosine(v!, cv[i]!) })).sort((a, b) => b.s - a.s); };

let hit1 = 0, hit3 = 0, counted = 0;
const inScores: number[] = [], outScores: number[] = [];
for (const { q, route } of qs.inScope) {
  const r = await rank(q); inScores.push(r[0]!.s);
  if (route) { counted++; if (on(r[0]!.c.route, route)) hit1++; if (r.slice(0, 3).some((x) => on(x.c.route, route))) hit3++; }
  console.log(`${r[0]!.s.toFixed(3)}  ${route && on(r[0]!.c.route, route) ? 'ok  ' : route && r.slice(0, 3).some((x) => on(x.c.route, route)) ? 'top3' : route ? 'MISS' : '    '}  ${q}  ->  ${r[0]!.c.route ?? r[0]!.c.source}`);
}
for (const q of qs.outOfScope) { const r = await rank(q); outScores.push(r[0]!.s); console.log(`${r[0]!.s.toFixed(3)}  out   ${q}  ->  ${r[0]!.c.route ?? r[0]!.c.source}`); }
const lo = Math.min(...inScores), hi = Math.max(...outScores);
console.log(`\nchunks ${chunks.length}; hit@1 ${hit1}/${counted}, hit@3 ${hit3}/${counted}`);
console.log(`lowest in-scope score ${lo.toFixed(3)}, highest out-of-scope score ${hi.toFixed(3)}`);
if (lo > hi) console.log(`suggested AO_HELP_MIN_SCORE=${((lo + hi) / 2).toFixed(2)} (separates them with margin ${(lo - hi).toFixed(3)})`);
else console.log(`the scores overlap (in-scope min ${lo.toFixed(3)} <= out-of-scope max ${hi.toFixed(3)}): do not trust a threshold yet; improve the guide wording for the missed questions or try another embedding model`);
process.exit(hit1 / Math.max(1, counted) >= 0.7 && lo > hi ? 0 : 1);
