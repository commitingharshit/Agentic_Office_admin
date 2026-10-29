-- admin_audit could only name a user as the subject of an action. A payment, a ticket, a campaign or a marketplace version was
-- buried in the free-form detail, so "everything that happened to this payment" had no index and no link.
-- target_type / target_id name any subject (see services/api/src/api/audit-entity.ts for the kinds); target_user_id stays as it was,
-- so every existing reader and the row-level reads of a user's history keep working. Additive and idempotent.
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_type text;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS target_id   text;

-- Rows written before this migration: the user target is the only subject they recorded.
UPDATE admin_audit SET target_type = 'user', target_id = target_user_id
 WHERE target_user_id IS NOT NULL AND target_type IS NULL;

CREATE INDEX IF NOT EXISTS ix_audit_target ON admin_audit (target_type, target_id, at DESC) WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_audit_admin  ON admin_audit (admin_user_id, at DESC);

COMMENT ON COLUMN admin_audit.target_type IS 'What kind of thing the action was about: user, payment, ticket, campaign, release, marketplace_version, ... Null for an action with no subject (a list, an overview, a refused request).';
COMMENT ON COLUMN admin_audit.target_id IS 'The id of that thing, in the table its type names (a coupon''s code, an admin invite''s email). For a user this equals target_user_id.';

-- ROLLBACK (by hand, in a transaction, after deploying the previous API image: the new image writes target_type / target_id, the old
-- one does not). database/rollback/ holds only the marketplace chain, which test/marketplace-migrations.test.ts enforces, so this
-- one lives here. It drops the two columns and their data; target_user_id is untouched, so a user's history survives.
--   BEGIN;
--   DROP INDEX IF EXISTS ix_audit_target;
--   DROP INDEX IF EXISTS ix_audit_admin;
--   ALTER TABLE admin_audit DROP COLUMN IF EXISTS target_type, DROP COLUMN IF EXISTS target_id;
--   DELETE FROM schema_migrations WHERE name = '0037_audit_entity.sql';
--   COMMIT;
