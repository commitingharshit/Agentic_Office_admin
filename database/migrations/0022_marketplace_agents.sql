-- Marketplace Plan 2: team assignments (a team admin pins an exact published version for the team) and
-- org/team install policy (allow/deny rules). Role GRANT/POLICY statements are in the guarded section at
-- the end, so this file also loads into a database without the app roles (the PGlite schema test).
-- Nothing here stores credentials, prompts or documents: ids, versions, hashes and rule strings only.
-- RLS is enabled but not FORCEd (ao_app is never the owner; the SECURITY DEFINER functions rely on the
-- owner bypassing it), same as 0016.

-- ---------------------------------------------------------------------------------------------
-- Membership helpers for policies. marketplace_team_members is visible only as the caller's own rows,
-- so team-wide checks need a definer function. They answer only about the CALLER (app.user_id), for a
-- team id the caller names: no way to ask about another user, and a non-member just gets false.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION marketplace_is_team_member(p_team text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT nullif(current_setting('app.user_id', true), '') IS NOT NULL AND (
    EXISTS (SELECT 1 FROM marketplace_teams t WHERE t.id = p_team AND t.owner_user_id = current_setting('app.user_id', true))
    OR EXISTS (SELECT 1 FROM marketplace_team_members m WHERE m.team_id = p_team AND m.user_id = current_setting('app.user_id', true)))
$$;
CREATE FUNCTION marketplace_is_team_manager(p_team text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT nullif(current_setting('app.user_id', true), '') IS NOT NULL AND (
    EXISTS (SELECT 1 FROM marketplace_teams t WHERE t.id = p_team AND t.owner_user_id = current_setting('app.user_id', true))
    OR EXISTS (SELECT 1 FROM marketplace_team_members m WHERE m.team_id = p_team AND m.user_id = current_setting('app.user_id', true)
                 AND m.role IN ('owner', 'admin')))
$$;

-- ---------------------------------------------------------------------------------------------
-- Team assignments. The pin is always exact (version + artifact hash): no tracking ranges.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE marketplace_team_assignments (
  id             text PRIMARY KEY,
  team_id        text NOT NULL REFERENCES marketplace_teams(id) ON DELETE CASCADE,
  listing_id     text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version_id     text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  pinned_version text NOT NULL,
  pin_sha256     text NOT NULL CHECK (pin_sha256 ~ '^[0-9a-f]{64}$'),
  mode           text NOT NULL DEFAULT 'recommended' CHECK (mode IN ('required','recommended','optional')),
  assigned_by    text REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, listing_id)
);
CREATE INDEX ix_mkt_team_assignments_listing ON marketplace_team_assignments (listing_id);
CREATE INDEX ix_mkt_team_assignments_version ON marketplace_team_assignments (version_id);

-- SECURITY DEFINER on purpose: the check must see the real version/listing rows whatever the caller's RLS
-- shows, and must answer every failure with the SAME message, so a team admin cannot probe which version
-- ids or private listings exist (no existence oracle). Runs for ao_admin writes too (triggers always fire).
CREATE FUNCTION marketplace_team_assignments_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ok boolean;
BEGIN
  -- BEFORE triggers run ahead of the RLS WITH CHECK. For the app role, answer a non-manager with the RLS error
  -- first, so the pin checks below cannot be used as an existence oracle by someone who may not assign at all.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') AND pg_has_role(session_user, 'ao_app', 'member')
     AND NOT marketplace_is_team_manager(NEW.team_id) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "marketplace_team_assignments"' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
                           OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'marketplace_team_assignments: team, listing and assigner are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- A mode-only change stays possible after the pinned version was pulled (the team can still adjust or delete it).
  IF TG_OP = 'UPDATE' AND NEW.version_id IS NOT DISTINCT FROM OLD.version_id AND NEW.pinned_version IS NOT DISTINCT FROM OLD.pinned_version
     AND NEW.pin_sha256 IS NOT DISTINCT FROM OLD.pin_sha256 THEN
    RETURN NEW;
  END IF;
  SELECT true INTO ok
    FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
   WHERE v.id = NEW.version_id AND v.listing_id = NEW.listing_id
     AND v.version = NEW.pinned_version AND v.sha256 = NEW.pin_sha256
     AND v.state = 'published'
     AND l.type IN ('agent','bundle','skill','template')
     AND (l.visibility IN ('public','org') OR (l.visibility = 'team' AND l.team_id = NEW.team_id));
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'marketplace_team_assignments: the pinned version is not assignable to this team' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_team_assignments_guard BEFORE INSERT OR UPDATE ON marketplace_team_assignments
  FOR EACH ROW EXECUTE FUNCTION marketplace_team_assignments_guard();

-- What the caller's teams assigned and whether the pinned version has since been pulled (revoked or
-- quarantined), with the pull reason. Mirrors marketplace_installed_status(): the base tables hide pulled
-- versions from ao_app, so this definer function is the way an assignee finds out. It returns only the
-- caller's own teams' assignments (state + reason, never artifact data or other users' rows).
CREATE FUNCTION marketplace_assignment_status()
  RETURNS TABLE (assignment_id text, team_id text, listing_id text, version_id text, pinned_version text, mode text,
                 state text, blocked boolean, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.team_id, a.listing_id, a.version_id, a.pinned_version, a.mode, v.state,
         v.state IN ('quarantined','revoked'),
         (SELECT e.detail ->> 'reason' FROM marketplace_release_events e
           WHERE e.version_id = v.id AND e.event IN ('revoked','quarantined') ORDER BY e.at DESC, e.id DESC LIMIT 1)
    FROM marketplace_team_assignments a JOIN marketplace_versions v ON v.id = a.version_id
   WHERE marketplace_is_team_member(a.team_id)
$$;

-- ---------------------------------------------------------------------------------------------
-- Policy: one row per scope (the deployment-wide 'org' scope, or one per team) plus allow/deny rules.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE marketplace_policies (
  scope_kind         text NOT NULL CHECK (scope_kind IN ('org','team')),
  scope_id           text NOT NULL CHECK (scope_id <> '' AND (scope_kind <> 'org' OR scope_id = 'default')),
  mode               text NOT NULL DEFAULT 'open' CHECK (mode IN ('open','allowlist')),
  min_trust          text CHECK (min_trust IS NULL OR min_trust IN ('official','verified','community','private')),
  require_clean_scan boolean NOT NULL DEFAULT true,
  updated_by         text REFERENCES users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind, scope_id)
);
CREATE TABLE marketplace_policy_rules (
  id          text PRIMARY KEY,
  scope_kind  text NOT NULL,
  scope_id    text NOT NULL,
  effect      text NOT NULL CHECK (effect IN ('allow','deny')),
  match_kind  text NOT NULL CHECK (match_kind IN ('listing','publisher','type')),
  match_value text NOT NULL CHECK (
    (match_kind = 'listing'   AND match_value ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$') OR
    (match_kind = 'publisher' AND match_value ~ '^[a-z0-9][a-z0-9-]*$') OR
    (match_kind = 'type'      AND match_value IN ('template','skill','agent','memory','connector','bridge','surface','workflow','hook','routine','bundle'))),
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_kind, scope_id, effect, match_kind, match_value),
  FOREIGN KEY (scope_kind, scope_id) REFERENCES marketplace_policies(scope_kind, scope_id) ON DELETE CASCADE
);

-- A team-scope policy must name a real team (the RLS check already implies it for ao_app; this covers ao_admin).
CREATE FUNCTION marketplace_policies_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') AND pg_has_role(session_user, 'ao_app', 'member')
     AND NOT (NEW.scope_kind = 'team' AND marketplace_is_team_manager(NEW.scope_id)) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "marketplace_policies"' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
    RAISE EXCEPTION 'marketplace_policies: scope is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.scope_kind = 'team' AND NOT EXISTS (SELECT 1 FROM marketplace_teams t WHERE t.id = NEW.scope_id) THEN
    RAISE EXCEPTION 'marketplace_policies: unknown team' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_policies_guard BEFORE INSERT OR UPDATE ON marketplace_policies
  FOR EACH ROW EXECUTE FUNCTION marketplace_policies_guard();

-- At most 500 rules per scope (bounded policy documents; the desktop fetches the whole thing).
CREATE FUNCTION marketplace_policy_rules_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') AND pg_has_role(session_user, 'ao_app', 'member')
     AND NOT (NEW.scope_kind = 'team' AND marketplace_is_team_manager(NEW.scope_id)) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "marketplace_policy_rules"' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'marketplace_policy_rules: rules are replaced, not edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (SELECT count(*) FROM marketplace_policy_rules r WHERE r.scope_kind = NEW.scope_kind AND r.scope_id = NEW.scope_id) >= 500 THEN
    RAISE EXCEPTION 'marketplace_policy_rules: at most 500 rules per scope' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_policy_rules_guard BEFORE INSERT OR UPDATE ON marketplace_policy_rules
  FOR EACH ROW EXECUTE FUNCTION marketplace_policy_rules_guard();

-- The policy layers that apply to `uid`: the org layer (if any) first, then one layer per team the user
-- belongs to that has a policy. The merge (deny wins; allowlist layers each need an allow match; every
-- layer's trust/scan floor applies) is policy.ts evaluate(), so the API, the tests and the desktop share
-- one document. A caller may only ask about ITSELF: ao_app must pass its own app.user_id (no peeking at
-- another user's team policies); the admin pool, which has no app.user_id, may pass any uid.
CREATE FUNCTION marketplace_effective_policy(uid text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE caller text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF caller IS NOT NULL AND uid IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'marketplace_effective_policy: only for the calling user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF caller IS NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') AND pg_has_role(session_user, 'ao_app', 'member') THEN
    RAISE EXCEPTION 'marketplace_effective_policy: app.user_id is not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object('layers', coalesce((
    SELECT jsonb_agg(layer ORDER BY ord, sid) FROM (
      SELECT p.scope_kind AS kind, p.scope_id AS sid, CASE p.scope_kind WHEN 'org' THEN 0 ELSE 1 END AS ord,
             jsonb_build_object(
               'scopeKind', p.scope_kind, 'scopeId', p.scope_id, 'mode', p.mode, 'minTrust', p.min_trust,
               'requireCleanScan', p.require_clean_scan,
               'rules', coalesce((SELECT jsonb_agg(jsonb_build_object('effect', r.effect, 'matchKind', r.match_kind, 'matchValue', r.match_value)
                                                    ORDER BY r.effect, r.match_kind, r.match_value)
                                    FROM marketplace_policy_rules r WHERE r.scope_kind = p.scope_kind AND r.scope_id = p.scope_id), '[]'::jsonb)) AS layer
        FROM marketplace_policies p
       WHERE p.scope_kind = 'org'
          OR (p.scope_kind = 'team' AND (
                EXISTS (SELECT 1 FROM marketplace_teams t WHERE t.id = p.scope_id AND t.owner_user_id = uid)
                OR EXISTS (SELECT 1 FROM marketplace_team_members m WHERE m.team_id = p.scope_id AND m.user_id = uid)))
    ) s), '[]'::jsonb));
