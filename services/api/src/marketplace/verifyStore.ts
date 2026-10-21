// Storage and validation of verification results (marketplace Plan 4, Task 2). A result is explicit pass | fail | skipped
// per stage with evidence references; there is no score. Everything that arrives over the API is untrusted: it is
// re-built field by field (unknown keys are refused), the verdict is RECOMPUTED from the stages, and the result must be
// for the exact artifact the version carries. The database repeats the sha check (swap guard) and the approval gate.
import type pg from 'pg';
import { sha256Hex, type ArtifactStore } from './artifacts.ts';
import { LISTING_TYPES, type ListingType } from './types.ts';
import { assertNoScoreKeys, getPipeline, PipelineContractError } from './verify/registry.ts';
import { canonicalJson, deriveVerdict } from './verify/runner.ts';
import {
  MAX_EVIDENCE_BLOB_BYTES, MAX_EVIDENCE_BLOBS_PER_RUN, MAX_EVIDENCE_DETAIL, MAX_EVIDENCE_PER_STAGE, MAX_LABEL, MAX_REASON, MAX_RESULT_BYTES,
  type Evidence, type PipelineResult, type StageResult,
} from './verify/types.ts';

type Db = pg.PoolClient | pg.Pool;

export class VerificationError extends Error {
  readonly status: number; readonly code: string; readonly extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const bad = (m: string) => new VerificationError(400, 'bad_request', m);

export const MAX_RESULTS_PER_VERSION = 50;
const SHA = /^[0-9a-f]{64}$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KINDS = ['check', 'text', 'json', 'image', 'log'], MIMES = ['image/png', 'text/plain', 'application/json'], OPS = ['>=', '<=', '=='];

function only(o: unknown, keys: string[], what: string): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad(`${what} must be an object.`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${what} has an unknown field "${k.slice(0, 40)}".`);
  return o as Record<string, unknown>;
}
function str(v: unknown, what: string, max: number, min = 0): string {
  if (typeof v !== 'string' || v.length > max || v.length < min) throw bad(`${what} must be a string of ${min} to ${max} characters.`);
  return v;
}
function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${what} must be an integer from ${min} to ${max}.`);
  return v;
}
function when(v: unknown, what: string): string {
  const s = str(v, what, 40, 10), t = Date.parse(s);
  if (Number.isNaN(t) || new Date(t).toISOString() !== s) throw bad(`${what} must be an ISO-8601 UTC timestamp like 2026-10-21T10:00:00.000Z.`);
  return s;
}

export interface Normalised { result: PipelineResult; evidenceShas: string[]; resultSha256: string }

