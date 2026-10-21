-- Releases, staged feature rollouts and campaign email.
-- A release is what shipped (version, channel, notes). A feature it brings is switched on through its feature flag in stages;
-- each stage is recorded. Telling people about it is an announcement linked to the release, so release notes reach the inbox.
CREATE TABLE releases (
  id            text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_.-]{1,80}$'),
  version       text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$'),
  channel       text NOT NULL DEFAULT 'stable' CHECK (channel IN ('canary', 'beta', 'stable')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  notes_md      text NOT NULL DEFAULT '' CHECK (length(notes_md) <= 20000),
  flag_key      text REFERENCES feature_flags(key) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'rolling_out', 'complete', 'paused')),
  published_at  timestamptz,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, channel)
);
-- Every change of a rollout stage, newest last: the history the release page shows and an auditor reads.
CREATE TABLE release_rollouts (
  id          bigserial PRIMARY KEY,
  release_id  text NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  stage_pct   integer NOT NULL CHECK (stage_pct BETWEEN 0 AND 100),
  note        text,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE announcements ADD COLUMN release_id text REFERENCES releases(id) ON DELETE SET NULL;
ALTER TABLE announcements ADD COLUMN kind text NOT NULL DEFAULT 'notice' CHECK (kind IN ('notice', 'release', 'promo'));

-- Email: templates (HTML + plain text) and campaign sends, delivered through Resend, tracked from Resend's signed webhooks.
CREATE TABLE email_templates (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  html        text NOT NULL CHECK (length(html) BETWEEN 1 AND 200000),
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  version     integer NOT NULL DEFAULT 1,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_emails (
  id           text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  campaign_id  text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  template_id  text NOT NULL REFERENCES email_templates(id),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'cancelled')),
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);

-- One deliveries table for announcement and campaign email. The old key (announcement_id, user_id) stays unique (nulls never
-- collide, so campaign rows do not clash with it); a campaign send is unique per (campaign_email_id, user_id), so a re-run of
-- a send skips everyone already done. Status now also carries what Resend reports after the send.
ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_pkey;
ALTER TABLE email_deliveries ADD COLUMN id bigserial PRIMARY KEY;
ALTER TABLE email_deliveries ALTER COLUMN announcement_id DROP NOT NULL;
ALTER TABLE email_deliveries ADD COLUMN campaign_email_id text REFERENCES campaign_emails(id) ON DELETE CASCADE;
ALTER TABLE email_deliveries ADD COLUMN last_event_at timestamptz;
ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_one_source CHECK ((announcement_id IS NULL) <> (campaign_email_id IS NULL));
CREATE UNIQUE INDEX ux_email_deliveries_announcement ON email_deliveries (announcement_id, user_id);
CREATE UNIQUE INDEX ux_email_deliveries_campaign ON email_deliveries (campaign_email_id, user_id);
CREATE INDEX ix_email_deliveries_provider ON email_deliveries (provider_id) WHERE provider_id IS NOT NULL;
ALTER TABLE email_deliveries DROP CONSTRAINT email_deliveries_status_check;
ALTER TABLE email_deliveries ADD CONSTRAINT email_deliveries_status_check
  CHECK (status IN ('sent', 'failed', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked'));

-- Each Resend webhook is processed once: its svix-id is recorded before it is applied, and a repeat is acknowledged and ignored.
CREATE TABLE webhook_events (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

GRANT SELECT ON releases TO ao_app;
GRANT SELECT ON releases, release_rollouts, email_templates, campaign_emails, webhook_events TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON releases, email_templates, campaign_emails TO ao_admin;
GRANT SELECT, INSERT ON release_rollouts, webhook_events TO ao_admin;
GRANT DELETE ON email_deliveries TO ao_admin;
-- An unsubscribe (link, one-click POST, complaint or permanent bounce) may be the person's first preference row.
GRANT INSERT ON user_promo_prefs TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_app, ao_admin;
