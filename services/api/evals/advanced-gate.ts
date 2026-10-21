// Hostile-corpus gate for the six advanced types (Plan 3 Task 13). Each corpus builds packages; the REAL validateArtifact decides.
// Positive class = malicious; detected = any failed check. The gate must not pass vacuously: a size floor per type, a missing
// type fails, a validator crash is never counted as detection, and skipped cases are listed rather than counted as passed.
import { sha256Hex, unpack, UnpackError } from '../src/marketplace/artifacts.ts';
import type { ManifestV1, UnpackedPackage } from '../src/marketplace/types.ts';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import type { ListingType } from '../src/marketplace/types.ts';

export type AdvType = 'hook' | 'bridge' | 'connector' | 'routine' | 'memory' | 'workflow';
export interface AdvCase { id: string; label: 'benign' | 'malicious'; category: string; note: string; /** the check that should reject a malicious case, when the corpus records it */ catches?: string; build(): UnpackedPackage | Uint8Array | Promise<UnpackedPackage | Uint8Array> }
export interface Corpus { type: AdvType; benign: AdvCase[]; malicious: AdvCase[] }

/** Minimum benign + malicious cases per type; an emptied or thinned corpus fails the gate. */
export const MIN_CASES: Record<AdvType, number> = { hook: 14, bridge: 12, connector: 11, routine: 15, memory: 10, workflow: 13 };
export const TYPES = Object.keys(MIN_CASES) as AdvType[];

export interface CaseResult { type: AdvType; id: string; label: 'benign' | 'malicious'; category: string; verdict: 'accept' | 'reject' | 'crash'; failedChecks: string[]; knownGap?: string }
export interface TypeSummary { type: AdvType; benign: number; malicious: number; tp: number; fn: number; fp: number; tn: number; crashes: number; recall: number; precision: number; falsePositiveRate: number }
export interface GateResult { exitCode: 0 | 1; failures: string[]; notes: string[]; knownGapsOpen: string[]; perType: TypeSummary[]; results: CaseResult[] }

async function judge(type: AdvType, c: AdvCase): Promise<Pick<CaseResult, 'verdict' | 'failedChecks'>> {
  try {
    const built = await c.build();
    const pkg = built instanceof Uint8Array ? unpack(built) : built;
    const r = await validateArtifact(type as ListingType, pkg);
    const bad = r.checks.filter((k) => !k.ok);
    if (bad.some((k) => k.name === 'validator-error')) return { verdict: 'crash', failedChecks: bad.map((k) => k.name) };
    return { verdict: bad.length ? 'reject' : 'accept', failedChecks: bad.map((k) => k.name) };
  } catch (e) {
    // an UnpackError is a deliberate rejection of a malformed package; any other throw is a crash, not a detection
    if (e instanceof UnpackError) return { verdict: 'reject', failedChecks: [`unpack:${e.code}`] };
    return { verdict: 'crash', failedChecks: ['crash'] };
  }
}

export async function evaluateAdvancedGate(corpora: Corpus[], gaps: Map<string, string> = new Map()): Promise<GateResult> {
  const failures: string[] = [], notes: string[] = [];
  const results: CaseResult[] = [], perType: TypeSummary[] = [];
  for (const t of TYPES) if (!corpora.some((c) => c.type === t)) failures.push(`${t}: corpus missing`);
  for (const c of corpora) {
    const all = [...c.benign.map((x) => ({ ...x, label: 'benign' as const })), ...c.malicious.map((x) => ({ ...x, label: 'malicious' as const }))];
    if (all.length < (MIN_CASES[c.type] ?? 0)) failures.push(`${c.type}: ${all.length} cases is under the corpus size floor of ${MIN_CASES[c.type]}`);
    if (!c.malicious.length) failures.push(`${c.type}: no malicious cases (an empty class gates nothing)`);
    if (!c.benign.length) failures.push(`${c.type}: no benign cases (false positives are unmeasured)`);
    const own: CaseResult[] = [];
    for (const x of all) {
      const j = await judge(c.type, x);
      const gapEntry = gaps.get(`${c.type}/${x.id}`);
      const gap = x.label === 'malicious' ? gapEntry : undefined;   // a known gap is a malicious case accepted today; an entry naming a benign case is a mistake, reported below
      if (gapEntry && x.label === 'benign') notes.push(`${c.type}/${x.id}: known-gap entry names a benign case; remove it`);
      own.push({ type: c.type, id: x.id, label: x.label, category: x.category, ...j, ...(gap ? { knownGap: gap } : {}) });
      if (j.verdict === 'crash') failures.push(`${c.type}/${x.id}: validator crash is not detection (${x.label})`);
      else if (x.label === 'malicious' && j.verdict === 'accept' && !gap) failures.push(`${c.type}/${x.id}: malicious case accepted`);
      else if (x.label === 'benign' && j.verdict === 'reject') failures.push(`${c.type}/${x.id}: false positive, benign case rejected by ${j.failedChecks.join(', ')}`);
      else if (x.label === 'malicious' && j.verdict === 'reject' && gap) notes.push(`${c.type}/${x.id}: known gap is now detected; remove it from evals/known-gaps.json`);
      else if (x.label === 'malicious' && j.verdict === 'reject' && x.catches && !j.failedChecks.includes(x.catches)) failures.push(`${c.type}/${x.id}: rejected, but not by the intended check ${x.catches} (failed: ${j.failedChecks.join(', ')})`);
    }
    for (const g of gaps.keys()) if (g.startsWith(`${c.type}/`) && !all.some((x) => `${c.type}/${x.id}` === g)) notes.push(`${g}: known-gap entry names no case in the corpus`);
    results.push(...own);
    const mal = own.filter((o) => o.label === 'malicious'), ben = own.filter((o) => o.label === 'benign');
    const tp = mal.filter((o) => o.verdict === 'reject').length, fp = ben.filter((o) => o.verdict === 'reject').length;
    perType.push({ type: c.type, benign: ben.length, malicious: mal.length, tp, fn: mal.length - tp, fp, tn: ben.length - fp, crashes: own.filter((o) => o.verdict === 'crash').length,
      recall: mal.length ? tp / mal.length : 0, precision: tp + fp ? tp / (tp + fp) : 0, falsePositiveRate: ben.length ? fp / ben.length : 0 });
  }
  perType.sort((a, b) => a.type.localeCompare(b.type));
  const knownGapsOpen = results.filter((r) => r.knownGap && r.verdict === 'accept').map((r) => `${r.type}/${r.id}`);
  return { exitCode: failures.length ? 1 : 0, failures, notes, knownGapsOpen, perType, results };
}

