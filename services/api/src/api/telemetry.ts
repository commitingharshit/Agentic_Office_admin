// Opt-in run telemetry. The server accepts only an allow-list of ids, enums, counts and timings: any other field is refused outright
// (so a client that starts sending a title, prompt, file name or critique is rejected, not quietly stored), nothing is accepted while
// the person's sharing switch is off, and a re-sent run updates itself rather than doubling. Functions take a client already inside a
// request transaction with app.user_id set, so row-level security keeps every row to its owner.
import type pg from 'pg';
import { HttpError } from './errors.ts';

export const RUN_STATES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export const FAILURES = ['model_error', 'tool_error', 'timeout', 'validation', 'rate_limited', 'user_cancelled', 'unknown'] as const;
const STEP_KINDS = ['plan', 'tool', 'model', 'verify', 'other'] as const;
const MODES = ['managed', 'byok', 'local'] as const;
const FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'other'] as const;
const VERDICTS = ['pass', 'fail', 'partial'] as const;
const MAX_RUNS = 50, MAX_STEPS = 200, MAX_VERIF = 20;

// Identifier-shaped text only: no spaces, no sentences. This is what keeps free text out.
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

const bad = (m: string): never => { throw new HttpError(400, m); };
function exact(o: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad(`${what} must be an object.`);
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) bad(`${what} has fields that are not accepted: ${extra.join(', ')}.`);
  return o as Record<string, unknown>;
}
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string, optional = false): T | null => {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) bad(`${what} must be one of ${set.join(', ')}.`);
  return v as T;
};
const ident = (v: unknown, what: string, optional = true): string | null => {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v !== 'string' || !IDENT.test(v)) bad(`${what} must be an identifier (letters, digits, . _ : / @ -, at most 80).`);
  return v as string;
};
const count = (v: unknown, what: string): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e12) bad(`${what} must be a non-negative whole number.`);
  return v as number;
};
const when = (v: unknown, what: string, optional = true): string | null => {
  if ((v === undefined || v === null) && optional) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t) || t < Date.parse('2020-01-01') || t > Date.now() + 86_400_000) bad(`${what} must be a recent ISO time.`);
  return new Date(t).toISOString();
};

export async function getConsent(c: pg.PoolClient) {
  const r = (await c.query('SELECT shared, version, updated_at FROM usage_consent')).rows[0];
  return { shared: r?.shared ?? false, version: r?.version ?? 1, updated_at: r?.updated_at ?? null };
}

/** Turn sharing on or off. Turning it off can also erase what was already shared (the person decides). */
export async function setConsent(c: pg.PoolClient, userId: string, b: Record<string, unknown>) {
  exact(b, ['shared', 'delete_existing'], 'The request');
  if (typeof b.shared !== 'boolean') bad('shared must be true or false.');
  await c.query(`INSERT INTO usage_consent(user_id, shared, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id) DO UPDATE SET shared = EXCLUDED.shared, updated_at = now()`, [userId, b.shared]);
  let deleted = 0;
  if (b.shared === false && b.delete_existing === true) deleted = (await c.query('DELETE FROM agent_runs')).rowCount ?? 0;   // steps and verdicts cascade; RLS limits it to this person
  return { shared: b.shared, deleted_runs: deleted };
}

