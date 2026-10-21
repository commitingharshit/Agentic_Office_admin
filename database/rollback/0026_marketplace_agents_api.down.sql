-- ROLLBACK for 0026_marketplace_agents_api.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0026_marketplace_agents_api.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP TRIGGER IF EXISTS trg_mkt_elevated_review_guard ON marketplace_versions;
DROP FUNCTION IF EXISTS marketplace_elevated_review_guard();
DROP TABLE IF EXISTS marketplace_team_audit CASCADE;
DROP FUNCTION IF EXISTS marketplace_dependency_status(text[]);
COMMIT;