// ---- adapters: the six corpora were written in different shapes; normalise to Corpus ----
const enc = (s: string) => new TextEncoder().encode(s);

export async function loadCorpora(): Promise<Corpus[]> {
  const hook = await import('./corpora/hook.ts');
  const memory = await import('./corpora/memory.ts');
  const workflow = await import('./corpora/workflow.ts');
  const bridge = await import('./corpora/bridge.ts');
  const connector = await import('./corpora/connector.ts');
  const routine = await import('./corpora/routine.ts');
  const out: Corpus[] = [];
  out.push({ type: 'hook', benign: hook.benign as AdvCase[], malicious: hook.malicious as AdvCase[] });
  out.push({ type: 'workflow', benign: workflow.benign as AdvCase[], malicious: workflow.malicious as AdvCase[] });
  const pkgCases = (cs: { id: string; category: string; note: string; build(): UnpackedPackage }[], label: 'benign' | 'malicious'): AdvCase[] => cs.map((c) => ({ ...c, label }));
  out.push({ type: 'memory', benign: pkgCases(memory.benign, 'benign'), malicious: pkgCases(memory.malicious, 'malicious') });
  const named = (cs: { name: string; fails: string; build: () => UnpackedPackage }[]): AdvCase[] => cs.map((c, i) => ({ id: `${String(i + 1).padStart(2, '0')}-${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}`, label: 'malicious', category: c.fails, note: c.name, catches: c.fails, build: c.build }));
  const urlCases: AdvCase[] = bridge.HOSTILE_URLS.map((u, i) => ({ id: `url-${String(i + 1).padStart(2, '0')}`, label: 'malicious', category: 'url-public-https', note: `server url ${JSON.stringify(u).slice(0, 60)}`, catches: 'url-public-https',
    build: () => { const p = bridge.BENIGN_PAYLOAD(); (p.server as Record<string, unknown>).url = u; return bridge.bridgePackage({ payload: p }); } }));
  out.push({ type: 'bridge', benign: [{ id: 'benign-search-issues', label: 'benign', category: 'benign', note: 'one read tool, one declared host, header auth', build: () => bridge.bridgePackage() }], malicious: [...named(bridge.HOSTILE), ...urlCases] });
  out.push({ type: 'connector', benign: [{ id: 'benign-api-key', label: 'benign', category: 'benign', note: 'api_key connector, host allowlist, secret field', build: () => connector.connectorPackage() }], malicious: named(connector.HOSTILE) });
  const routinePkg = (spec: import('./corpora/routine.ts').RoutinePkgSpec): UnpackedPackage => {
    const files = new Map(Object.entries(spec.files).map(([k, v]) => [k, enc(v)]));
    const manifest: ManifestV1 = { schema: 'agentic.marketplace/1', id: 'acme/weekly-summary', type: 'routine', version: '1.0.0', title: 'Weekly summary', summary: 'A routine.', license: 'MIT', compat: { app: '^1.0.0' },
      dependencies: spec.dependencies, permissions: spec.permissions, files: [...files].map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: spec.payload };
    return { files, manifest };
  };
  const rc = (c: import('./corpora/routine.ts').RoutineCase, i: number): AdvCase => ({ id: `${String(i + 1).padStart(2, '0')}-${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48)}`, label: c.expect === 'accept' ? 'benign' : 'malicious',
    category: c.fails?.[0] ?? c.expect, note: c.name, ...(c.fails?.length ? { catches: c.fails[0] } : {}),
    build: () => { const s = structuredClone(c.spec ? c.spec() : routine.baseRoutine()); c.mutate?.(s); return routinePkg(s); } });
  const all = routine.ROUTINE_CASES.map(rc);
  out.push({ type: 'routine', benign: all.filter((c) => c.label === 'benign'), malicious: all.filter((c) => c.label === 'malicious') });
  return out;
}
