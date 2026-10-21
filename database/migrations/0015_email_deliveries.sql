-- One row per announcement email per person, written only from the provider's own answer ('sent' with its message id, or 'failed' with its error).
-- The unique key makes re-sending an announcement skip everyone already emailed.
CREATE TABLE email_deliveries (
  announcement_id text NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('sent', 'failed')),
  provider_id     text,
  error           text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);
GRANT SELECT ON email_deliveries TO ao_readonly;
GRANT SELECT, INSERT, UPDATE ON email_deliveries TO ao_admin;
