-- ROLLBACK for 0027_marketplace_verify_jobs.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0027_marketplace_verify_jobs.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP TABLE IF EXISTS marketplace_verify_jobs CASCADE;
COMMIT;
