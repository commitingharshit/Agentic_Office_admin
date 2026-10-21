-- Marketplace server hardening backlog (Plan 4 Task 10). 0016 is not edited in place: this replaces the versions guard
-- and adds the small DB-level backstops the Plan 1 reviews deferred.

-- 1. marketplace_versions_guard: a pulled version stays pulled.
--    * revoked is terminal (the API's transition() lists no action out of it);
--    * quarantined can only become revoked (the API's only action from quarantined);
--    * a not-yet-locked version cannot reach a locked state in the same statement that edits its content
--      (draft -> deprecated + new manifest used to slip past the immutability check).
CREATE OR REPLACE FUNCTION marketplace_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    locked := OLD.published_at IS NOT NULL OR OLD.state IN ('published','deprecated','quarantined','revoked');
    IF OLD.state = 'revoked' AND NEW.state IS DISTINCT FROM 'revoked' THEN
      RAISE EXCEPTION 'marketplace_versions: revoked version % is terminal (cannot become %)', OLD.id, NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.state = 'quarantined' AND NEW.state NOT IN ('quarantined','revoked') THEN
      RAISE EXCEPTION 'marketplace_versions: quarantined version % can only be revoked (cannot become %)', OLD.id, NEW.state USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF locked OR NEW.state IN ('published','deprecated','quarantined','revoked') THEN
      IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.manifest IS DISTINCT FROM OLD.manifest OR
         NEW.version IS DISTINCT FROM OLD.version OR NEW.listing_id IS DISTINCT FROM OLD.listing_id OR
         NEW.size IS DISTINCT FROM OLD.size OR NEW.compat IS DISTINCT FROM OLD.compat THEN
        RAISE EXCEPTION 'marketplace_versions: published version % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    IF locked THEN
      IF NEW.state IN ('draft','validating','testing','submitted','in_review','approved','rejected') THEN
        RAISE EXCEPTION 'marketplace_versions: published version % is immutable (cannot return to %)', OLD.id, NEW.state USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF NEW.published_at IS DISTINCT FROM OLD.published_at AND OLD.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'marketplace_versions: published_at of % is immutable', OLD.id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
  -- Backstop for the API check: a version only becomes approved/published with a passing scan verdict (clean or warnings).
  IF TG_OP = 'UPDATE' AND NEW.state IN ('approved','published') AND NEW.state IS DISTINCT FROM OLD.state AND NEW.scan_verdict NOT IN ('clean','warnings') THEN
    RAISE EXCEPTION 'marketplace_versions: % cannot become % with scan verdict %', OLD.id, NEW.state, NEW.scan_verdict USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'published' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
  RETURN NEW;
END $$;

-- 2. updated_at is maintained by the database, not trusted from the writer.
CREATE FUNCTION marketplace_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
REVOKE EXECUTE ON FUNCTION marketplace_touch_updated_at() FROM PUBLIC;
CREATE TRIGGER trg_mkt_listings_touch  BEFORE UPDATE ON marketplace_listings  FOR EACH ROW EXECUTE FUNCTION marketplace_touch_updated_at();
CREATE TRIGGER trg_mkt_reviews_touch   BEFORE UPDATE ON marketplace_reviews   FOR EACH ROW EXECUTE FUNCTION marketplace_touch_updated_at();
CREATE TRIGGER trg_mkt_installs_touch  BEFORE UPDATE ON marketplace_installs  FOR EACH ROW EXECUTE FUNCTION marketplace_touch_updated_at();

-- 3. An artifact row that a published version points at never changes where or how big it is.
CREATE FUNCTION marketplace_artifacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.size IS DISTINCT FROM OLD.size OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.sha256 IS DISTINCT FROM OLD.sha256)
     AND EXISTS (SELECT 1 FROM marketplace_versions v WHERE v.sha256 = OLD.sha256 AND v.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'marketplace_artifacts: artifact % is referenced by a published version and is immutable', OLD.sha256 USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION marketplace_artifacts_guard() FROM PUBLIC;
CREATE TRIGGER trg_mkt_artifacts_guard BEFORE UPDATE ON marketplace_artifacts FOR EACH ROW EXECUTE FUNCTION marketplace_artifacts_guard();

-- 4. installs INSERT: a column list like every other table (installed_at and updated_at are server-set).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN
    REVOKE INSERT ON marketplace_installs FROM ao_app;
    GRANT INSERT (id, user_id, device_id, listing_id, version_id, state, scope, enabled, scan_verdict, last_error) ON marketplace_installs TO ao_app;
  END IF;
END $$;

-- Not done in SQL, on purpose: the "versions INSERT sha256 FK-existence oracle". The sha256 is the hash of the artifact bytes,
-- so a caller who can name an existing one already holds the bytes; the API always stores the artifact before inserting the version.
