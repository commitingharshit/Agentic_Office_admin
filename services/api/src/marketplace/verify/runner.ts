// Runs a pipeline: sequential, each stage under its own deadline, exceptions and malformed output become `fail`
// (never a silent pass, never a crash), a stage whose prerequisite failed or skipped is `skipped` with a reason,
// and the result is size-capped and deterministically serialisable.
import { sha256Hex } from '../artifacts.ts';
import type { ListingType, UnpackedPackage } from '../types.ts';
import { EvidenceLimitError, limitedSink, type LimitedSink } from './evidence.ts';
import { assertStageResult, getPipeline } from './registry.ts';
import {
  MAX_EVIDENCE_DETAIL, MAX_EVIDENCE_PER_STAGE, MAX_LABEL, MAX_REASON, MAX_RESULT_BYTES,
  type Evidence, type EvidenceSink, type PipelineDef, type PipelineResult, type PipelineTools, type StageDef, type StageOutput, type StageResult, type Verdict,
} from './types.ts';

export function deriveVerdict(stages: StageResult[]): Verdict {
  if (stages.some(s => s.status === 'fail')) return 'fail';
  if (stages.some(s => s.status === 'skipped' && s.required)) return 'incomplete';
  return 'pass';
}

const clip = (s: unknown, n: number): string => { const t = typeof s === 'string' ? s : String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const msg = (e: unknown): string => clip(e instanceof Error ? e.message : String(e), 300);
const BLOB_MIMES = new Set(['image/png', 'text/plain', 'application/json']);
const EV_KINDS = new Set(['check', 'text', 'json', 'image', 'log']);
const SHA = /^[0-9a-f]{64}$/;

/** Copies only known fields, clamps sizes, drops malformed entries. Returns undefined if the whole output is unusable. */
function normaliseEvidence(raw: unknown): { evidence: Evidence[]; dropped: number } {
  const out: Evidence[] = []; let dropped = 0;
  if (!Array.isArray(raw)) return { evidence: out, dropped: raw === undefined ? 0 : 1 };
  for (const e of raw) {
    if (out.length >= MAX_EVIDENCE_PER_STAGE) { dropped++; continue; }
    if (!e || typeof e !== 'object' || !EV_KINDS.has((e as Evidence).kind) || typeof (e as Evidence).label !== 'string') { dropped++; continue; }
    const x = e as Evidence, ev: Evidence = { kind: x.kind, label: clip(x.label, MAX_LABEL) };
    if (typeof x.detail === 'string') ev.detail = clip(x.detail, MAX_EVIDENCE_DETAIL);
    if (x.blob && BLOB_MIMES.has(x.blob.mime) && SHA.test(x.blob.sha256) && Number.isFinite(x.blob.size)) ev.blob = { sha256: x.blob.sha256, mime: x.blob.mime, size: x.blob.size };
    const m = x.measured;
    if (m && typeof m.name === 'string' && Number.isFinite(m.value) && Number.isFinite(m.threshold) && ['>=', '<=', '=='].includes(m.op)) ev.measured = { name: clip(m.name, MAX_LABEL), value: m.value, threshold: m.threshold, op: m.op };
    out.push(ev);
  }
  return { evidence: out, dropped };
}

async function runStage(def: StageDef, ctx: { pkg: UnpackedPackage; tools: PipelineTools; evidence: LimitedSink; previous?: PipelineResult }): Promise<StageResult> {
  const base = { id: def.id, title: def.title, required: def.required };
  const t0 = Date.now();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(res => { timer = setTimeout(() => { res('timeout'); ac.abort(); }, def.timeoutMs); });
  ctx.evidence.resetTruncated();
  let r: StageResult;
  try {
    // Promise.race so a stage that ignores its signal still cannot hang the run.
    const run = Promise.resolve().then(() => def.run({ pkg: ctx.pkg, tools: ctx.tools, evidence: ctx.evidence, signal: ac.signal, previous: ctx.previous }));
    run.catch(() => { /* a late rejection after timeout must not become an unhandled rejection */ });
    const out = await Promise.race([run, timeout]);
    if (out === 'timeout') {
      r = { ...base, status: 'fail', reason: 'timeout', evidence: [{ kind: 'check', label: 'stage timed out', detail: `no result within ${def.timeoutMs} ms` }], durationMs: 0 };
    } else {
      r = shape(base, out);
    }
  } catch (e) {
    r = { ...base, status: 'fail', reason: clip(`stage-error: ${msg(e)}`, MAX_REASON), evidence: [], durationMs: 0 };
  } finally { clearTimeout(timer); }
  if (ctx.evidence.truncated) r.evidence.push({ kind: 'text', label: 'evidence truncated', detail: 'evidence limits reached; some blobs were not stored' });
  r.durationMs = Date.now() - t0;
  try { assertStageResult(r); }
  catch (e) { r = { ...base, status: 'fail', reason: clip(`stage-error: ${msg(e)}`, MAX_REASON), evidence: [], durationMs: r.durationMs }; }
  return r;
}

function shape(base: { id: string; title: string; required: boolean }, out: StageOutput): StageResult {
  const bad = (why: string): StageResult => ({ ...base, status: 'fail', reason: `stage-error: ${why}`, evidence: [], durationMs: 0 });
  if (!out || typeof out !== 'object') return bad('stage returned no result');
  if (out.status !== 'pass' && out.status !== 'fail' && out.status !== 'skipped') return bad(`invalid status ${JSON.stringify(String(out.status))}`);
  const { evidence, dropped } = normaliseEvidence(out.evidence);
  if (dropped) evidence.push({ kind: 'text', label: 'evidence truncated', detail: `${dropped} evidence item(s) were malformed or over the per-stage cap` });
  const r: StageResult = { ...base, status: out.status, evidence, durationMs: 0 };
  if (out.required === false) r.required = false;
  if (out.status !== 'pass') {
    if (typeof out.reason !== 'string' || !out.reason) return bad(`${out.status} without a reason`);
    r.reason = clip(out.reason, MAX_REASON);
  } else if (typeof out.reason === 'string' && out.reason) r.reason = clip(out.reason, MAX_REASON);
  return r;
}

function failedPipeline(type: ListingType, subject: string, reason: string, now: () => Date, env: Record<string, string>): PipelineResult {
  const at = now().toISOString();
  return { type, pipeline: 'none', pipelineVersion: 0, subjectSha256: subject, verdict: 'fail', env, startedAt: at, finishedAt: at,
    stages: [{ id: 'type-supported', title: 'type-supported', required: true, status: 'fail', reason, evidence: [], durationMs: 0 }] };
}

export interface RunOptions { previous?: PipelineResult; evidence?: EvidenceSink; subjectSha256?: string; env?: Record<string, string>; now?: () => Date }

export async function runPipeline(type: ListingType, pkg: UnpackedPackage, tools: PipelineTools, opts: RunOptions = {}): Promise<PipelineResult> {
  const now = opts.now ?? (() => new Date());
  const env = { ...(opts.env ?? {}) };
  const subject = opts.subjectSha256 ?? sha256Hex(new TextEncoder().encode(canonicalJson(safeManifest(pkg))));
  const def: PipelineDef | undefined = getPipeline(type);
  if (!def) return failedPipeline(type, subject, `no verification pipeline for type ${String(type)}`, now, env);
  // Always wrap in the limiting sink, so the 2 MiB / 40 blob caps hold even for a caller-supplied sink.
  const supplied = opts.evidence;
  const mimeSink = limitedSink(async (bytes, mime) => {
    if (!supplied) throw new EvidenceLimitError('no evidence sink configured');
    const b = await supplied.addBlob(mime, bytes); return { sha256: b.sha256, size: b.size };
  });
  const startedAt = now().toISOString();
  const stages: StageResult[] = [];
  const byId = new Map<string, StageResult>();
  for (const s of def.stages) {
    let r: StageResult | undefined;
    for (const a of s.after ?? []) {
      const p = byId.get(a);
      if (p && p.status !== 'pass') {
        r = { id: s.id, title: s.title, required: s.required, status: 'skipped', reason: `prerequisite-${p.status === 'fail' ? 'failed' : 'skipped'}:${a}`, evidence: [], durationMs: 0 };
        break;
      }
    }
    r ??= await runStage(s, { pkg, tools, evidence: mimeSink, previous: opts.previous });
    stages.push(r); byId.set(s.id, r);
  }
  return { type, pipeline: def.name, pipelineVersion: def.version, subjectSha256: subject, verdict: deriveVerdict(stages), stages, env, startedAt, finishedAt: now().toISOString() };
}

// ---------------------------------------------------------------- deterministic, size-capped serialisation

function safeManifest(pkg: UnpackedPackage): unknown { try { return pkg.manifest; } catch { return null; } }

/** JSON with object keys sorted at every depth; identical input => byte-identical output. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v, 0));
}
function sortKeys(v: unknown, depth: number): unknown {
  if (depth > 64) return null;
  if (Array.isArray(v)) return v.map(x => sortKeys(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) { const x = (v as Record<string, unknown>)[k]; if (x !== undefined) o[k] = sortKeys(x, depth + 1); }
    return o;
  }
  return v;
}

/**
 * Deterministic and size-capped. Over the cap, evidence is shed in stages (details and blobs first, then all evidence,
 * then reasons shortened) and a `truncated` marker is added to the result; stage ids and statuses are NEVER dropped,
 * so the verdict can never change by truncation. Timing fields are included (they are part of the record).
 */
export function serializeResult(r: PipelineResult, maxBytes = MAX_RESULT_BYTES): string {
  const enc = (x: unknown) => canonicalJson(x);
  const fits = (x: unknown) => Buffer.byteLength(enc(x)) <= maxBytes;
  if (fits(r)) return enc(r);
  const mark = (stages: StageResult[]): unknown => ({ ...r, stages, truncated: true });
  const lvl1 = r.stages.map(s => ({ ...s, evidence: s.evidence.map(e => ({ kind: e.kind, label: clip(e.label, 64) })) }));
  if (fits(mark(lvl1))) return enc(mark(lvl1));
  const lvl2 = r.stages.map(s => ({ ...s, evidence: [] as Evidence[] }));
  if (fits(mark(lvl2))) return enc(mark(lvl2));
  const lvl3 = r.stages.map(s => ({ ...s, evidence: [] as Evidence[], title: clip(s.title, 40), ...(s.reason ? { reason: clip(s.reason, 80) } : {}) }));
  return enc(mark(lvl3)); // stage count is bounded by the pipeline definition, so this is small by construction
}