/** Structural validation only (no I/O). Throws VerificationError(400); the version binding is checked by validateAgainstVersion. */
export function normaliseResult(raw: unknown): Normalised {
  try { assertNoScoreKeys(raw); } catch (e) { if (e instanceof PipelineContractError) throw bad(e.message); throw e; }
  const r = only(raw, ['type', 'pipeline', 'pipelineVersion', 'subjectSha256', 'verdict', 'stages', 'env', 'startedAt', 'finishedAt'], 'result');
  if (!(LISTING_TYPES as readonly string[]).includes(r.type as string)) throw bad('type is not a listing type.');
  const pipeline = str(r.pipeline, 'pipeline', 64, 1);
  if (!KEBAB.test(pipeline) && pipeline !== 'none') throw bad('pipeline must be kebab-case.');
  const subjectSha256 = str(r.subjectSha256, 'subjectSha256', 64, 64);
  if (!SHA.test(subjectSha256)) throw bad('subjectSha256 must be 64 lowercase hex characters.');
  if (!Array.isArray(r.stages) || r.stages.length < 1 || r.stages.length > 64) throw bad('stages must be an array of 1 to 64 stages.');
  const ids = new Set<string>(), shas = new Set<string>(); let blobs = 0;
  const stages: StageResult[] = r.stages.map((sRaw, i) => {
    const s = only(sRaw, ['id', 'title', 'required', 'status', 'reason', 'evidence', 'durationMs'], `stages[${i}]`);
    const id = str(s.id, `stages[${i}].id`, 64, 1);
    if (!KEBAB.test(id)) throw bad(`stages[${i}].id must be kebab-case.`);
    if (ids.has(id)) throw bad(`duplicate stage id "${id}".`);
    ids.add(id);
    if (typeof s.required !== 'boolean') throw bad(`stages[${i}].required must be a boolean.`);
    if (s.status !== 'pass' && s.status !== 'fail' && s.status !== 'skipped') throw bad(`stages[${i}].status must be pass, fail or skipped.`);
    const out: StageResult = { id, title: str(s.title, `stages[${i}].title`, MAX_LABEL, 1), required: s.required, status: s.status, evidence: [], durationMs: int(s.durationMs, `stages[${i}].durationMs`, 0, 3_600_000) };
    if (s.reason !== undefined) out.reason = str(s.reason, `stages[${i}].reason`, MAX_REASON);
    if (out.status !== 'pass' && !out.reason) throw bad(`stages[${i}] is ${out.status} and needs a reason.`);
    if (!Array.isArray(s.evidence) || s.evidence.length > MAX_EVIDENCE_PER_STAGE) throw bad(`stages[${i}].evidence must be an array of at most ${MAX_EVIDENCE_PER_STAGE} items.`);
    out.evidence = s.evidence.map((eRaw, j) => {
      const e = only(eRaw, ['kind', 'label', 'detail', 'blob', 'measured'], `stages[${i}].evidence[${j}]`);
      if (!KINDS.includes(e.kind as string)) throw bad(`stages[${i}].evidence[${j}].kind is not valid.`);
      const ev: Evidence = { kind: e.kind as Evidence['kind'], label: str(e.label, 'evidence label', MAX_LABEL) };
      if (e.detail !== undefined) ev.detail = str(e.detail, 'evidence detail', MAX_EVIDENCE_DETAIL);
      if (e.blob !== undefined) {
        const b = only(e.blob, ['sha256', 'mime', 'size'], 'evidence blob');
        const sha = str(b.sha256, 'evidence blob sha256', 64, 64);
        if (!SHA.test(sha)) throw bad('evidence blob sha256 must be 64 lowercase hex characters.');
        if (!MIMES.includes(b.mime as string)) throw bad('evidence blob mime is not allowed.');
        if (++blobs > MAX_EVIDENCE_BLOBS_PER_RUN) throw bad(`more than ${MAX_EVIDENCE_BLOBS_PER_RUN} evidence blobs in one result.`);
        ev.blob = { sha256: sha, mime: b.mime as 'image/png', size: int(b.size, 'evidence blob size', 0, MAX_EVIDENCE_BLOB_BYTES) };
        shas.add(sha);
      }
      if (e.measured !== undefined) {
        const m = only(e.measured, ['name', 'value', 'threshold', 'op'], 'evidence measured');
        if (typeof m.value !== 'number' || !Number.isFinite(m.value) || typeof m.threshold !== 'number' || !Number.isFinite(m.threshold)) throw bad('measured value and threshold must be finite numbers.');
        if (!OPS.includes(m.op as string)) throw bad('measured op is not valid.');
        ev.measured = { name: str(m.name, 'measured name', 64, 1), value: m.value, threshold: m.threshold, op: m.op as '>=' };
      }
      return ev;
    });
    return out;
  });
  const env: Record<string, string> = {};
  const envRaw = r.env ?? {};
  if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw) || Object.keys(envRaw).length > 32) throw bad('env must be an object of at most 32 entries.');
  for (const [k, v] of Object.entries(envRaw)) env[str(k, 'env key', 64, 1)] = str(v, 'env value', 200);
  const startedAt = when(r.startedAt, 'startedAt'), finishedAt = when(r.finishedAt, 'finishedAt');
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw bad('finishedAt is before startedAt.');
  if (Date.parse(finishedAt) > Date.now() + 24 * 3600_000) throw bad('finishedAt is in the future.');
  const verdict = deriveVerdict(stages);
  if (r.verdict !== verdict) throw bad(`verdict "${String(r.verdict).slice(0, 20)}" does not match the stages (they derive "${verdict}").`);
  const result: PipelineResult = { type: r.type as ListingType, pipeline, pipelineVersion: int(r.pipelineVersion, 'pipelineVersion', 0, 1_000_000), subjectSha256, verdict, stages, env, startedAt, finishedAt };
  const text = canonicalJson(result);
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new VerificationError(413, 'too_large', `The result is over ${MAX_RESULT_BYTES} bytes.`);
  return { result, evidenceShas: [...shas], resultSha256: sha256Hex(new TextEncoder().encode(text)) };
}

