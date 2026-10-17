-- Sign-in providers in the Admin Console count live identities only. A user's identities are
-- mirrored from Clerk on every desktop sign-in (Google, Microsoft, or both when Clerk linked
-- them); the provider-less 'clerk' placeholder a first sign-in can leave is revoked, not deleted.
CREATE OR REPLACE VIEW admin_user_overview AS
  SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_active_at,
         (SELECT string_agg(DISTINCT o.provider, ',') FROM oauth_accounts o WHERE o.user_id = u.id AND o.purpose = 'sign_in' AND o.revoked_at IS NULL) AS providers,
         (SELECT count(*) FROM devices d WHERE d.user_id = u.id) AS devices,
         (SELECT count(*) FROM workspaces w WHERE w.user_id = u.id) AS workspaces,
         (SELECT count(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
         (SELECT coalesce(sum(r.bytes), 0) FROM document_revisions r WHERE r.user_id = u.id) AS storage_bytes,
         (SELECT count(*) FROM memory_references m WHERE m.user_id = u.id) AS memories
  FROM users u;
-- Known providers are lower-case slugs; anything else is refused at the database.
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_provider_slug CHECK (provider ~ '^[a-z0-9_-]{1,40}$');
