-- Better Auth (self-hosted sign-in, replacing Clerk). Only `users` is shared with it, so every
-- existing usr_<ulid> id and the data under it survive; its account, session and verification
-- models get their own tables. Additive only: nothing is dropped or rewritten, so rolling back is
-- "stop using the new tables and columns". Desktop credentials stay in device_tokens.
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- One row per linked sign-in method (Google, Microsoft, email+password). Provider tokens and the
-- password hash live here, so only the admin role can read it: not the sync API, not the SQL runner.
CREATE TABLE auth_accounts (
  id                        text PRIMARY KEY,
  user_id                   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id                text NOT NULL,        -- the provider's subject
  provider_id               text NOT NULL CHECK (provider_id ~ '^[a-z0-9_-]{1,40}$'),
  access_token              text,
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  password                  text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX ix_auth_accounts_user ON auth_accounts (user_id);

-- Browser sessions of the sign-in pages and the web admin. Not desktop sessions (device_tokens).
CREATE TABLE auth_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX ix_auth_sessions_expires ON auth_sessions (expires_at);

-- Email links now, phone codes later.
CREATE TABLE auth_verifications (
  id          text PRIMARY KEY,
  identifier  text NOT NULL,
  value       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_auth_verifications_identifier ON auth_verifications (identifier);

-- Row-level security on, no policy and no grant for the app role: only BYPASSRLS roles reach these.
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_verifications FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_accounts, auth_sessions, auth_verifications TO ao_admin;
