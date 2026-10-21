-- Opt-in run telemetry. Nothing here is written unless the person turned sharing on (usage_consent.shared), and only allow-listed,
-- non-free-text fields are ever accepted (src/api/telemetry.ts). Titles, prompts, file names and critique text have no column.
CREATE TABLE usage_consent (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  shared      boolean NOT NULL DEFAULT false,
  version     integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_runs ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE agent_runs
  ADD COLUMN model            text,
  ADD COLUMN mode             text CHECK (mode IN ('managed', 'byok', 'local')),
  ADD COLUMN tool_calls       integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_category text CHECK (failure_category IN ('model_error', 'tool_error', 'timeout', 'validation', 'rate_limited', 'user_cancelled', 'unknown')),
  ADD COLUMN trace_id         text,
  ADD COLUMN client_version   text;
CREATE INDEX ix_runs_state_time ON agent_runs (state, started_at);

CREATE TABLE run_steps (
  run_id            text NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id           text NOT NULL,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_step_id    text,
  agent_id          text,
  kind              text NOT NULL CHECK (kind IN ('plan', 'tool', 'model', 'verify', 'other')),
  state             text NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at        timestamptz,
  ended_at          timestamptz,
  model             text,
  tool_name         text,
  tokens_in         bigint NOT NULL DEFAULT 0,
  tokens_out        bigint NOT NULL DEFAULT 0,
  retries           integer NOT NULL DEFAULT 0,
  failure_category  text CHECK (failure_category IN ('model_error', 'tool_error', 'timeout', 'validation', 'rate_limited', 'user_cancelled', 'unknown')),
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX ix_steps_user ON run_steps (user_id);

CREATE TABLE verification_results (
  run_id            text NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  verifier          text NOT NULL,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format            text NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf', 'other')),
  verdict           text NOT NULL CHECK (verdict IN ('pass', 'fail', 'partial')),
  defect_count      integer NOT NULL DEFAULT 0,
  failure_category  text CHECK (failure_category IN ('model_error', 'tool_error', 'timeout', 'validation', 'rate_limited', 'user_cancelled', 'unknown')),
  PRIMARY KEY (run_id, verifier)
);
CREATE INDEX ix_verif_user ON verification_results (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_consent', 'run_steps', 'verification_results'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                     WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON usage_consent, run_steps, verification_results TO ao_app;
GRANT DELETE ON agent_runs TO ao_app;
GRANT SELECT ON usage_consent, run_steps, verification_results TO ao_readonly;
