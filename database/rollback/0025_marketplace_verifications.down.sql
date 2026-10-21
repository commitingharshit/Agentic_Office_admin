-- ROLLBACK for 0025_marketplace_verifications.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0025_marketplace_verifications.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP TRIGGER IF EXISTS trg_mkt_verification_gate ON marketplace_versions;
DROP FUNCTION IF EXISTS marketplace_verification_gate();
DROP TABLE IF EXISTS marketplace_verifications CASCADE;
DROP FUNCTION IF EXISTS marketplace_verifications_guard();
DROP FUNCTION IF EXISTS marketplace_verifications_append_only();
DROP TABLE IF EXISTS marketplace_settings CASCADE;
COMMIT;
