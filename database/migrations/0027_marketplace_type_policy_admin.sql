-- Marketplace Plan 3, Task 12: a superadmin may RAISE a type's policy (stricter risk tier, manual review on, higher minimum publisher
-- trust) through the admin API. The code floor (TYPE_POLICY in src/marketplace/support.ts) is authoritative; this migration adds a database
-- backstop so that not even a bug in the handler can store a value below the floor recorded here, and so the floor itself cannot be edited.
-- Depends on 0018_marketplace_advanced.sql. (Number allocated by the controller; renumber at merge time if it clashes.)

ALTER TABLE marketplace_type_policy
  ADD COLUMN floor_risk_tier           text,
  ADD COLUMN floor_manual_review       boolean,
  ADD COLUMN floor_min_publisher_trust text,
  ADD COLUMN updated_by                text,
  ADD COLUMN updated_at                timestamptz;
UPDATE marketplace_type_policy SET floor_risk_tier = risk_tier, floor_manual_review = manual_review, floor_min_publisher_trust = min_publisher_trust;
ALTER TABLE marketplace_type_policy
  ALTER COLUMN floor_risk_tier SET NOT NULL, ALTER COLUMN floor_manual_review SET NOT NULL, ALTER COLUMN floor_min_publisher_trust SET NOT NULL,
  ADD CONSTRAINT marketplace_type_policy_floor_tier CHECK (floor_risk_tier IN ('data','declarative','executable')),
  ADD CONSTRAINT marketplace_type_policy_floor_trust CHECK (floor_min_publisher_trust IN ('official','verified','community','private'));

CREATE FUNCTION marketplace_type_policy_floor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tier_rank  CONSTANT jsonb := '{"data":0,"declarative":1,"executable":2}';
  trust_rank CONSTANT jsonb := '{"private":0,"community":1,"verified":2,"official":3}';
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.floor_risk_tier IS DISTINCT FROM OLD.floor_risk_tier
     OR NEW.floor_manual_review IS DISTINCT FROM OLD.floor_manual_review OR NEW.floor_min_publisher_trust IS DISTINCT FROM OLD.floor_min_publisher_trust THEN
    RAISE EXCEPTION 'marketplace_type_policy: the floor of % cannot be changed', OLD.type USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (tier_rank ->> NEW.risk_tier)::int < (tier_rank ->> NEW.floor_risk_tier)::int
     OR (NEW.floor_manual_review AND NOT NEW.manual_review)
     OR (trust_rank ->> NEW.min_publisher_trust)::int < (trust_rank ->> NEW.floor_min_publisher_trust)::int THEN
    RAISE EXCEPTION 'marketplace_type_policy: % cannot be set below its floor', NEW.type USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_type_policy_floor BEFORE UPDATE ON marketplace_type_policy FOR EACH ROW EXECUTE FUNCTION marketplace_type_policy_floor_guard();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT UPDATE (risk_tier, manual_review, min_publisher_trust, updated_by, updated_at) ON marketplace_type_policy TO ao_admin;
  END IF;
END $$;
