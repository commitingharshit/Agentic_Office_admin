-- ROLLBACK for 0021_marketplace.sql. NOT run by the migrator (db/migrations only): an operator runs it by hand, in a transaction, after
-- deploying the previous API image. Rolling back DROPS DATA in the objects listed. Roll back in reverse number order
-- (0028 first). schema_migrations must also lose the row: DELETE FROM schema_migrations WHERE name = '0021_marketplace.sql';
-- (use the column name your migrate.ts records). test/marketplace-migrations.test.ts applies the whole chain down and up again.
BEGIN;
DROP VIEW IF EXISTS marketplace_listing_stats;
DROP TABLE IF EXISTS marketplace_collection_items, marketplace_collections, marketplace_security_scans, marketplace_reports,
  marketplace_release_events, marketplace_listing_counters, marketplace_usage_events, marketplace_install_events, marketplace_installs,
  marketplace_favorites, marketplace_reviews, marketplace_submissions, marketplace_dependencies, marketplace_versions, marketplace_artifacts,
  marketplace_listings, marketplace_team_members, marketplace_teams, marketplace_publishers CASCADE;
DROP FUNCTION IF EXISTS marketplace_listings_search_update();
DROP FUNCTION IF EXISTS marketplace_versions_guard();
DROP FUNCTION IF EXISTS marketplace_installs_version_check();
DROP FUNCTION IF EXISTS marketplace_append_only();
DROP FUNCTION IF EXISTS marketplace_bump(text, int, int);
DROP FUNCTION IF EXISTS marketplace_count_favorites();
DROP FUNCTION IF EXISTS marketplace_count_installs();
DROP FUNCTION IF EXISTS marketplace_installed_status();
DROP FUNCTION IF EXISTS marketplace_version_status(text[]);
DROP FUNCTION IF EXISTS marketplace_visibility_guard();
COMMIT;
