-- ROLLBACK for 0028_marketplace_type_policy_admin.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0028_marketplace_type_policy_admin.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP TRIGGER IF EXISTS trg_mkt_type_policy_floor ON marketplace_type_policy;
DROP FUNCTION IF EXISTS marketplace_type_policy_floor_guard();
ALTER TABLE marketplace_type_policy
  DROP CONSTRAINT IF EXISTS marketplace_type_policy_floor_tier,
  DROP CONSTRAINT IF EXISTS marketplace_type_policy_floor_trust,
  DROP COLUMN IF EXISTS floor_risk_tier, DROP COLUMN IF EXISTS floor_manual_review, DROP COLUMN IF EXISTS floor_min_publisher_trust,
  DROP COLUMN IF EXISTS updated_by, DROP COLUMN IF EXISTS updated_at;
COMMIT;
