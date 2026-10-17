-- Agentic Office core schema (scaling stage A: one primary, indexed, unpartitioned).
-- Postgres holds durable metadata and synced changes only — never tokens,
-- keystrokes or scratch files. Content (transcripts, documents) lives as
-- client-side-encrypted blobs in MinIO; rows hold ids, revisions and hashes.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Roles. Passwords are set by migrate.mjs from the server's .env.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_app') THEN CREATE ROLE ao_app LOGIN; END IF;
  -- The read-only role behind the SQL runner and the Admin Console's views.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_readonly') THEN CREATE ROLE ao_readonly LOGIN BYPASSRLS; END IF;
  -- The admin API (disable, sign-out, export, delete). Never handed to a client.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_admin') THEN CREATE ROLE ao_admin LOGIN BYPASSRLS; END IF;
END $$;

CREATE TABLE users (
  id              text PRIMARY KEY,                    -- usr_<ulid>, ours, never the IdP's
  clerk_user_id   text UNIQUE,
  email           text,
  display_name    text,
  avatar_url      text,
  role            text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz
);
CREATE INDEX ix_users_created ON users (created_at);
CREATE INDEX ix_users_email ON users (lower(email));

-- Connected identities: an ownership dimension, not a user.
CREATE TABLE oauth_accounts (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,                           -- google | microsoft | github | email
  subject     text NOT NULL,
  email       text,
  purpose     text NOT NULL DEFAULT 'sign_in' CHECK (purpose IN ('sign_in', 'connector')),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject, purpose)
);
CREATE INDEX ix_oauth_user ON oauth_accounts (user_id);

CREATE TABLE devices (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text,
  platform     text,
  app_version  text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_devices_user ON devices (user_id);

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_workspaces_user ON workspaces (user_id);

CREATE TABLE sessions (
  id                    text PRIMARY KEY,
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id          text REFERENCES workspaces(id) ON DELETE CASCADE,
  title                 text,
  latest_checkpoint_id  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_sessions_user_updated ON sessions (user_id, updated_at DESC);

-- Append-only. event_id = idempotency key; sequence is gap-free per session.
-- Stage B partitions this table by created_at (measured need, not up front).
CREATE TABLE session_events (
  event_id      text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  text,
  session_id    text NOT NULL,
  sequence      bigint NOT NULL,
  type          text NOT NULL,
  run_id        text,
  task_id       text,
  agent_id      text,
  payload       bytea,                                  -- client-side encrypted
  created_at    timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);
CREATE INDEX ix_events_user_time ON session_events (user_id, created_at);

CREATE TABLE agent_runs (
  run_id         text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id     text NOT NULL,
  parent_run_id  text,
  agent_id       text,
  state          text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  tokens_in      bigint NOT NULL DEFAULT 0,
  tokens_out     bigint NOT NULL DEFAULT 0
);
CREATE INDEX ix_runs_user_time ON agent_runs (user_id, started_at);

CREATE TABLE document_revisions (
  doc_id        text NOT NULL,
  revision      bigint NOT NULL,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  text,
  content_hash  text NOT NULL,                          -- blake3 of the plaintext
  blob_key      text NOT NULL,                          -- ao-user-blobs/<user>/<hash>
  bytes         bigint NOT NULL,
  op_id         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, revision)
);
CREATE INDEX ix_docrev_user ON document_revisions (user_id, created_at);

CREATE TABLE memory_references (
  memory_id          text PRIMARY KEY,                  -- Mnemo ulid
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id       text,
  source_account_id  text REFERENCES oauth_accounts(id) ON DELETE SET NULL,
  memory_uri         text NOT NULL,                     -- mnemo://<user>/<id>
  source_version     text NOT NULL,                     -- file hash
  kind               text,
  blob_key           text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_memref_user ON memory_references (user_id);

CREATE TABLE sync_cursors (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  text NOT NULL,
  stream     text NOT NULL,
  cursor     text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, stream)
);

-- Every admin view of a user, every admin action, every admin SQL query.
CREATE TABLE admin_audit (
  id              bigserial PRIMARY KEY,
  admin_user_id   text NOT NULL,
  action          text NOT NULL,                        -- view_user | disable | enable | sign_out | export | delete | sql
  target_user_id  text,
  detail          jsonb NOT NULL DEFAULT '{}',
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_at ON admin_audit (at DESC);

-- Row-level security: the API sets app.user_id per request (SET LOCAL).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['oauth_accounts','devices','workspaces','sessions','session_events',
                           'agent_runs','document_revisions','memory_references','sync_cursors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                     WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY own_user ON users USING (id = current_setting('app.user_id', true));
-- Sign-in must find-or-create a user before app.user_id is known.
CREATE POLICY signin_lookup ON users FOR SELECT USING (current_setting('app.signin', true) = 'on');
CREATE POLICY signin_create ON users FOR INSERT WITH CHECK (current_setting('app.signin', true) = 'on');

-- Admin views (metadata and usage only; no content).
CREATE VIEW admin_signups_daily AS
  SELECT date_trunc('day', created_at)::date AS day, count(*) AS signups
  FROM users WHERE status <> 'deleted' GROUP BY 1 ORDER BY 1;

CREATE VIEW admin_user_overview AS
  SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_active_at,
         (SELECT string_agg(DISTINCT o.provider, ',') FROM oauth_accounts o WHERE o.user_id = u.id AND o.purpose = 'sign_in') AS providers,
         (SELECT count(*) FROM devices d WHERE d.user_id = u.id) AS devices,
         (SELECT count(*) FROM workspaces w WHERE w.user_id = u.id) AS workspaces,
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
         (SELECT coalesce(sum(r.bytes), 0) FROM document_revisions r WHERE r.user_id = u.id) AS storage_bytes,
         (SELECT count(*) FROM memory_references m WHERE m.user_id = u.id) AS memories
  FROM users u;

-- Grants.
GRANT USAGE ON SCHEMA public TO ao_app, ao_readonly, ao_admin;
GRANT SELECT, INSERT, UPDATE ON users, oauth_accounts, devices, workspaces, sessions, agent_runs,
      document_revisions, memory_references, sync_cursors TO ao_app;
GRANT SELECT, INSERT ON session_events TO ao_app;
GRANT DELETE ON workspaces, sessions, devices, memory_references, sync_cursors TO ao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_admin;
-- Read-only: everything except event payloads (encrypted anyway — least privilege).
GRANT SELECT ON users, oauth_accounts, devices, workspaces, sessions, agent_runs, document_revisions,
      memory_references, sync_cursors, admin_audit, admin_signups_daily, admin_user_overview TO ao_readonly;
GRANT SELECT (event_id, user_id, workspace_id, session_id, sequence, type, run_id, task_id, agent_id,
              created_at, received_at) ON session_events TO ao_readonly;
GRANT pg_read_all_stats TO ao_readonly;
ALTER ROLE ao_readonly SET default_transaction_read_only = on;
ALTER ROLE ao_readonly SET statement_timeout = '30s';
-- The audit log is append-only even for the admin API.
REVOKE UPDATE, DELETE ON admin_audit FROM ao_admin;
