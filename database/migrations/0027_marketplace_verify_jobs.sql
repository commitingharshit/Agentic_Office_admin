-- Marketplace Plan 4, Task 5: the verification job queue the out-of-process verifier worker claims from.
-- Adds a table only (no function or trigger), so nothing earlier is redefined. The queue state machine lives in
-- src/marketplace/verify/jobs.ts and is exercised against a real Postgres in test/marketplace-verify-worker.test.ts.
--   queued  -> running (claim, with a lease and a fresh lease_token) -> done
--   running with an expired lease is reclaimable (a killed worker never leaves a version stuck)
--   a job that has used max_attempts is dead-lettered ('dead') and an 'incomplete' verification is recorded for it
CREATE TABLE marketplace_verify_jobs (
  id            text PRIMARY KEY,
  seq           bigserial NOT NULL UNIQUE,
  version_id    text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),      -- the artifact verified; a result for any other sha is refused
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  attempts      int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int  NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner   text CHECK (lease_owner IS NULL OR length(lease_owner) <= 120),   -- display name of the worker
  lease_token   text,                                                              -- secret to the holder; every later call must present it
  lease_until   timestamptz,
  blobs         int  NOT NULL DEFAULT 0 CHECK (blobs BETWEEN 0 AND 40),
  enqueued_by   text NOT NULL CHECK (length(enqueued_by) BETWEEN 1 AND 120),
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  last_error    text CHECK (last_error IS NULL OR length(last_error) <= 500),
  verification_id text
);
-- at most one live job per (version, artifact): enqueueing twice is one job
CREATE UNIQUE INDEX ux_mkt_vjobs_active ON marketplace_verify_jobs (version_id, sha256) WHERE status IN ('queued','running');
CREATE INDEX ix_mkt_vjobs_claim ON marketplace_verify_jobs (status, lease_until, seq);
CREATE INDEX ix_mkt_vjobs_version ON marketplace_verify_jobs (version_id, seq DESC);

DO $$
BEGIN
  -- ao_app deliberately gets nothing: jobs are an admin-plane concern.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT SELECT, INSERT, UPDATE ON marketplace_verify_jobs TO ao_admin;
    GRANT USAGE ON SEQUENCE marketplace_verify_jobs_seq_seq TO ao_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN
    GRANT SELECT ON marketplace_verify_jobs TO ao_readonly;
  END IF;
END $$;
