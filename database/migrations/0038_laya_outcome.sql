-- Live Laya outcomes: a result of the Assistant's work kept or undone (a chat edit kept/undone, Office changes accepted/rejected in
-- the Changes tab). The app's gateway posts each to POST /v1/laya/outcome; joined with laya_shadow by user and time to judge Laya's
-- picks. Holds file paths, so it is kept 60 days like laya_shadow (src/api/main.ts). Written by the API as the person.
CREATE TABLE laya_outcome (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted     boolean NOT NULL,
  source       text,
  file         text,
  count        integer,
  authors      jsonb,
  session_id   text,
  response_id  text
);
CREATE INDEX ix_laya_outcome_time ON laya_outcome (created_at);
CREATE INDEX ix_laya_outcome_user ON laya_outcome (user_id);

ALTER TABLE laya_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE laya_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON laya_outcome USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

GRANT INSERT ON laya_outcome TO ao_app;
GRANT USAGE ON SEQUENCE laya_outcome_id_seq TO ao_app;
GRANT SELECT ON laya_outcome TO ao_readonly;
GRANT SELECT, DELETE ON laya_outcome TO ao_admin;

COMMENT ON TABLE laya_outcome IS 'Live Laya: a result of the Assistant''s work kept or undone in the app (chat Keep/Undo, Changes tab Accept/Reject), for judging Laya''s picks in laya_shadow. Calibration data only; deleted after 60 days.';
