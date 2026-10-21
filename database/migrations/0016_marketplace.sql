-- Extension marketplace: catalog, versions, artifacts, submissions, reviews, favorites, installs and
-- their audit trails. Ids are text (usr_<ulid>, 'publisher/slug' for listings). Derived numbers
-- (rating average/count, favorites, installs) are never stored: see marketplace_listing_stats.
-- Role GRANT/POLICY statements are in the guarded section at the end, so this file also loads into
-- a database that has none of the app roles (the PGlite schema test).
-- RLS is enabled but not FORCEd on these tables: ao_app is never the owner, and the SECURITY DEFINER
-- functions below rely on the owner bypassing it.

CREATE TABLE marketplace_publishers (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  display_name   text NOT NULL,
  owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_publishers_owner ON marketplace_publishers (owner_user_id);

CREATE TABLE marketplace_teams (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketplace_team_members (
  team_id     text NOT NULL REFERENCES marketplace_teams(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX ix_mkt_team_members_user ON marketplace_team_members (user_id);

CREATE TABLE marketplace_listings (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'),   -- publisher/slug
  type           text NOT NULL CHECK (type IN ('template','skill','agent','memory','connector','bridge','surface','workflow','hook','routine','bundle')),
  publisher_id   text NOT NULL REFERENCES marketplace_publishers(id),
  owner_user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visibility     text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','org','team','private')),
  team_id        text REFERENCES marketplace_teams(id) ON DELETE RESTRICT,   -- a team with listings cannot be deleted
  trust          text NOT NULL DEFAULT 'community' CHECK (trust IN ('official','verified','community','private')),
  title          text NOT NULL,
  summary        text NOT NULL DEFAULT '',
  tags           text[] NOT NULL DEFAULT '{}',
  forked_from    text REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  search         tsvector,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility <> 'team' OR team_id IS NOT NULL),
  CHECK (split_part(id, '/', 1) = publisher_id)
);
CREATE INDEX ix_mkt_listings_search ON marketplace_listings USING gin (search);
CREATE INDEX ix_mkt_listings_type ON marketplace_listings (type, visibility);
CREATE INDEX ix_mkt_listings_owner ON marketplace_listings (owner_user_id);
CREATE INDEX ix_mkt_listings_tags ON marketplace_listings USING gin (tags);
CREATE INDEX ix_mkt_listings_publisher ON marketplace_listings (publisher_id);
CREATE INDEX ix_mkt_listings_team ON marketplace_listings (team_id);
CREATE INDEX ix_mkt_listings_forked ON marketplace_listings (forked_from);

-- array_to_string is not immutable, so a generated column is not allowed: a trigger maintains it.
CREATE FUNCTION marketplace_listings_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_listings_search BEFORE INSERT OR UPDATE OF title, summary, tags ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION marketplace_listings_search_update();

CREATE TABLE marketplace_artifacts (
  sha256       text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size         bigint NOT NULL CHECK (size >= 0),
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketplace_versions (
  id            text PRIMARY KEY,
  listing_id    text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version       text NOT NULL,
  semver_major  int NOT NULL CHECK (semver_major >= 0),
  semver_minor  int NOT NULL CHECK (semver_minor >= 0),
  semver_patch  int NOT NULL CHECK (semver_patch >= 0),
  state         text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','validating','testing','submitted','in_review','approved','published','rejected','deprecated','quarantined','revoked')),
  manifest      jsonb NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$') REFERENCES marketplace_artifacts(sha256),
  size          bigint NOT NULL CHECK (size >= 0),
  compat        jsonb NOT NULL DEFAULT '{}',
  scan_verdict  text NOT NULL DEFAULT 'pending' CHECK (scan_verdict IN ('pending','clean','warnings','blocked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  UNIQUE (listing_id, version)
);
CREATE INDEX ix_mkt_versions_listing ON marketplace_versions (listing_id, semver_major DESC, semver_minor DESC, semver_patch DESC);
CREATE INDEX ix_mkt_versions_sha ON marketplace_versions (sha256);

-- A fork records the upstream version it was taken from and that version's artifact hash, so "compare with
-- upstream" and "upstream has a newer version" still work after the upstream moves on. (These columns are
-- added here because marketplace_versions did not exist yet when marketplace_listings was created.)
ALTER TABLE marketplace_listings
  ADD COLUMN forked_from_version text REFERENCES marketplace_versions(id) ON DELETE SET NULL,
  ADD COLUMN forked_base_sha256  text CHECK (forked_base_sha256 IS NULL OR forked_base_sha256 ~ '^[0-9a-f]{64}$');

-- A version that has been published is what people installed and what was scanned: its content never
-- changes, not even after it is deprecated, quarantined or revoked, and it never goes back to a
-- pre-publication state. published_at is set the first time the state becomes 'published' and cannot
-- be cleared or moved.
CREATE FUNCTION marketplace_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    locked := OLD.published_at IS NOT NULL OR OLD.state IN ('published','deprecated','quarantined','revoked');
    IF locked THEN
      IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.manifest IS DISTINCT FROM OLD.manifest OR
         NEW.version IS DISTINCT FROM OLD.version OR NEW.listing_id IS DISTINCT FROM OLD.listing_id OR
         NEW.size IS DISTINCT FROM OLD.size OR NEW.compat IS DISTINCT FROM OLD.compat THEN
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
  -- Backstop for the API check: a version only becomes approved/published with a passing scan verdict (clean or warnings).
  IF TG_OP = 'UPDATE' AND NEW.state IN ('approved','published') AND NEW.state IS DISTINCT FROM OLD.state AND NEW.scan_verdict NOT IN ('clean','warnings') THEN
    RAISE EXCEPTION 'marketplace_versions: % cannot become % with scan verdict %', OLD.id, NEW.state, NEW.scan_verdict USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state = 'published' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_versions_guard BEFORE INSERT OR UPDATE ON marketplace_versions
  FOR EACH ROW EXECUTE FUNCTION marketplace_versions_guard();

CREATE TABLE marketplace_dependencies (
  version_id         text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  depends_on_listing text NOT NULL,                 -- may name a listing that is not (yet) in the catalog
  range              text NOT NULL,                 -- semver range
  PRIMARY KEY (version_id, depends_on_listing)
);

CREATE INDEX ix_mkt_dependencies_target ON marketplace_dependencies (depends_on_listing);

CREATE TABLE marketplace_submissions (
  id            text PRIMARY KEY,
  version_id    text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  submitted_by  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted','in_review','approved','rejected','withdrawn')),
  reviewer_id   text REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX ix_mkt_submissions_state ON marketplace_submissions (state, created_at);
CREATE INDEX ix_mkt_submissions_version ON marketplace_submissions (version_id);

CREATE TABLE marketplace_reviews (
  id          text PRIMARY KEY,
  listing_id  text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars       int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, user_id)
);
CREATE INDEX ix_mkt_reviews_user ON marketplace_reviews (user_id);

CREATE TABLE marketplace_favorites (
  listing_id  text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, user_id)
);
CREATE INDEX ix_mkt_favorites_user ON marketplace_favorites (user_id);

CREATE TABLE marketplace_installs (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  listing_id    text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version_id    text REFERENCES marketplace_versions(id),
  state         text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','permission_review','installed','configured','enabled','disabled','update_available','failed','uninstalled')),
  scope         text NOT NULL DEFAULT 'user' CHECK (scope IN ('user','team','device')),
  enabled       boolean NOT NULL DEFAULT false,
  scan_verdict  text CHECK (scan_verdict IN ('pending','clean','warnings','blocked')),
  last_error    text,
  installed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id, listing_id)
);
CREATE INDEX ix_mkt_installs_listing ON marketplace_installs (listing_id, state);
CREATE INDEX ix_mkt_installs_device ON marketplace_installs (device_id);
CREATE INDEX ix_mkt_installs_version ON marketplace_installs (version_id);

-- Moving an install onto another version requires that version to belong to the same listing and be
-- visible to the caller (SECURITY INVOKER, so the caller's RLS applies to the lookup).
CREATE FUNCTION marketplace_installs_version_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version_id IS NOT NULL AND NEW.version_id IS DISTINCT FROM OLD.version_id AND NOT EXISTS (
       SELECT 1 FROM marketplace_versions v WHERE v.id = NEW.version_id AND v.listing_id = NEW.listing_id) THEN
    RAISE EXCEPTION 'marketplace_installs: version % is not an available version of %', NEW.version_id, NEW.listing_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_mkt_installs_version BEFORE UPDATE OF version_id ON marketplace_installs
  FOR EACH ROW EXECUTE FUNCTION marketplace_installs_version_check();

-- Append-only audit trail. Deliberately no foreign keys: a cascade from users/listings would fire the
-- append-only trigger and block erasure, and history must not be rewritten. user_id is therefore
-- unvalidated text by design.
CREATE TABLE marketplace_install_events (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  device_id   text,
  listing_id  text NOT NULL,
  version_id  text,
  event       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_install_events_user ON marketplace_install_events (user_id, at DESC);
CREATE INDEX ix_mkt_install_events_listing ON marketplace_install_events (listing_id, at DESC);
CREATE FUNCTION marketplace_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER trg_mkt_install_events_append_only BEFORE UPDATE OR DELETE ON marketplace_install_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_append_only();

CREATE TABLE marketplace_usage_events (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id  text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  version_id  text REFERENCES marketplace_versions(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_usage_listing ON marketplace_usage_events (listing_id, at DESC);
CREATE INDEX ix_mkt_usage_user ON marketplace_usage_events (user_id);

CREATE TABLE marketplace_collections (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  summary     text NOT NULL DEFAULT '',
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketplace_collection_items (
  collection_id  text NOT NULL REFERENCES marketplace_collections(id) ON DELETE CASCADE,
  listing_id     text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  position       int NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, listing_id)
);

CREATE INDEX ix_mkt_collection_items_listing ON marketplace_collection_items (listing_id);

CREATE TABLE marketplace_security_scans (
  id          text PRIMARY KEY,
  version_id  text NOT NULL REFERENCES marketplace_versions(id) ON DELETE CASCADE,
  scanner     text NOT NULL,
  verdict     text NOT NULL CHECK (verdict IN ('pending','clean','warnings','blocked')),
  findings    jsonb NOT NULL DEFAULT '[]',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_scans_version ON marketplace_security_scans (version_id, at DESC);

CREATE TABLE marketplace_reports (
  id                text PRIMARY KEY,
  listing_id        text NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  reporter_user_id  text REFERENCES users(id) ON DELETE SET NULL,
  version_id        text REFERENCES marketplace_versions(id) ON DELETE SET NULL,
  reason            text NOT NULL CHECK (reason IN ('malware','copyright','broken','misleading','other')),
  details           text CHECK (length(details) <= 2000),
  state             text NOT NULL DEFAULT 'open' CHECK (state IN ('open','triaged','actioned','dismissed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  UNIQUE (reporter_user_id, listing_id, reason)   -- one report per reporter, listing and reason; a repeat is a no-op
);
CREATE INDEX ix_mkt_reports_state ON marketplace_reports (state, created_at);
CREATE INDEX ix_mkt_reports_listing ON marketplace_reports (listing_id);

-- Release / revocation history. Append-only, no foreign keys (same reasoning as install events).
CREATE TABLE marketplace_release_events (
  id          bigserial PRIMARY KEY,
  listing_id  text NOT NULL,
  version_id  text,
  event       text NOT NULL,              -- published | deprecated | quarantined | revoked | restored
  actor       text,
  detail      jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_mkt_release_events_listing ON marketplace_release_events (listing_id, at DESC);
CREATE TRIGGER trg_mkt_release_events_append_only BEFORE UPDATE OR DELETE ON marketplace_release_events
  FOR EACH ROW EXECUTE FUNCTION marketplace_append_only();

-- Favorite and install counts are maintained by SECURITY DEFINER triggers into a table with no RLS, so
-- they are right no matter whose rows the reader can see. Ratings are computed from review rows (a
-- public-read policy covers visible listings).
CREATE TABLE marketplace_listing_counters (
  listing_id      text PRIMARY KEY REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  favorite_count  int NOT NULL DEFAULT 0 CHECK (favorite_count >= 0),
  install_count   int NOT NULL DEFAULT 0 CHECK (install_count >= 0)
);
CREATE FUNCTION marketplace_bump(p_listing text, p_fav int, p_inst int) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO marketplace_listing_counters(listing_id, favorite_count, install_count)
    VALUES (p_listing, greatest(p_fav, 0), greatest(p_inst, 0))
  ON CONFLICT (listing_id) DO UPDATE SET
    favorite_count = greatest(marketplace_listing_counters.favorite_count + p_fav, 0),
    install_count  = greatest(marketplace_listing_counters.install_count + p_inst, 0)
$$;
CREATE FUNCTION marketplace_count_favorites() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('INSERT') THEN PERFORM marketplace_bump(NEW.listing_id, 1, 0); END IF;
  IF TG_OP IN ('DELETE') THEN PERFORM marketplace_bump(OLD.listing_id, -1, 0); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_mkt_favorites_count AFTER INSERT OR DELETE ON marketplace_favorites
  FOR EACH ROW EXECUTE FUNCTION marketplace_count_favorites();
CREATE FUNCTION marketplace_count_installs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE live text[] := ARRAY['installed','configured','enabled','disabled','update_available'];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.state = ANY (live) THEN PERFORM marketplace_bump(OLD.listing_id, 0, -1); END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.state = ANY (live) THEN PERFORM marketplace_bump(NEW.listing_id, 0, 1); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_mkt_installs_count AFTER INSERT OR UPDATE OR DELETE ON marketplace_installs
  FOR EACH ROW EXECUTE FUNCTION marketplace_count_installs();

-- security_invoker: the caller's RLS decides which listings appear. No reviews: count 0, average NULL.
CREATE VIEW marketplace_listing_stats WITH (security_invoker = true) AS
  SELECT l.id AS listing_id,
         (SELECT count(*) FROM marketplace_reviews r WHERE r.listing_id = l.id) AS rating_count,
         (SELECT round(avg(r.stars)::numeric, 2) FROM marketplace_reviews r WHERE r.listing_id = l.id) AS rating_avg,
         coalesce(c.favorite_count, 0) AS favorite_count,
         coalesce(c.install_count, 0) AS install_count
  FROM marketplace_listings l LEFT JOIN marketplace_listing_counters c ON c.listing_id = l.id;

-- The caller's own installs, including versions that were revoked or quarantined (which the catalog
-- policies hide from ao_app), so the client can find out an installed version was pulled and why.
CREATE FUNCTION marketplace_installed_status()
  RETURNS TABLE (listing_id text, version_id text, version text, state text, reason text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.listing_id, i.version_id, v.version, v.state,
         (SELECT e.detail ->> 'reason' FROM marketplace_release_events e
           WHERE e.version_id = v.id AND e.event IN ('revoked','quarantined')
           ORDER BY e.at DESC, e.id DESC LIMIT 1)
  FROM marketplace_installs i JOIN marketplace_versions v ON v.id = i.version_id AND v.listing_id = i.listing_id
  WHERE i.user_id = current_setting('app.user_id', true)
$$;

-- Functions are executable by PUBLIC by default. The SECURITY DEFINER ones must not be: anyone able to
-- call marketplace_bump() could forge counters. Trigger functions need no EXECUTE grant to fire.
REVOKE EXECUTE ON FUNCTION marketplace_bump(text, int, int), marketplace_count_favorites(),
  marketplace_count_installs(), marketplace_installed_status(), marketplace_versions_guard(),
  marketplace_listings_search_update(), marketplace_append_only(), marketplace_installs_version_check() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Roles, grants and row-level security. Guarded so the file loads where the roles do not exist.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN RETURN; END IF;

  -- Per-user tables: a user sees and writes only their own rows (app.user_id set per request).
  FOREACH t IN ARRAY ARRAY['marketplace_usage_events','marketplace_install_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                     WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;

  -- Teams and membership: visible to members.
  ALTER TABLE marketplace_team_members ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_rows ON marketplace_team_members USING (user_id = current_setting('app.user_id', true));
  ALTER TABLE marketplace_teams ENABLE ROW LEVEL SECURITY;
  CREATE POLICY member_read ON marketplace_teams FOR SELECT USING (
    owner_user_id = current_setting('app.user_id', true)
    OR id IN (SELECT team_id FROM marketplace_team_members));

  -- Listings: public ones are readable by everyone, the rest by owner or team members.
  -- visibility 'org' is owner-only for now; the org policy is Plan 2.
  -- A user can only create listings under a publisher they own, and (by column grant) cannot set trust.
  ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY visible ON marketplace_listings FOR SELECT USING (
    visibility = 'public'
    OR owner_user_id = current_setting('app.user_id', true)
    OR (visibility = 'team' AND team_id IN (SELECT team_id FROM marketplace_team_members)));
  CREATE POLICY owner_insert ON marketplace_listings FOR INSERT WITH CHECK (
    owner_user_id = current_setting('app.user_id', true)
    AND publisher_id IN (SELECT id FROM marketplace_publishers WHERE owner_user_id = current_setting('app.user_id', true))
    AND (team_id IS NULL OR team_id IN (SELECT team_id FROM marketplace_team_members)));
  CREATE POLICY owner_update ON marketplace_listings FOR UPDATE USING (owner_user_id = current_setting('app.user_id', true))
    WITH CHECK (owner_user_id = current_setting('app.user_id', true)
                AND (team_id IS NULL OR team_id IN (SELECT team_id FROM marketplace_team_members)));

  -- Versions: everyone sees published/deprecated versions of listings they can see; the owner sees all
  -- of their own. Owners create drafts and may move a draft to 'submitted'; every later state is set
  -- by ao_admin. (Revoked/quarantined versions reach installers through marketplace_installed_status().)
  ALTER TABLE marketplace_versions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY visible ON marketplace_versions FOR SELECT USING (
    listing_id IN (SELECT id FROM marketplace_listings)
    AND (state IN ('published','deprecated')
         OR listing_id IN (SELECT id FROM marketplace_listings WHERE owner_user_id = current_setting('app.user_id', true))));
  CREATE POLICY owner_insert ON marketplace_versions FOR INSERT WITH CHECK (
    state = 'draft' AND scan_verdict = 'pending' AND published_at IS NULL
    AND listing_id IN (SELECT id FROM marketplace_listings WHERE owner_user_id = current_setting('app.user_id', true)));
  CREATE POLICY owner_update ON marketplace_versions FOR UPDATE USING (
    state = 'draft'
    AND listing_id IN (SELECT id FROM marketplace_listings WHERE owner_user_id = current_setting('app.user_id', true)))
    WITH CHECK (state IN ('draft','submitted') AND scan_verdict = 'pending' AND published_at IS NULL);

  ALTER TABLE marketplace_dependencies ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_visible ON marketplace_dependencies FOR SELECT USING (version_id IN (SELECT id FROM marketplace_versions));
  CREATE POLICY owner_write ON marketplace_dependencies FOR INSERT WITH CHECK (
    version_id IN (SELECT v.id FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
                    WHERE v.state = 'draft' AND l.owner_user_id = current_setting('app.user_id', true)));
  CREATE POLICY owner_delete ON marketplace_dependencies FOR DELETE USING (
    version_id IN (SELECT v.id FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
                    WHERE v.state = 'draft' AND l.owner_user_id = current_setting('app.user_id', true)));

  -- Submissions: read by the submitter or the listing owner; insert only for your own version.
  ALTER TABLE marketplace_submissions ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_own ON marketplace_submissions FOR SELECT USING (
    submitted_by = current_setting('app.user_id', true)
    OR version_id IN (SELECT v.id FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
                       WHERE l.owner_user_id = current_setting('app.user_id', true)));
  CREATE POLICY insert_own ON marketplace_submissions FOR INSERT WITH CHECK (
    submitted_by = current_setting('app.user_id', true) AND state = 'submitted'
    AND version_id IN (SELECT v.id FROM marketplace_versions v JOIN marketplace_listings l ON l.id = v.listing_id
                        WHERE l.owner_user_id = current_setting('app.user_id', true)));

  -- Reports: you can file one and read your own.
  ALTER TABLE marketplace_reports ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_rows ON marketplace_reports FOR SELECT USING (reporter_user_id = current_setting('app.user_id', true));
  CREATE POLICY file_own ON marketplace_reports FOR INSERT WITH CHECK (
    reporter_user_id = current_setting('app.user_id', true) AND state = 'open'
    AND listing_id IN (SELECT id FROM marketplace_listings));

  -- Security scans: readable when the version (hence the listing) is visible. ao_app never writes them.
  ALTER TABLE marketplace_security_scans ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_visible ON marketplace_security_scans FOR SELECT USING (version_id IN (SELECT id FROM marketplace_versions));

  -- Reviews: readable for visible listings, written only by the author.
  ALTER TABLE marketplace_reviews ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_visible ON marketplace_reviews FOR SELECT USING (listing_id IN (SELECT id FROM marketplace_listings));
  CREATE POLICY own_insert ON marketplace_reviews FOR INSERT WITH CHECK (
    user_id = current_setting('app.user_id', true) AND listing_id IN (SELECT id FROM marketplace_listings));
  CREATE POLICY own_update ON marketplace_reviews FOR UPDATE USING (user_id = current_setting('app.user_id', true))
    WITH CHECK (user_id = current_setting('app.user_id', true));
  CREATE POLICY own_delete ON marketplace_reviews FOR DELETE USING (user_id = current_setting('app.user_id', true));

  -- Favorites and installs: own rows only; the listing must be visible to the caller, and an install
  -- must be on one of the caller's own devices. (devices has its own RLS, so the subquery is already
  -- scoped.) device_id/listing_id cannot be changed afterwards (column grants).
  ALTER TABLE marketplace_favorites ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_select ON marketplace_favorites FOR SELECT USING (user_id = current_setting('app.user_id', true));
  CREATE POLICY own_insert ON marketplace_favorites FOR INSERT WITH CHECK (
    user_id = current_setting('app.user_id', true) AND listing_id IN (SELECT id FROM marketplace_listings));
  CREATE POLICY own_delete ON marketplace_favorites FOR DELETE USING (user_id = current_setting('app.user_id', true));
  ALTER TABLE marketplace_installs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own_select ON marketplace_installs FOR SELECT USING (user_id = current_setting('app.user_id', true));
  CREATE POLICY own_insert ON marketplace_installs FOR INSERT WITH CHECK (
    user_id = current_setting('app.user_id', true)
    AND device_id IN (SELECT id FROM devices WHERE user_id = current_setting('app.user_id', true))
    AND listing_id IN (SELECT id FROM marketplace_listings)
    AND (version_id IS NULL OR version_id IN (SELECT v.id FROM marketplace_versions v WHERE v.listing_id = marketplace_installs.listing_id)));
  CREATE POLICY own_update ON marketplace_installs FOR UPDATE USING (user_id = current_setting('app.user_id', true))
    WITH CHECK (user_id = current_setting('app.user_id', true)
                AND device_id IN (SELECT id FROM devices WHERE user_id = current_setting('app.user_id', true)));
  -- (version_id on UPDATE is checked by trg_mkt_installs_version, so an install whose version was later
  -- revoked can still change state; it just cannot be moved onto a version the caller cannot see.)
  CREATE POLICY own_delete ON marketplace_installs FOR DELETE USING (user_id = current_setting('app.user_id', true));

  -- Artifact rows are written by the server (ao_admin) during publish; readers see only referenced ones.
  ALTER TABLE marketplace_artifacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY read_visible ON marketplace_artifacts FOR SELECT USING (sha256 IN (SELECT sha256 FROM marketplace_versions));

  -- Grants. Column lists keep trust, scan verdicts, publication and moderation states with ao_admin.
  GRANT SELECT ON marketplace_publishers, marketplace_teams, marketplace_team_members, marketplace_listings,
        marketplace_versions, marketplace_artifacts, marketplace_dependencies, marketplace_collections,
        marketplace_collection_items, marketplace_security_scans, marketplace_submissions, marketplace_reports,
        marketplace_listing_counters, marketplace_listing_stats TO ao_app;
  GRANT INSERT (id, type, publisher_id, owner_user_id, visibility, team_id, title, summary, tags, forked_from, forked_from_version, forked_base_sha256) ON marketplace_listings TO ao_app;
  GRANT UPDATE (title, summary, tags, visibility, team_id) ON marketplace_listings TO ao_app;
  GRANT INSERT (id, listing_id, version, semver_major, semver_minor, semver_patch, manifest, sha256, size, compat) ON marketplace_versions TO ao_app;
  GRANT UPDATE (state, manifest, sha256, size, compat) ON marketplace_versions TO ao_app;
  GRANT INSERT, DELETE ON marketplace_dependencies TO ao_app;
  GRANT INSERT (id, version_id, submitted_by, notes) ON marketplace_submissions TO ao_app;
  GRANT INSERT (id, listing_id, reporter_user_id, version_id, reason, details) ON marketplace_reports TO ao_app;
  GRANT SELECT, INSERT, DELETE ON marketplace_reviews TO ao_app;
  GRANT UPDATE (stars, body) ON marketplace_reviews TO ao_app;
  GRANT SELECT, INSERT, DELETE ON marketplace_favorites TO ao_app;
  GRANT SELECT, INSERT, DELETE ON marketplace_installs TO ao_app;
  GRANT UPDATE (version_id, state, scope, enabled, scan_verdict, last_error, updated_at) ON marketplace_installs TO ao_app;
  GRANT SELECT, INSERT ON marketplace_install_events, marketplace_usage_events TO ao_app;
  GRANT USAGE ON SEQUENCE marketplace_usage_events_id_seq TO ao_app;
  GRANT EXECUTE ON FUNCTION marketplace_installed_status() TO ao_app;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_publishers, marketplace_teams, marketplace_team_members,
      marketplace_listings, marketplace_versions, marketplace_artifacts, marketplace_dependencies,
      marketplace_submissions, marketplace_reviews, marketplace_favorites, marketplace_installs,
      marketplace_usage_events, marketplace_collections, marketplace_collection_items,
      marketplace_security_scans, marketplace_reports, marketplace_listing_counters TO ao_admin;
    GRANT SELECT, INSERT ON marketplace_install_events, marketplace_release_events TO ao_admin;
    GRANT SELECT ON marketplace_listing_stats TO ao_admin;
    GRANT USAGE ON SEQUENCE marketplace_usage_events_id_seq, marketplace_release_events_id_seq TO ao_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN
    GRANT SELECT ON marketplace_publishers, marketplace_teams, marketplace_team_members, marketplace_listings,
      marketplace_versions, marketplace_artifacts, marketplace_dependencies, marketplace_submissions,
      marketplace_reviews, marketplace_favorites, marketplace_installs, marketplace_install_events,
      marketplace_usage_events, marketplace_collections, marketplace_collection_items,
      marketplace_security_scans, marketplace_reports, marketplace_release_events,
      marketplace_listing_counters, marketplace_listing_stats TO ao_readonly;
  END IF;
END $$;
