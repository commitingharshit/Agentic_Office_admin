-- ROLLBACK for 0022_marketplace_agents.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0022_marketplace_agents.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP TABLE IF EXISTS marketplace_team_assignments, marketplace_policy_rules, marketplace_policies CASCADE;
DROP FUNCTION IF EXISTS marketplace_assignment_status();
DROP FUNCTION IF EXISTS marketplace_team_assignments_guard();
DROP FUNCTION IF EXISTS marketplace_policies_guard();
DROP FUNCTION IF EXISTS marketplace_policy_rules_guard();
DROP FUNCTION IF EXISTS marketplace_effective_policy(text);
DROP FUNCTION IF EXISTS marketplace_is_team_manager(text) CASCADE;
DROP FUNCTION IF EXISTS marketplace_is_team_member(text) CASCADE;
COMMIT;