/** Binds a normalised result to the stored version and checks every evidence blob really exists and is evidence, not someone's package. */
export async function validateAgainstVersion(db: Db, store: ArtifactStore, n: Normalised, v: { sha256: string; type: string }): Promise<void> {
  if (n.result.subjectSha256 !== v.sha256) throw new VerificationError(409, 'sha_mismatch', 'The result is for a different artifact than this version carries.');
  if (n.result.type !== v.type) throw new VerificationError(409, 'type_mismatch', 'The result is for a different listing type than this version.');
  if (n.evidenceShas.length) {
    const clash = (await db.query('SELECT sha256 FROM marketplace_artifacts WHERE sha256 = ANY($1::text[]) LIMIT 1', [n.evidenceShas])).rows[0];
    if (clash) throw bad('An evidence blob refers to a package artifact; evidence must be its own blob.');
    const sizes = new Map<string, number>();
    for (const s of n.result.stages) for (const e of s.evidence) if (e.blob) sizes.set(e.blob.sha256, e.blob.size);
    for (const sha of n.evidenceShas) {
      const bytes = await store.get(sha);
      if (!bytes) throw bad('An evidence blob is not in the store.');
      if (bytes.byteLength !== sizes.get(sha) || sha256Hex(bytes) !== sha) throw bad('An evidence blob does not match its declared size and sha256.');
    }
  }
}

/** Inserts one result (idempotent per identical result). `db` must connect as ao_admin. */
export async function recordVerification(db: Db, versionId: string, n: Normalised, runBy: string): Promise<{ id: string; duplicate: boolean }> {
  const count = Number((await db.query('SELECT count(*) AS n FROM marketplace_verifications WHERE version_id = $1', [versionId])).rows[0].n);
  const existing = (await db.query('SELECT id FROM marketplace_verifications WHERE version_id = $1 AND result_sha256 = $2', [versionId, n.resultSha256])).rows[0];
  if (existing) return { id: existing.id, duplicate: true };
  if (count >= MAX_RESULTS_PER_VERSION) throw new VerificationError(409, 'verification_limit', `This version already has ${MAX_RESULTS_PER_VERSION} verification results.`);
  const id = `ver_${Date.now().toString(36)}${sha256Hex(new TextEncoder().encode(n.resultSha256 + versionId + Math.random())).slice(0, 16)}`;
  const r = n.result;
  const ins = await db.query(
    `INSERT INTO marketplace_verifications(id, version_id, sha256, pipeline, pipeline_version, verdict, stages, env, evidence_shas, result_sha256, started_at, finished_at, run_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (version_id, result_sha256) DO NOTHING RETURNING id`,
    [id, versionId, r.subjectSha256, r.pipeline, r.pipelineVersion, r.verdict, JSON.stringify(r.stages), JSON.stringify(r.env), n.evidenceShas, n.resultSha256, r.startedAt, r.finishedAt, runBy]);
  if (!ins.rows[0]) return { id: (await db.query('SELECT id FROM marketplace_verifications WHERE version_id = $1 AND result_sha256 = $2', [versionId, n.resultSha256])).rows[0].id, duplicate: true };
  return { id, duplicate: false };
}

export interface StoredVerification {
  id: string; versionId: string; type: string; sha256: string; pipeline: string; pipelineVersion: number; verdict: 'pass' | 'fail' | 'incomplete';
  stages: StageResult[]; env: Record<string, string>; startedAt: string; finishedAt: string; runBy: string;
}

