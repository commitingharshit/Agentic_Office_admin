-- Laya shadow mode: for each answered managed inference request, the person's last message and Laya's predicted pattern, next to the
-- model that really answered. Calibration data for Laya; nothing reads it to route. Free text, so it is kept 60 days only: the API
-- deletes older rows every hour (src/api/main.ts). Written by the API as the person; read by ao_readonly and ao_admin.
CREATE TABLE laya_shadow (
  id             bigserial PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  request_id     text NOT NULL,
  model          text NOT NULL,
  request_text   text NOT NULL,
  pattern        text NOT NULL,
  confidence     real NOT NULL,
  probabilities  jsonb NOT NULL,
  laya_model     text NOT NULL
);
CREATE INDEX ix_laya_shadow_time ON laya_shadow (created_at);
CREATE INDEX ix_laya_shadow_user ON laya_shadow (user_id);

ALTER TABLE laya_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE laya_shadow FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON laya_shadow USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

GRANT INSERT ON laya_shadow TO ao_app;
GRANT USAGE ON SEQUENCE laya_shadow_id_seq TO ao_app;
GRANT SELECT ON laya_shadow TO ao_readonly;
GRANT SELECT, DELETE ON laya_shadow TO ao_admin;

COMMENT ON TABLE laya_shadow IS 'Laya shadow mode: each answered managed inference request''s last user message and Laya''s predicted pattern, next to the model that answered. Calibration data only; deleted after 60 days.';
