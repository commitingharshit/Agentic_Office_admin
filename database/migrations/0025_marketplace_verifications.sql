-- Marketplace Plan 4, Task 2: append-only verification results keyed to the artifact sha256, and the approval gate.
-- Depends on 0016 (versions, release events, helper functions), 0018 (type policy) and the control-plane admin_audit table.
-- This migration defines NEW functions only: it deliberately does not redefine the versions guard function (0016/0018/0019) or
-- the manual-review guard (0018); the gate is its own trigger so every earlier rule keeps firing unchanged.

-- Which listing types require a passing verification before approved/published. DATA, not hardcoded: it starts empty and an
-- operator turns a type on (UPDATE as the owner role) once its pipeline is registered, because enforcing it for a type that has
-- no pipeline would make that type unpublishable. ao_app and ao_admin cannot write it.
CREATE TABLE marketplace_settings (
  id                          boolean PRIMARY KEY DEFAULT true CHECK (id),
  verification_required_types text[] NOT NULL DEFAULT '{}'
);
INSERT INTO marketplace_settings(id) VALUES (true);

CREATE TABLE marketplace_verifications (
  id               text PRIMARY KEY,
  seq              bigserial NOT NULL UNIQUE,
  version_id       text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  pipeline         text NOT NULL CHECK (length(pipeline) BETWEEN 1 AND 64),
  pipeline_version int  NOT NULL CHECK (pipeline_version >= 0),
  verdict          text NOT NULL CHECK (verdict IN ('pass','fail','incomplete')),
  stages           jsonb NOT NULL CHECK (jsonb_typeof(stages) = 'array' AND pg_column_size(stages) <= 524288),
  env              jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(env) = 'object' AND pg_column_size(env) <= 8192),
  evidence_shas    text[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_shas) <= 40),
  result_sha256    text NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  run_by           text NOT NULL CHECK (length(run_by) BETWEEN 1 AND 120),
  UNIQUE (version_id, result_sha256)          -- an identical result replayed is one row, not many
);
CREATE INDEX ix_mkt_verif_version ON marketplace_verifications (version_id, seq DESC);

-- Swap guard: a result is only ever recorded for the bytes the version really carries.
CREATE FUNCTION marketplace_verifications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE vsha text;
BEGIN
  SELECT v.sha256 INTO vsha FROM marketplace_versions v WHERE v.id = NEW.version_id;
  IF vsha IS DISTINCT FROM NEW.sha256 THEN
    RAISE EXCEPTION 'marketplace_verifications: result is for artifact % but version % carries %', NEW.sha256, NEW.version_id, vsha
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_verifications_guard BEFORE INSERT ON marketplace_verifications
  FOR EACH ROW EXECUTE FUNCTION marketplace_verifications_guard();

-- Append-only, except that deleting the VERSION (a creator rollback) cascades: by then the parent row is gone.
CREATE FUNCTION marketplace_verifications_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.id = OLD.version_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'marketplace_verifications is append-only' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER trg_mkt_verifications_append_only BEFORE UPDATE OR DELETE ON marketplace_verifications
  FOR EACH ROW EXECUTE FUNCTION marketplace_verifications_append_only();

-- The approval gate. For a type listed in marketplace_settings, a version becomes approved/published only when its LATEST
-- verification for exactly this sha256 is 'pass', or is 'incomplete' AND an admin recorded an explicit acknowledgement
-- (admin_audit 'marketplace.approve_incomplete' naming that verification). 'fail' and "no verification" never pass.
-- SECURITY DEFINER because ao_app (which can UPDATE state) may not read admin_audit.
CREATE FUNCTION marketplace_verification_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ltype text; required text[]; latest record;
BEGIN
  IF NEW.state NOT IN ('approved','published') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
  SELECT s.verification_required_types INTO required FROM marketplace_settings s;
  SELECT l.type INTO ltype FROM marketplace_listings l WHERE l.id = NEW.listing_id;
  IF required IS NULL OR ltype IS NULL OR NOT (ltype = ANY(required)) THEN RETURN NEW; END IF;
  SELECT id, verdict INTO latest FROM marketplace_verifications
   WHERE version_id = NEW.id AND sha256 = NEW.sha256 ORDER BY seq DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'marketplace_versions: % has no verification for its artifact; it cannot become %', NEW.id, NEW.state USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF latest.verdict = 'pass' THEN RETURN NEW; END IF;
  IF latest.verdict = 'incomplete' AND EXISTS (
       SELECT 1 FROM admin_audit a WHERE a.action = 'marketplace.approve_incomplete'
          AND a.detail ->> 'versionId' = NEW.id AND a.detail ->> 'verificationId' = latest.id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'marketplace_versions: % verification is % (needs pass); it cannot become %', NEW.id, latest.verdict, NEW.state USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER trg_mkt_verification_gate BEFORE INSERT OR UPDATE OF state ON marketplace_versions
  FOR EACH ROW EXECUTE FUNCTION marketplace_verification_gate();

REVOKE EXECUTE ON FUNCTION marketplace_verifications_guard(), marketplace_verifications_append_only(), marketplace_verification_gate() FROM PUBLIC;

-- Roles, grants and row-level security (guarded so the file loads where the roles do not exist).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN
    ALTER TABLE marketplace_verifications ENABLE ROW LEVEL SECURITY;
    -- readable exactly when the version is (RLS on marketplace_versions applies to the sub-select); no write policy exists for ao_app
    CREATE POLICY read_visible ON marketplace_verifications FOR SELECT USING (version_id IN (SELECT id FROM marketplace_versions));
    GRANT SELECT ON marketplace_verifications TO ao_app;
    GRANT SELECT ON marketplace_settings TO ao_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT SELECT, INSERT ON marketplace_verifications TO ao_admin;
    GRANT USAGE ON SEQUENCE marketplace_verifications_seq_seq TO ao_admin;
    GRANT SELECT ON marketplace_settings TO ao_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN
    GRANT SELECT ON marketplace_verifications, marketplace_settings TO ao_readonly;
  END IF;
END $$;