END $$;

-- Functions are executable by PUBLIC by default; none of these may be.
REVOKE EXECUTE ON FUNCTION marketplace_is_team_member(text), marketplace_is_team_manager(text),
  marketplace_team_assignments_guard(), marketplace_assignment_status(),
  marketplace_policies_guard(), marketplace_policy_rules_guard(), marketplace_effective_policy(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Roles, grants and row-level security. Guarded so the file loads where the roles do not exist.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN RETURN; END IF;

  -- Assignments: visible to the team's members; created, re-pinned and removed only by the team's owner/admin.
  -- (A listing the team cannot see, a stale hash or a non-published version is refused by the guard trigger.)
  ALTER TABLE marketplace_team_assignments ENABLE ROW LEVEL SECURITY;
  CREATE POLICY member_read ON marketplace_team_assignments FOR SELECT USING (marketplace_is_team_member(team_id));
  CREATE POLICY manager_insert ON marketplace_team_assignments FOR INSERT WITH CHECK (
    marketplace_is_team_manager(team_id) AND assigned_by = current_setting('app.user_id', true));
  CREATE POLICY manager_update ON marketplace_team_assignments FOR UPDATE USING (marketplace_is_team_manager(team_id))
    WITH CHECK (marketplace_is_team_manager(team_id));
  CREATE POLICY manager_delete ON marketplace_team_assignments FOR DELETE USING (marketplace_is_team_manager(team_id));

  -- Policies: the org layer is readable by every signed-in user (they must know what the deployment
  -- restricts) but written only by ao_admin (no ao_app policy or grant reaches it); a team layer is read by
  -- the team's members and written by its owner/admin.
  ALTER TABLE marketplace_policies ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_scope ON marketplace_policies FOR SELECT USING (
    scope_kind = 'org' OR (scope_kind = 'team' AND marketplace_is_team_member(scope_id)));
  CREATE POLICY team_manager_insert ON marketplace_policies FOR INSERT WITH CHECK (
    scope_kind = 'team' AND marketplace_is_team_manager(scope_id) AND updated_by = current_setting('app.user_id', true));
  CREATE POLICY team_manager_update ON marketplace_policies FOR UPDATE USING (
    scope_kind = 'team' AND marketplace_is_team_manager(scope_id))
    WITH CHECK (scope_kind = 'team' AND marketplace_is_team_manager(scope_id) AND updated_by = current_setting('app.user_id', true));
  CREATE POLICY team_manager_delete ON marketplace_policies FOR DELETE USING (
    scope_kind = 'team' AND marketplace_is_team_manager(scope_id));

  ALTER TABLE marketplace_policy_rules ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_scope ON marketplace_policy_rules FOR SELECT USING (
    scope_kind = 'org' OR (scope_kind = 'team' AND marketplace_is_team_member(scope_id)));
  CREATE POLICY team_manager_insert ON marketplace_policy_rules FOR INSERT WITH CHECK (
    scope_kind = 'team' AND marketplace_is_team_manager(scope_id) AND created_by = current_setting('app.user_id', true));
  CREATE POLICY team_manager_delete ON marketplace_policy_rules FOR DELETE USING (
    scope_kind = 'team' AND marketplace_is_team_manager(scope_id));

  -- Column-limited grants: identity columns of a row (team, listing, scope) can never be rewritten.
  GRANT SELECT ON marketplace_team_assignments, marketplace_policies, marketplace_policy_rules TO ao_app;
  GRANT INSERT (id, team_id, listing_id, version_id, pinned_version, pin_sha256, mode, assigned_by) ON marketplace_team_assignments TO ao_app;
  GRANT UPDATE (version_id, pinned_version, pin_sha256, mode) ON marketplace_team_assignments TO ao_app;
  GRANT DELETE ON marketplace_team_assignments TO ao_app;
  GRANT INSERT (scope_kind, scope_id, mode, min_trust, require_clean_scan, updated_by) ON marketplace_policies TO ao_app;
  GRANT UPDATE (mode, min_trust, require_clean_scan, updated_by) ON marketplace_policies TO ao_app;
  GRANT DELETE ON marketplace_policies TO ao_app;
  GRANT INSERT (id, scope_kind, scope_id, effect, match_kind, match_value, created_by) ON marketplace_policy_rules TO ao_app;
  GRANT DELETE ON marketplace_policy_rules TO ao_app;
  GRANT EXECUTE ON FUNCTION marketplace_is_team_member(text), marketplace_is_team_manager(text),
    marketplace_assignment_status(), marketplace_effective_policy(text) TO ao_app;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_team_assignments, marketplace_policies, marketplace_policy_rules TO ao_admin;
    GRANT EXECUTE ON FUNCTION marketplace_effective_policy(text) TO ao_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN
    GRANT SELECT ON marketplace_team_assignments, marketplace_policies, marketplace_policy_rules TO ao_readonly;
  END IF;
END $$;
