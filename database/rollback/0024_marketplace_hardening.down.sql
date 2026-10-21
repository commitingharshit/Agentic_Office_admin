-- ROLLBACK for 0024_marketplace_hardening.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0024_marketplace_hardening.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
-- restore the 0023 body of the versions guard (CREATE OR REPLACE replaced it wholesale)
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
DROP TRIGGER IF EXISTS trg_mkt_listings_touch ON marketplace_listings;
DROP TRIGGER IF EXISTS trg_mkt_reviews_touch ON marketplace_reviews;
DROP TRIGGER IF EXISTS trg_mkt_installs_touch ON marketplace_installs;
DROP FUNCTION IF EXISTS marketplace_touch_updated_at();
DROP TRIGGER IF EXISTS trg_mkt_artifacts_guard ON marketplace_artifacts;
DROP FUNCTION IF EXISTS marketplace_artifacts_guard();
-- the installs INSERT grant of 0024 is a column list; 0021 granted whole-table INSERT
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN
  REVOKE INSERT ON marketplace_installs FROM ao_app; GRANT INSERT ON marketplace_installs TO ao_app; END IF; END $$;
-- (0024 also added CHECK constraints and indexes in sections 2 and 3; they are additive and harmless to leave, listed in 0024_marketplace_hardening.sql)
COMMIT;
