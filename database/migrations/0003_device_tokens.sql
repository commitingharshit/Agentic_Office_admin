-- Device sign-in tokens. The desktop app signs in once in the browser (Clerk); the server
-- swaps that short-lived Clerk session token for a long-lived device token, so the app keeps
-- syncing without a browser session. Only the token's SHA-256 is stored. A token slides
-- forward on use (90 days); sign-out, an admin force sign-out or a disabled account ends it.
CREATE TABLE device_tokens (
  id            text PRIMARY KEY,                      -- dtk_<ulid>
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  device_name   text,
  platform      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX ix_device_tokens_user ON device_tokens (user_id);
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON device_tokens USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
-- A request is authenticated by its token before app.user_id is known.
CREATE POLICY token_lookup ON device_tokens FOR SELECT USING (current_setting('app.signin', true) = 'on');
GRANT SELECT, INSERT, UPDATE ON device_tokens TO ao_app;
GRANT SELECT ON device_tokens TO ao_readonly;
GRANT SELECT, UPDATE, DELETE ON device_tokens TO ao_admin;
