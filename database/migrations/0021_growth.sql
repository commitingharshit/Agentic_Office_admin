-- Growth: house promotions on three app placements, their creatives and media, who may see them, how often, and what people did.
-- The admin decides what is eligible; the app decides how it renders (each placement has a versioned contract the app knows); a
-- person's ad-free plan or their own preference decides whether anything promotional appears at all. Nothing here is executable:
-- a creative is an image, a short muted clip or a declarative card (packages/promo-card validates it on publish and before render).

-- The surfaces the app can render. contract_version is what a client must support to be sent a creative made for it.
CREATE TABLE placements (
  id                text PRIMARY KEY CHECK (id IN ('chat_empty', 'inbox', 'bottom_strip')),
  contract_version  integer NOT NULL CHECK (contract_version >= 1),
  allowed_kinds     text[] NOT NULL,
  allow_video       boolean NOT NULL,
  max_media_bytes   integer NOT NULL CHECK (max_media_bytes > 0),
  description       text NOT NULL DEFAULT ''
);
INSERT INTO placements VALUES
  ('chat_empty',   1, ARRAY['image', 'clip', 'card'], true,  4000000, 'Above the composer while the assistant has no conversation; collapses once a task starts'),
  ('inbox',        1, ARRAY['image', 'card'],         false, 1000000, 'The notification inbox: announcements, release notes and promotions, each marked as such'),
  ('bottom_strip', 1, ARRAY['image', 'card'],         false,  300000, 'One line at the bottom of the window; hidden at narrow widths');

CREATE TABLE campaigns (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'live', 'paused', 'ended')),
  -- Order of precedence when two campaigns want the same slot: a task notice beats a release note beats a promotion.
  tier            text NOT NULL DEFAULT 'promo' CHECK (tier IN ('task', 'release', 'promo')),
  priority        integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  -- Share of eligible people held back (shown nothing, exposure recorded) so a campaign's effect can be measured against them.
  holdout_pct     integer NOT NULL DEFAULT 0 CHECK (holdout_pct BETWEEN 0 AND 50),
  flag_key        text REFERENCES feature_flags(key) ON DELETE SET NULL,
  -- Frequency: at most max_impressions in per_seconds, at least min_gap_seconds apart; a dismissal ends it for that person.
  max_impressions integer NOT NULL DEFAULT 3 CHECK (max_impressions BETWEEN 1 AND 100),
  per_seconds     integer NOT NULL DEFAULT 86400 CHECK (per_seconds BETWEEN 60 AND 31536000),
  min_gap_seconds integer NOT NULL DEFAULT 3600 CHECK (min_gap_seconds BETWEEN 0 AND 31536000),
  paused_reason   text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX ix_campaigns_live ON campaigns (status, starts_at) WHERE status IN ('scheduled', 'live');

-- Who a campaign is for. Every list null = everyone; a person must match every list that is set.
CREATE TABLE campaign_targets (
  campaign_id       text PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  plan_ids          text[],
  exclude_plan_ids  text[],
  platforms         text[] CHECK (platforms IS NULL OR platforms <@ ARRAY['darwin', 'win32', 'linux']),
  locales           text[],
  min_app_version   text CHECK (min_app_version IS NULL OR min_app_version ~ '^\d+(\.\d+){0,2}$'),
  signup_after      timestamptz,
  signup_before     timestamptz,
  user_ids          text[]
);

CREATE TABLE creatives (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  campaign_id       text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  placement_id      text NOT NULL REFERENCES placements(id),
  kind              text NOT NULL CHECK (kind IN ('image', 'clip', 'card')),
  contract_version  integer NOT NULL DEFAULT 1,
  headline          text NOT NULL DEFAULT '' CHECK (length(headline) <= 120),
  body              text NOT NULL DEFAULT '' CHECK (length(body) <= 400),
  cta_label         text CHECK (cta_label IS NULL OR length(cta_label) BETWEEN 1 AND 40),
  cta_action        jsonb,          -- {command, arg?}: one of the app's allow-listed actions (packages/promo-card)
  card              jsonb,          -- kind = card: a promo-card v1 document
  -- 'ready' only after the card validated and every media variant was produced; only ready creatives are ever served.
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'ready', 'rejected')),
  error             text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, placement_id)
);

