// The verification job queue (marketplace Plan 4, Task 5). Pure SQL state machine over marketplace_verify_jobs (migration 0024);
// `db` must connect as ao_admin. Claims are leases: a worker that dies simply stops extending its lease, the job becomes
// reclaimable, and after max_attempts it is dead-lettered with an explicit 'incomplete' verification so the version is
// never left looking "pending forever". Every call after the claim must present the lease token, so a worker whose lease
// was taken over (lease race, long pause) can neither heartbeat nor deliver a result.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { VerificationError, normaliseResult, recordVerification } from '../verifyStore.ts';
import { deriveVerdict } from './runner.ts';
import type { PipelineResult, StageResult } from './types.ts';

type Db = pg.PoolClient | pg.Pool;

export interface VerifyJob {
  id: string; versionId: string; sha256: string; type: string; status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number; maxAttempts: number; leaseOwner: string | null; leaseUntil: string | null; lastError: string | null; verificationId: string | null;
}
export interface ClaimedJob extends VerifyJob { leaseToken: string }

const COLS = `j.id, j.version_id, j.sha256, j.status, j.attempts, j.max_attempts, j.lease_owner, j.lease_until, j.last_error, j.verification_id, l.type`;
const FROM = `marketplace_verify_jobs j JOIN marketplace_versions v ON v.id = j.version_id JOIN marketplace_listings l ON l.id = v.listing_id`;
function toJob(r: any): VerifyJob {
  return { id: r.id, versionId: r.version_id, sha256: r.sha256, type: r.type, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts,
    leaseOwner: r.lease_owner, leaseUntil: r.lease_until ? new Date(r.lease_until).toISOString() : null, lastError: r.last_error, verificationId: r.verification_id };
}
const newJobId = () => `vjob_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
export const clipErr = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 480);

const WORKER_ID = /^[A-Za-z0-9_.:@-]{1,120}$/;
export const validWorkerId = (s: unknown): s is string => typeof s === 'string' && WORKER_ID.test(s);
export const clampLease = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 5), 900) : 60);

/** One live job per (version, artifact sha): a second enqueue returns the first. */
export async function enqueueJob(db: Db, version: { id: string; sha256: string }, by: string, maxAttempts = 3): Promise<{ job: VerifyJob; duplicate: boolean }> {
  const id = newJobId();
  const ins = await db.query(
    `INSERT INTO marketplace_verify_jobs(id, version_id, sha256, enqueued_by, max_attempts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
    [id, version.id, version.sha256, by, Math.min(Math.max(maxAttempts, 1), 10)]);
  const row = ins.rows[0]
    ? (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE j.id = $1`, [id])).rows[0]
    : (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE j.version_id = $1 AND j.sha256 = $2 AND j.status IN ('queued','running') ORDER BY j.seq DESC LIMIT 1`, [version.id, version.sha256])).rows[0];
  return { job: toJob(row), duplicate: !ins.rows[0] };
}

/** An 'incomplete' record for a job that ran out of attempts: explicit, never a pass, and it makes the version visibly "not fully verified". */
async function recordDeadLetter(db: Db, row: { id: string; version_id: string; sha256: string; type: string; last_error: string | null; attempts: number }): Promise<string> {
  const at = new Date().toISOString();
  const stages: StageResult[] = [{ id: 'verifier-worker', title: 'Verifier worker', required: true, status: 'skipped', reason: `dead-letter:attempts-exhausted:${row.attempts}`,
    evidence: [{ kind: 'check', label: 'job dead-lettered', detail: clipErr(row.last_error ?? 'lease expired without a result') }], durationMs: 0 }];
  const result: PipelineResult = { type: row.type as PipelineResult['type'], pipeline: 'verifier-worker', pipelineVersion: 0, subjectSha256: row.sha256, verdict: deriveVerdict(stages), stages, env: {}, startedAt: at, finishedAt: at };
  const rec = await recordVerification(db, row.version_id, normaliseResult(JSON.parse(JSON.stringify(result))), 'verify-worker');
  return rec.id;
}

