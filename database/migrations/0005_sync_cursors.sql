-- Incremental sync. A device asks "what changed since my cursor?" instead of listing everything:
--  * a forgotten memory leaves a tombstone (deleted_at) so other devices learn it is gone;
--  * sessions.updated_at moves when events arrive (the API bumps it), so sessions can be pulled
--    by "updated since".
ALTER TABLE memory_references ADD COLUMN deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_memref_user_updated ON memory_references (user_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_sessions_user_updated ON sessions (user_id, updated_at);
GRANT DELETE ON memory_references TO ao_app;

CREATE OR REPLACE VIEW admin_user_overview AS
  SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_active_at,
         (SELECT string_agg(DISTINCT o.provider, ',') FROM oauth_accounts o WHERE o.user_id = u.id AND o.purpose = 'sign_in' AND o.revoked_at IS NULL) AS providers,
         (SELECT count(*) FROM devices d WHERE d.user_id = u.id) AS devices,
         (SELECT count(*) FROM workspaces w WHERE w.user_id = u.id) AS workspaces,
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
         (SELECT coalesce(sum(r.bytes), 0) FROM document_revisions r WHERE r.user_id = u.id) AS storage_bytes,
         (SELECT count(*) FROM memory_references m WHERE m.user_id = u.id AND m.deleted_at IS NULL) AS memories
  FROM users u;
