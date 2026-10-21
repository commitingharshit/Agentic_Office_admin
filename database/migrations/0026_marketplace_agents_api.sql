-- Marketplace Plan 2, Task 7: the pieces the agent/bundle/team API needs beyond 0017.
--   1. marketplace_dependency_status(): lets a device find out that a dependency of something it installed (an agent's skill, a
--      bundle's member) was pulled, although the base tables hide pulled versions from ao_app.
--   2. marketplace_team_audit: an append-only record of every team-level mutation (assign, re-pin, unassign, policy change).
--      Team owners and admins are not platform admins, so admin_audit is not theirs to write; this table is.
--   3. marketplace_elevated_review_guard(): a database backstop so an agent or bundle whose risk tier is `executable` cannot be
--      published without a recorded approval by someone other than its submitter. A NEW function and trigger: the existing
--      marketplace_manual_review_guard() and the versions guard of 0016/0018/0019 are untouched (see marketplace-migrations-compose.test.ts).
-- Nothing here stores credentials, prompts or documents.

-- ---------------------------------------------------------------------------------------------
-- 1. Dependency status of the caller's own installs.
--    Returns, for up to 200 version ids the CALLER has installed, each dependency edge with every version of the dependency
--    listing that is (or was) public-facing, with its state and pull reason. Only states and versions: never artifact data.
--    A version id the caller did not install yields no rows (no probing of other users' installs or of private listings).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION marketplace_dependency_status(p_version_ids text[])
  RETURNS TABLE (version_id text, dep_listing text, dep_range text, dep_version_id text, dep_version text, dep_state text, reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF coalesce(array_length(p_version_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'marketplace_dependency_status: at most 200 ids' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF nullif(current_setting('app.user_id', true), '') IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT d.version_id, d.depends_on_listing, d.range, dv.id, dv.version, dv.state,
         (SELECT e.detail ->> 'reason' FROM marketplace_release_events e
           WHERE e.version_id = dv.id AND e.event IN ('revoked','quarantined') ORDER BY e.at DESC, e.id DESC LIMIT 1)
    FROM marketplace_dependencies d
    JOIN marketplace_versions dv ON dv.listing_id = d.depends_on_listing AND dv.state IN ('published','deprecated','quarantined','revoked')
   WHERE d.version_id = ANY(p_version_ids)
     AND EXISTS (SELECT 1 FROM marketplace_installs i WHERE i.version_id = d.version_id AND i.user_id = current_setting('app.user_id', true))
   ORDER BY d.version_id, d.depends_on_listing, dv.semver_major DESC, dv.semver_minor DESC, dv.semver_patch DESC
   LIMIT 4000;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Team audit trail (append only).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE marketplace_team_audit (
  id       bigserial PRIMARY KEY,
  team_id  text NOT NULL,                                  -- no FK on purpose: the trail outlives the team
  actor    text NOT NULL,
  action   text NOT NULL CHECK (action IN ('assign','reassign','unassign','policy_set','policy_clear')),
  detail   jsonb NOT NULL DEFAULT '{}' CHECK (length(detail::text) <= 8000),
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_team_audit_team ON marketplace_team_audit (team_id, at DESC);
CREATE TRIGGER trg_mkt_team_audit_append_only BEFORE UPDATE OR DELETE ON marketplace_team_audit
  FOR EACH ROW EXECUTE FUNCTION marketplace_append_only();

-- ---------------------------------------------------------------------------------------------
-- 3. Elevated agents and bundles need a reviewer other than the submitter before they can be published.
--    Same rule as marketplace_manual_review_guard() (0018), for the types whose manual-review need depends on the tier.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION marketplace_elevated_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ltype text;
BEGIN
  IF NEW.state = 'published' AND NEW.risk_tier = 'executable' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'published') THEN
    SELECT l.type INTO ltype FROM marketplace_listings l WHERE l.id = NEW.listing_id;
    IF ltype IN ('agent','bundle') AND NOT EXISTS (
        SELECT 1 FROM marketplace_release_events a
         WHERE a.version_id = NEW.id AND a.event = 'approved' AND a.actor IS NOT NULL AND a.actor <> 'auto'
           AND NOT EXISTS (SELECT 1 FROM marketplace_release_events s
                            WHERE s.version_id = NEW.id AND s.event IN ('submitted','published') AND s.actor IS NOT DISTINCT FROM a.actor)
    ) THEN
      RAISE EXCEPTION 'marketplace_versions: % is an elevated % and needs manual review by someone other than its publisher before it can be published', NEW.id, ltype
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_elevated_review_guard BEFORE INSERT OR UPDATE OF state ON marketplace_versions
  FOR EACH ROW EXECUTE FUNCTION marketplace_elevated_review_guard();

REVOKE EXECUTE ON FUNCTION marketplace_dependency_status(text[]), marketplace_elevated_review_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Roles, grants and row-level security (guarded so the file loads where the roles do not exist).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN RETURN; END IF;
  -- The trail is readable by the team's owner/admin and written only by them, as themselves.
  ALTER TABLE marketplace_team_audit ENABLE ROW LEVEL SECURITY;
  CREATE POLICY manager_read ON marketplace_team_audit FOR SELECT USING (marketplace_is_team_manager(team_id));
  CREATE POLICY manager_insert ON marketplace_team_audit FOR INSERT WITH CHECK (
    marketplace_is_team_manager(team_id) AND actor = current_setting('app.user_id', true));
  GRANT SELECT ON marketplace_team_audit TO ao_app;
  GRANT INSERT (team_id, actor, action, detail) ON marketplace_team_audit TO ao_app;
  GRANT USAGE ON SEQUENCE marketplace_team_audit_id_seq TO ao_app;
  GRANT EXECUTE ON FUNCTION marketplace_dependency_status(text[]) TO ao_app;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT SELECT ON marketplace_team_audit TO ao_admin;
    GRANT USAGE ON SEQUENCE marketplace_team_audit_id_seq TO ao_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN
    GRANT SELECT ON marketplace_team_audit TO ao_readonly;
  END IF;
END $$;
