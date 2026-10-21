-- Pricing plans live in the database, with what a plan costs and gives, and every sign-in is recorded.
ALTER TABLE plans
  ADD COLUMN description       text   NOT NULL DEFAULT '',
  ADD COLUMN price_cents       integer CHECK (price_cents IS NULL OR price_cents >= 0),     -- NULL = no price set yet
  ADD COLUMN currency          text   NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  ADD COLUMN billing_interval  text   CHECK (billing_interval IN ('month', 'year')),       -- NULL for a plan that is not billed
  ADD COLUMN monthly_credits   bigint NOT NULL DEFAULT 0 CHECK (monthly_credits >= 0),
  ADD COLUMN sort_order        integer NOT NULL DEFAULT 100;

UPDATE plans SET description = 'For trying Agentic Office with your own model key or a local model.', price_cents = 0, sort_order = 0 WHERE id = 'free';
UPDATE plans SET description = 'Early-access plan with Agentic Office compute included.', sort_order = 50 WHERE id = 'beta';
-- Draft plans: they exist and can be edited in the admin console, but are INACTIVE and have no price until the owner sets them.
INSERT INTO plans(id, name, description, managed_inference, active, billing_interval, sort_order) VALUES
  ('pro',  'Pro',  'For one person who works in Office documents every day, with Agentic Office compute included.', true, false, 'month', 10),
  ('team', 'Team', 'For a group that shares documents and a pool of compute.',                                      true, false, 'month', 20)
ON CONFLICT (id) DO NOTHING;

-- Every sign-in, as the server saw it: who, through what, from which app and machine and address.
CREATE TABLE sign_in_events (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,                      -- 'keycloak', 'clerk'
  client       text,                               -- the app that asked (agentic-office-desktop, ao-admin-console)
  device_name  text,
  platform     text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_signins_user_time ON sign_in_events (user_id, created_at DESC);
ALTER TABLE sign_in_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON sign_in_events USING (user_id = current_setting('app.user_id', true)) WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT ON sign_in_events TO ao_app;
GRANT SELECT ON sign_in_events TO ao_readonly;
GRANT USAGE ON SEQUENCE sign_in_events_id_seq TO ao_app;
GRANT SELECT ON plans TO ao_app;