/** The newest result recorded for exactly the version's current artifact sha, or undefined. Visibility is the caller's RLS. */
export async function latestVerification(db: Db, versionId: string): Promise<StoredVerification | undefined> {
  const row = (await db.query(
    `SELECT x.id, x.version_id, l.type, x.sha256, x.pipeline, x.pipeline_version, x.verdict, x.stages, x.env, x.started_at, x.finished_at, x.run_by
       FROM marketplace_verifications x JOIN marketplace_versions v ON v.id = x.version_id AND v.sha256 = x.sha256
       JOIN marketplace_listings l ON l.id = v.listing_id
      WHERE x.version_id = $1 ORDER BY x.seq DESC LIMIT 1`, [versionId])).rows[0];
  return row && { id: row.id, versionId: row.version_id, type: row.type, sha256: row.sha256, pipeline: row.pipeline, pipelineVersion: row.pipeline_version, verdict: row.verdict,
    stages: row.stages, env: row.env, startedAt: new Date(row.started_at).toISOString(), finishedAt: new Date(row.finished_at).toISOString(), runBy: row.run_by };
}

/** True when a pipeline other than the one that produced this result is now registered for the type (re-run it). */
export function isStale(s: Pick<StoredVerification, 'type' | 'pipeline' | 'pipelineVersion'>): boolean {
  const def = getPipeline(s.type as ListingType);
  return !!def && (def.name !== s.pipeline || def.version > s.pipelineVersion);
}

/** The public view: the stored stages plus a same-origin URL per evidence blob. Evidence text stays untrusted data. */
export function toView(s: StoredVerification) {
  return {
    verdict: s.verdict, verified: s.verdict === 'pass', pipeline: s.pipeline, pipelineVersion: s.pipelineVersion, artifactSha256: s.sha256, stale: isStale(s), at: s.finishedAt,
    stages: s.stages.map((st) => ({ id: st.id, title: st.title, required: st.required, status: st.status, ...(st.reason ? { reason: st.reason } : {}),
      evidence: st.evidence.map((e) => ({ kind: e.kind, label: e.label, ...(e.detail ? { detail: e.detail } : {}), ...(e.measured ? { measured: e.measured } : {}),
        ...(e.blob ? { blobUrl: `/v1/marketplace/versions/${s.versionId}/verification/evidence/${e.blob.sha256}`, blobMime: e.blob.mime, blobSize: e.blob.size } : {}) })) })),
  };
}

export async function requiredTypes(db: Db): Promise<string[]> {
  return (await db.query('SELECT verification_required_types AS t FROM marketplace_settings')).rows[0]?.t ?? [];
}

/**
 * The API half of the approval gate (the database trigger is the backstop and has the same rules). `ack` is the admin's
 * acknowledgement text for an 'incomplete' verdict; it is recorded by the caller in admin_audit BEFORE the state change.
 * Returns the verification id an acknowledgement must name, or undefined when no acknowledgement is involved.
 */
export async function checkApprovalGate(db: Db, v: { id: string; sha256: string; type: string }, ack: string | undefined): Promise<{ ackFor?: string; alreadyAcked?: boolean }> {
  if (!(await requiredTypes(db)).includes(v.type)) return {};
  const latest = (await db.query('SELECT id, verdict, stages FROM marketplace_verifications WHERE version_id = $1 AND sha256 = $2 ORDER BY seq DESC LIMIT 1', [v.id, v.sha256])).rows[0];
  if (!latest) throw new VerificationError(409, 'verification_required', 'This version has no verification result for its artifact; run the verification first.');
  const stages = latest.stages as StageResult[];
  if (latest.verdict === 'pass') return {};
  if (latest.verdict === 'fail') throw new VerificationError(409, 'verification_failed', 'The latest verification failed.', { failedStages: stages.filter((s) => s.status === 'fail').map((s) => s.id).slice(0, 64) });
  const acked = (await db.query(`SELECT 1 FROM admin_audit WHERE action = 'marketplace.approve_incomplete' AND detail ->> 'versionId' = $1 AND detail ->> 'verificationId' = $2 LIMIT 1`, [v.id, latest.id])).rowCount;
  if (acked) return { alreadyAcked: true };
  if (!ack) throw new VerificationError(409, 'verification_incomplete', 'The latest verification is incomplete (a required stage was skipped); acknowledge it explicitly to proceed.',
    { skippedStages: stages.filter((s) => s.required && s.status === 'skipped').map((s) => ({ id: s.id, reason: s.reason })).slice(0, 64) });
  return { ackFor: latest.id };
}
