-- Operations: feature flags (enforced by the server), announcements people can read in the app, and support tickets people open themselves.
CREATE TABLE feature_flags (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  description  text NOT NULL DEFAULT '',
  enabled      boolean NOT NULL DEFAULT false,
  rollout_pct  integer NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  plan_ids     text[],                       -- null = every plan
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  id          text PRIMARY KEY,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn')),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  plan_ids    text[],
  active      boolean NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE announcement_reads (
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id  text NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  read_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, announcement_id)
);

CREATE TABLE support_tickets (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tickets_status ON support_tickets (status, updated_at DESC);
CREATE TABLE support_messages (
  id             bigserial PRIMARY KEY,
  ticket_id      text NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the ticket's owner (row-level security)
  author         text NOT NULL CHECK (author IN ('user', 'admin')),
  admin_user_id  text,
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_support_msgs ON support_messages (ticket_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['announcement_reads', 'support_tickets', 'support_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                     WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;

GRANT SELECT ON feature_flags, announcements TO ao_app;
GRANT SELECT, INSERT ON announcement_reads TO ao_app;
GRANT SELECT, INSERT, UPDATE ON support_tickets TO ao_app;
GRANT SELECT, INSERT ON support_messages TO ao_app;
GRANT SELECT ON feature_flags, announcements, announcement_reads, support_tickets, support_messages TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags TO ao_admin;
GRANT SELECT, INSERT, UPDATE ON announcements, support_tickets TO ao_admin;
GRANT SELECT, INSERT ON support_messages, announcement_reads TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_app, ao_admin;
