// Differential check: the template validator's OOXML verdict against an independent reference, OfficeCLI (`validate` and
// `view issues`), over the template eval corpus plus FUZZ_MUTATIONS (default 500) seeded mutations of the real templates.
//   gap     validator ACCEPTS, OfficeCLI cannot open the file          -> gate failure unless listed in known-gaps.json "template-differential"
//   review  validator REJECTS,  OfficeCLI opens it and validates it     -> reported; policy rejects (active content, names) are expected,
//                                                                         structural rejects are "stricter than OfficeCLI" and are listed
// The Rust kernels (docpatch/xlsx) are not used: they index a document for editing and have no accept/reject verdict to
// compare (see evals/README.md). Skips (exit 0, says so) when no officecli binary is installed.
// Run: node evals/run-template-differential.ts   (npm run eval:differential)   env: FUZZ_SEED, FUZZ_MUTATIONS, DIFF_CONCURRENCY
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, unpack } from '../src/marketplace/artifacts.ts';
import { here, judge } from './lib.ts';
import { cases, DOCX, PPTX, XLSX, pack } from './template-corpus.ts';
import { mutations, officecliBin, officecliVerdict, pool, type OfficeVerdict } from './template-differential.ts';

const bin = officecliBin();
if (!bin) { console.log('template differential: SKIPPED (no officecli binary found; set OFFICECLI_BIN)'); process.exit(0); }
const seed = Number(process.env.FUZZ_SEED ?? 1), count = Number(process.env.FUZZ_MUTATIONS ?? 500), conc = Number(process.env.DIFF_CONCURRENCY ?? 6);

interface Item { id: string; source: 'corpus' | 'mutation'; label: string; op: string; format: 'docx' | 'pptx' | 'xlsx'; file: Uint8Array; pkg: Uint8Array }
const items: Item[] = [];
for (const c of cases) {
  const pkg = await c.build();
  let up; try { up = unpack(pkg); } catch { continue; } // refused before any validator/renderer sees it (bombs, truncated outer zip)
  const p = up.manifest.payload as { format: string; file: string };
  if (p.format === 'pdf') continue;
  const file = up.files.get(p.file); if (!file) continue;
  items.push({ id: c.id, source: 'corpus', label: c.label, op: c.category, format: p.format as Item['format'], file, pkg });
}
for (const m of mutations({ docx: DOCX, pptx: PPTX, xlsx: XLSX }, count, seed)) items.push({ id: m.id, source: 'mutation', label: 'mutation', op: m.op, format: m.format, file: m.bytes, pkg: pack(m.format, m.bytes) });
if (items.length === 0) { console.error('template differential: empty corpus'); process.exit(1); }

const known = new Map<string, string>((JSON.parse(readFileSync(join(here, 'known-gaps.json'), 'utf8'))['template-differential'] ?? []).map((g: { id: string; reason: string }) => [g.id, g.reason]));
const rows = await pool(items, conc, async (it) => {
  const j = await judge('template', it.pkg);
  const o: OfficeVerdict = await officecliVerdict(bin, it.file, it.format);
  return { it, j, o };
});

const accepts = (r: typeof rows[number]) => r.j.verdict === 'accept';
const gaps = rows.filter((r) => accepts(r) && r.o.kind === 'cannot-open');
const softGaps = rows.filter((r) => accepts(r) && r.o.kind === 'invalid');
const errors = rows.filter((r) => r.o.kind === 'error');
const reviews = rows.filter((r) => !accepts(r) && r.o.kind === 'ok');
const policy = (r: typeof rows[number]) => r.j.failedChecks.some((c) => c === 'no-active-content' || c.startsWith('unpack:') || c === 'preview-images' || c === 'payload-shape');
const stricter = reviews.filter((r) => !policy(r));
const unexplained = gaps.filter((g) => !known.has(g.it.id));
const stale = [...known.keys()].filter((id) => !gaps.some((g) => g.it.id === id));

const mutRows = rows.filter((r) => r.it.source === 'mutation');
const line = (r: typeof rows[number]) => `${r.it.id}: validator ${r.j.verdict}${r.j.failedChecks.length ? ` [${r.j.failedChecks.join(',')}]` : ''}; officecli ${r.o.kind}${'detail' in r.o ? ` (${r.o.detail})` : ''}`;
const summary = {
  seed, mutations: count, corpusCases: items.length - count, total: rows.length, officecli_binary: 'officecli',
  validatorAccepts: rows.filter(accepts).length, validatorRejects: rows.filter((r) => !accepts(r)).length,
  officecli: { ok: rows.filter((r) => r.o.kind === 'ok').length, cannotOpen: rows.filter((r) => r.o.kind === 'cannot-open').length, invalid: rows.filter((r) => r.o.kind === 'invalid').length, error: errors.length },
  gaps: gaps.map(line), documentedGaps: gaps.filter((g) => known.has(g.it.id)).map((g) => `${line(g)} -- ${known.get(g.it.id)}`),
  acceptedButSchemaInvalid: softGaps.length, acceptedButSchemaInvalidExamples: softGaps.slice(0, 10).map(line),
  rejectedButOfficecliOk: reviews.length, rejectedForPolicy: reviews.length - stricter.length, stricterThanOfficecli: stricter.map(line),
  mutationsAcceptedByValidator: mutRows.filter(accepts).length, mutationsOfficecliCannotOpen: mutRows.filter((r) => r.o.kind === 'cannot-open').length,
  officecliErrors: errors.map(line), staleKnownGaps: stale,
};
mkdirSync(join(here, 'template-diff-corpus'), { recursive: true });
writeFileSync(join(here, 'template-diff-corpus', 'manifest.json'), JSON.stringify({ seed, mutations: count, note: 'Regenerate with FUZZ_SEED/FUZZ_MUTATIONS; mutations are pure functions of the seed and the committed templates.',
  items: rows.map((r) => ({ id: r.it.id, source: r.it.source, op: r.it.op, format: r.it.format, ...(r.it.source === 'mutation' ? { sha256: sha256Hex(r.it.file), size: r.it.file.length } : {}), validator: r.j.verdict, officecli: r.o.kind })) }, null, 1) + '\n');
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'template-differential.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, gaps: summary.gaps.length, stricterThanOfficecli: stricter.length, officecliErrors: errors.length, acceptedButSchemaInvalidExamples: undefined, documentedGaps: summary.documentedGaps.length }, null, 1));
for (const r of unexplained) console.error('GAP (validator accepts, officecli cannot open): ' + line(r));
if (errors.length > items.length * 0.05) { console.error(`too many officecli errors/timeouts (${errors.length}/${items.length}): reference unreliable`); process.exit(1); }
if (unexplained.length) { console.error(`DIFFERENTIAL FAILED: ${unexplained.length} undocumented gap(s)`); process.exit(1); }
console.log('DIFFERENTIAL PASSED');
