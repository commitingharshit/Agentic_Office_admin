-- Marketplace Plan 3, Task 1: type policy, risk tier on versions, and a database backstop so a type that needs manual
-- review can never reach 'published' without a recorded approval by someone other than the submitter.
-- Depends on 0021_marketplace.sql only. (0017 belongs to Plan 2; numbers are allocated by the controller.)

CREATE TABLE marketplace_type_policy (
  type                text PRIMARY KEY,
  risk_tier           text NOT NULL CHECK (risk_tier IN ('data','declarative','executable')),
  manual_review       boolean NOT NULL,
  min_publisher_trust text NOT NULL CHECK (min_publisher_trust IN ('official','verified','community','private'))
);
-- Mirrors TYPE_POLICY in src/marketplace/support.ts (the code is authoritative; this table is the backstop).
INSERT INTO marketplace_type_policy(type, risk_tier, manual_review, min_publisher_trust) VALUES
  ('template',  'data',        false, 'community'),
  ('skill',     'declarative', false, 'community'),
  ('hook',      'executable',  true,  'verified'),
  ('bridge',    'executable',  true,  'verified'),
  ('connector', 'executable',  true,  'verified'),
  ('routine',   'declarative', true,  'community'),
  ('memory',    'declarative', true,  'community'),
  ('workflow',  'declarative', true,  'community'),
  ('surface',   'executable',  true,  'verified'),
  ('agent',     'declarative', false,  'community'),
  ('bundle',    'declarative', false,  'community');

-- NULL = a version stored before tiers existed (treated as unknown by readers); new versions always carry one.
ALTER TABLE marketplace_versions
  ADD COLUMN risk_tier text CHECK (risk_tier IS NULL OR risk_tier IN ('data','declarative','executable'));

-- Extends the 0016 guard: risk_tier is part of what a published version freezes.
CREATE OR REPLACE FUNCTION marketplace_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    locked := OLD.published_at IS NOT NULL OR OLD.state IN ('published','deprecated','quarantined','revoked');
    IF locked THEN
      IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.manifest IS DISTINCT FROM OLD.manifest OR
         NEW.version IS DISTINCT FROM OLD.version OR NEW.listing_id IS DISTINCT FROM OLD.listing_id OR
         NEW.size IS DISTINCT FROM OLD.size OR NEW.compat IS DISTINCT FROM OLD.compat OR
         NEW.risk_tier IS DISTINCT FROM OLD.risk_tier THEN
        RAISE EXCEPTION 'marketplace_versions: published version % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.state IN ('draft','validating','testing','submitted','in_review','approved','rejected') THEN
        RAISE EXCEPTION 'marketplace_versions: published version % is immutable (cannot return to %)', OLD.id, NEW.state USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.published_at IS DISTINCT FROM OLD.published_at AND OLD.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'marketplace_versions: published_at of % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IN ('approved','published') AND NEW.state IS DISTINCT FROM OLD.state AND NEW.scan_verdict NOT IN ('clean','warnings') THEN
    RAISE EXCEPTION 'marketplace_versions: % cannot become % with scan verdict %', OLD.id, NEW.state, NEW.scan_verdict USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'published' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
  RETURN NEW;
END $$;

-- A version of a manual-review type becomes 'published' only after an 'approved' release event whose actor is a real
-- reviewer (not 'auto', not NULL) and is NOT the actor who submitted or auto-published it. Direct SQL cannot skip this.
-- A type missing from the policy table is treated as manual review (fail closed).
CREATE FUNCTION marketplace_manual_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ltype text; needs boolean;
BEGIN
  IF NEW.state = 'published' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'published') THEN
    SELECT l.type INTO ltype FROM marketplace_listings l WHERE l.id = NEW.listing_id;
    SELECT p.manual_review INTO needs FROM marketplace_type_policy p WHERE p.type = ltype;
    IF needs IS NULL OR needs THEN
      IF NOT EXISTS (
        SELECT 1 FROM marketplace_release_events a
         WHERE a.version_id = NEW.id AND a.event = 'approved' AND a.actor IS NOT NULL AND a.actor <> 'auto'
           AND NOT EXISTS (SELECT 1 FROM marketplace_release_events s
                            WHERE s.version_id = NEW.id AND s.event IN ('submitted','published') AND s.actor IS NOT DISTINCT FROM a.actor)
      ) THEN
        RAISE EXCEPTION 'marketplace_versions: % needs manual review by someone other than its publisher before it can be published', NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_manual_review_guard BEFORE INSERT OR UPDATE OF state ON marketplace_versions
  FOR EACH ROW EXECUTE FUNCTION marketplace_manual_review_guard();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app')      THEN GRANT SELECT ON marketplace_type_policy TO ao_app; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin')    THEN GRANT SELECT ON marketplace_type_policy TO ao_admin; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN GRANT SELECT ON marketplace_type_policy TO ao_readonly; END IF;
END $$;