-- Media files in object storage: the uploaded source and the variants the worker made from it.
CREATE TABLE creative_media (
  id           bigserial PRIMARY KEY,
  creative_id  text NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('source', 'mp4', 'webm', 'poster', 'image', 'thumb')),
  width        integer NOT NULL DEFAULT 0,
  s3_key       text NOT NULL,
  mime         text NOT NULL,
  height       integer NOT NULL DEFAULT 0,
  duration_ms  integer NOT NULL DEFAULT 0,
  bytes        integer NOT NULL CHECK (bytes > 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creative_id, role, width)
);

-- The media worker's queue (claimed with FOR UPDATE SKIP LOCKED, so several workers never take the same job).
CREATE TABLE media_jobs (
  id           bigserial PRIMARY KEY,
  creative_id  text NOT NULL REFERENCES creatives(id) ON DELETE CASCADE,
  source_key   text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('image', 'clip')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX ix_media_jobs_queue ON media_jobs (status, id) WHERE status IN ('queued', 'running');

-- What the app reported. event_id is generated by the app, so a retried batch is counted once. user_id is null for someone who
-- has not agreed to share usage (usage_consent): their events still count in totals, but are not linked to them.
CREATE TABLE promo_events (
  id           bigserial PRIMARY KEY,
  event_id     text NOT NULL UNIQUE CHECK (event_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  user_id      text REFERENCES users(id) ON DELETE SET NULL,
  campaign_id  text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  creative_id  text REFERENCES creatives(id) ON DELETE SET NULL,
  placement    text NOT NULL REFERENCES placements(id),
  type         text NOT NULL CHECK (type IN ('impression', 'view', 'click', 'dismiss', 'conversion', 'holdout')),
  ts           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_promo_events_user ON promo_events (user_id, campaign_id, type, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX ix_promo_events_campaign ON promo_events (campaign_id, type, ts);

-- Frequency must hold for people who share no usage too, so delivery is also counted per person in a separate, minimal table the
-- app cannot read others' rows of. It records only when something was shown or dismissed, nothing else.
CREATE TABLE promo_exposure (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id  text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  shown_at     timestamptz[] NOT NULL DEFAULT '{}',
  dismissed_at timestamptz,
  PRIMARY KEY (user_id, campaign_id)
);

-- A person's own choices. In-app promotions are on unless they switch them off; marketing email is off unless they switch it on.
CREATE TABLE user_promo_prefs (
  user_id          text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app           boolean NOT NULL DEFAULT true,
  email_marketing  boolean NOT NULL DEFAULT false,
  unsubscribed_at  timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['promo_exposure', 'user_promo_prefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                     WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;
ALTER TABLE promo_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_events FORCE ROW LEVEL SECURITY;
-- The app may add events for the signed-in person (or unlinked ones) and never reads them back.
CREATE POLICY add_own ON promo_events FOR INSERT
  WITH CHECK (user_id IS NULL OR user_id = current_setting('app.user_id', true));
-- ON CONFLICT also checks the new row against a SELECT policy. The app can read only event_id (column grant below), so this
-- reveals no more than whether an event id was already recorded.
CREATE POLICY dedupe_own ON promo_events FOR SELECT
  USING (user_id IS NULL OR user_id = current_setting('app.user_id', true));

GRANT SELECT ON placements, campaigns, campaign_targets, creatives, creative_media TO ao_app;
GRANT INSERT ON promo_events TO ao_app;
-- ON CONFLICT (event_id) needs to read the one column it checks; nothing else of anyone's events is readable by the app.
GRANT SELECT (event_id) ON promo_events TO ao_app;
GRANT SELECT, INSERT, UPDATE ON promo_exposure, user_promo_prefs TO ao_app;
GRANT SELECT ON placements, campaigns, campaign_targets, creatives, creative_media, media_jobs, promo_events, promo_exposure, user_promo_prefs TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns, campaign_targets, creatives, creative_media, media_jobs TO ao_admin;
GRANT SELECT ON placements, promo_events, promo_exposure TO ao_admin;
GRANT SELECT, UPDATE ON user_promo_prefs TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_app, ao_admin;