export async function ingestRuns(c: pg.PoolClient, userId: string, body: Record<string, unknown>) {
  exact(body, ['runs'], 'The request');
  if (!(await getConsent(c)).shared) throw new HttpError(403, 'Usage sharing is off. Turn it on in the app to send run details.');
  if (!Array.isArray(body.runs) || !body.runs.length) return bad('runs must be a non-empty list.');
  if (body.runs.length > MAX_RUNS) return bad(`At most ${MAX_RUNS} runs per request.`);
  // Validate everything before writing anything: a bad run rejects the whole batch.
  const runs = body.runs.map((raw: unknown, i: number) => {
    const r = exact(raw, ['run_id', 'session_id', 'parent_run_id', 'agent_id', 'state', 'started_at', 'ended_at', 'tokens_in', 'tokens_out', 'model', 'mode', 'tool_calls', 'failure_category', 'trace_id', 'client_version', 'steps', 'verification'], `runs[${i}]`);
    if (typeof r.run_id !== 'string' || !RUN_ID.test(r.run_id)) bad(`runs[${i}].run_id is not valid.`);
    const steps = Array.isArray(r.steps) ? r.steps : r.steps === undefined ? [] : bad(`runs[${i}].steps must be a list.`);
    const verification = Array.isArray(r.verification) ? r.verification : r.verification === undefined ? [] : bad(`runs[${i}].verification must be a list.`);
    if (steps.length > MAX_STEPS || verification.length > MAX_VERIF) bad(`runs[${i}] has too many steps or verdicts.`);
    return {
      run_id: r.run_id as string, session_id: ident(r.session_id, 'session_id'), parent_run_id: r.parent_run_id == null ? null : (RUN_ID.test(String(r.parent_run_id)) ? String(r.parent_run_id) : bad('parent_run_id is not valid.')),
      agent_id: ident(r.agent_id, 'agent_id'), state: oneOf(r.state, RUN_STATES, 'state')!, started_at: when(r.started_at, 'started_at', false)!, ended_at: when(r.ended_at, 'ended_at'),
      tokens_in: count(r.tokens_in, 'tokens_in'), tokens_out: count(r.tokens_out, 'tokens_out'), model: ident(r.model, 'model'), mode: oneOf(r.mode, MODES, 'mode', true),
      tool_calls: count(r.tool_calls, 'tool_calls'), failure_category: oneOf(r.failure_category, FAILURES, 'failure_category', true), trace_id: ident(r.trace_id, 'trace_id'), client_version: ident(r.client_version, 'client_version'),
      steps: steps.map((sRaw: unknown, j: number) => {
        const s = exact(sRaw, ['step_id', 'parent_step_id', 'agent_id', 'kind', 'state', 'started_at', 'ended_at', 'model', 'tool_name', 'tokens_in', 'tokens_out', 'retries', 'failure_category'], `runs[${i}].steps[${j}]`);
        return { step_id: ident(s.step_id, 'step_id', false)!, parent_step_id: ident(s.parent_step_id, 'parent_step_id'), agent_id: ident(s.agent_id, 'agent_id'), kind: oneOf(s.kind, STEP_KINDS, 'kind')!, state: oneOf(s.state, RUN_STATES, 'state')!,
          started_at: when(s.started_at, 'started_at'), ended_at: when(s.ended_at, 'ended_at'), model: ident(s.model, 'model'), tool_name: ident(s.tool_name, 'tool_name'), tokens_in: count(s.tokens_in, 'tokens_in'), tokens_out: count(s.tokens_out, 'tokens_out'),
          retries: count(s.retries, 'retries'), failure_category: oneOf(s.failure_category, FAILURES, 'failure_category', true) };
      }),
      verification: verification.map((vRaw: unknown, j: number) => {
        const v = exact(vRaw, ['verifier', 'format', 'verdict', 'defect_count', 'failure_category'], `runs[${i}].verification[${j}]`);
        return { verifier: ident(v.verifier, 'verifier', false)!, format: oneOf(v.format, FORMATS, 'format')!, verdict: oneOf(v.verdict, VERDICTS, 'verdict')!, defect_count: count(v.defect_count, 'defect_count'), failure_category: oneOf(v.failure_category, FAILURES, 'failure_category', true) };
      }),
    };
  });
  for (const r of runs) {
    // A re-sent run updates itself. The conflict target is the primary key, and row-level security refuses another person's run.
    await c.query(`INSERT INTO agent_runs(run_id, user_id, session_id, parent_run_id, agent_id, state, started_at, ended_at, tokens_in, tokens_out, model, mode, tool_calls, failure_category, trace_id, client_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (run_id) DO UPDATE SET state = EXCLUDED.state, ended_at = EXCLUDED.ended_at, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out,
        model = EXCLUDED.model, mode = EXCLUDED.mode, tool_calls = EXCLUDED.tool_calls, failure_category = EXCLUDED.failure_category, agent_id = EXCLUDED.agent_id`,
      [r.run_id, userId, r.session_id, r.parent_run_id, r.agent_id, r.state, r.started_at, r.ended_at, r.tokens_in, r.tokens_out, r.model, r.mode, r.tool_calls, r.failure_category, r.trace_id, r.client_version]);
    for (const s of r.steps) await c.query(`INSERT INTO run_steps(run_id, step_id, user_id, parent_step_id, agent_id, kind, state, started_at, ended_at, model, tool_name, tokens_in, tokens_out, retries, failure_category)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (run_id, step_id) DO UPDATE SET state = EXCLUDED.state, ended_at = EXCLUDED.ended_at, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, retries = EXCLUDED.retries, failure_category = EXCLUDED.failure_category`,
      [r.run_id, s.step_id, userId, s.parent_step_id, s.agent_id, s.kind, s.state, s.started_at, s.ended_at, s.model, s.tool_name, s.tokens_in, s.tokens_out, s.retries, s.failure_category]);
    for (const v of r.verification) await c.query(`INSERT INTO verification_results(run_id, verifier, user_id, format, verdict, defect_count, failure_category) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (run_id, verifier) DO UPDATE SET verdict = EXCLUDED.verdict, defect_count = EXCLUDED.defect_count, failure_category = EXCLUDED.failure_category`,
      [r.run_id, v.verifier, userId, v.format, v.verdict, v.defect_count, v.failure_category]);
  }
  return { accepted: runs.length };
}
