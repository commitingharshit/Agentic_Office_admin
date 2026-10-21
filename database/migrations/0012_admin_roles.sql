-- Admin roles (RBAC) and the indexes the console's lists and charts lean on.
-- users.role = 'admin' still says WHO is an admin; admin_roles says WHAT KIND. An admin with no row here keeps full power
-- (that is how every admin worked before roles), so nobody is locked out; the role route writes the row, and demoting deletes it.
CREATE TABLE admin_roles (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('superadmin', 'engineer', 'support', 'finance', 'analyst')),
  granted_by  text,
  granted_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin_roles(user_id, role, granted_by) SELECT id, 'superadmin', 'migration 0012' FROM users WHERE role = 'admin';
GRANT SELECT ON admin_roles TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_roles TO ao_admin;

-- Browser sign-in sessions without their secret token: the one view the read-only role may see.
CREATE VIEW admin_browser_sessions AS
  SELECT id, user_id, ip_address, user_agent, created_at, updated_at, expires_at FROM auth_sessions;
GRANT SELECT ON admin_browser_sessions TO ao_readonly, ao_admin;

CREATE INDEX ix_users_status_created ON users (status, created_at DESC);
CREATE INDEX ix_users_admins ON users (role) WHERE role <> 'user';
CREATE INDEX ix_sessions_updated_desc ON sessions (updated_at DESC);
CREATE INDEX ix_events_session ON session_events (session_id);
CREATE INDEX ix_events_created ON session_events (created_at);
CREATE INDEX ix_usage_created ON usage_events (created_at DESC);
CREATE INDEX ix_ledger_created ON credit_ledger (created_at DESC);
CREATE INDEX ix_ledger_kind ON credit_ledger (kind, created_at DESC);
CREATE INDEX ix_device_tokens_used ON device_tokens (last_used_at DESC);
CREATE INDEX ix_audit_action ON admin_audit (action, at DESC);