/** Dead-letters every job that has no attempts left and is not currently leased. Returns how many. */
export async function reapExhausted(db: Db): Promise<number> {
  const rows = (await db.query(
    `UPDATE marketplace_verify_jobs j SET status = 'dead', finished_at = now(), lease_token = NULL, lease_until = NULL,
            last_error = COALESCE(j.last_error, 'lease expired without a result')
       FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
      WHERE v.id = j.version_id AND j.attempts >= j.max_attempts AND (j.status = 'queued' OR (j.status = 'running' AND j.lease_until < now()))
      RETURNING j.id, j.version_id, j.sha256, l.type, j.last_error, j.attempts`)).rows;
  for (const r of rows) {
    const vid = await recordDeadLetter(db, r);
    await db.query('UPDATE marketplace_verify_jobs SET verification_id = $2 WHERE id = $1', [r.id, vid]);
  }
  return rows.length;
}

/** Atomically takes the oldest claimable job (queued, or running with an expired lease) for `leaseSec` seconds. SKIP LOCKED: two workers never get one job. */
export async function claimJob(db: Db, worker: string, leaseSec: number): Promise<ClaimedJob | undefined> {
  await reapExhausted(db);
  const token = randomBytes(24).toString('hex');
  const got = (await db.query(
    `WITH c AS (SELECT id FROM marketplace_verify_jobs
                 WHERE attempts < max_attempts AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
                 ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED)
     UPDATE marketplace_verify_jobs j SET status = 'running', attempts = j.attempts + 1, lease_owner = $1, lease_token = $2,
            lease_until = now() + make_interval(secs => $3), blobs = 0
       FROM c WHERE j.id = c.id RETURNING j.id`, [worker, token, leaseSec])).rows[0];
  if (!got) return undefined;
  const row = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE j.id = $1`, [got.id])).rows[0];
  return { ...toJob(row), leaseToken: token };
}

export class LeaseLostError extends VerificationError {
  constructor() { super(409, 'lease_lost', 'This job is no longer leased to you.'); }
}

/** Locks the job row and checks the caller still holds the lease. A lapsed-but-unreclaimed lease is still the caller's (nobody else has it). */
export async function lockLeased(c: pg.PoolClient, jobId: string, token: string): Promise<VerifyJob & { leaseToken: string; blobs: number }> {
  const r = (await c.query(`SELECT ${COLS}, j.lease_token, j.blobs FROM ${FROM} WHERE j.id = $1 FOR UPDATE OF j`, [jobId])).rows[0];
  if (!r) throw new VerificationError(404, 'not_found', 'No such job.');
  if (r.status !== 'running' || !r.lease_token || r.lease_token !== token) throw new LeaseLostError();
  return { ...toJob(r), leaseToken: r.lease_token, blobs: r.blobs };
}

export async function heartbeatJob(c: pg.PoolClient, jobId: string, token: string, leaseSec: number): Promise<{ leaseUntil: string }> {
  await lockLeased(c, jobId, token);
  const r = (await c.query(`UPDATE marketplace_verify_jobs SET lease_until = now() + make_interval(secs => $2) WHERE id = $1 RETURNING lease_until`, [jobId, leaseSec])).rows[0];
  return { leaseUntil: new Date(r.lease_until).toISOString() };
}

/** The worker could not produce a result (infrastructure, shutdown). Requeues, or dead-letters when no attempts are left. */
export async function failJob(c: pg.PoolClient, jobId: string, token: string, error: string): Promise<{ status: 'queued' | 'dead' }> {
  const j = await lockLeased(c, jobId, token);
  if (j.attempts >= j.maxAttempts) {
    await c.query(`UPDATE marketplace_verify_jobs SET status = 'dead', finished_at = now(), lease_token = NULL, lease_until = NULL, last_error = $2 WHERE id = $1`, [jobId, clipErr(error)]);
    const vid = await recordDeadLetter(c, { id: jobId, version_id: j.versionId, sha256: j.sha256, type: j.type, last_error: clipErr(error), attempts: j.attempts });
    await c.query('UPDATE marketplace_verify_jobs SET verification_id = $2 WHERE id = $1', [jobId, vid]);
    return { status: 'dead' };
  }
  await c.query(`UPDATE marketplace_verify_jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, lease_owner = NULL, last_error = $2 WHERE id = $1`, [jobId, clipErr(error)]);
  return { status: 'queued' };
}

export async function latestJob(db: Db, versionId: string): Promise<VerifyJob | undefined> {
  const r = (await db.query(`SELECT ${COLS} FROM ${FROM} WHERE j.version_id = $1 ORDER BY j.seq DESC LIMIT 1`, [versionId])).rows[0];
  return r && toJob(r);
}
