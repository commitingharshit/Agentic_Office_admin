-- One test promotion, shown only to one person (psql variable :email), in the empty chat window. Safe to run twice; remove with first-campaign-remove.sql.
-- Run as the owner role. Nothing here reaches anyone else: the audience is that one user id.
\set ON_ERROR_STOP on
SELECT id AS uid FROM users WHERE lower(email) = lower(:'email') AND status = 'active' \gset
\if :{?uid}
\else
  \echo 'No active person with that email. Sign in to the app once with it first.'
  \quit 1
\endif
INSERT INTO campaigns(id, name, status, tier, priority, starts_at, ends_at, holdout_pct, max_impressions, per_seconds, min_gap_seconds)
VALUES ('c_first_test', 'First campaign (test, one person)', 'live', 'promo', 100, now() - interval '1 hour', now() + interval '7 days', 0, 100, 86400, 0)
ON CONFLICT (id) DO UPDATE SET status = 'live', starts_at = now() - interval '1 hour', ends_at = now() + interval '7 days', holdout_pct = 0, paused_reason = NULL;
INSERT INTO campaign_targets(campaign_id, user_ids) VALUES ('c_first_test', ARRAY[:'uid'])
ON CONFLICT (campaign_id) DO UPDATE SET user_ids = ARRAY[:'uid'];
INSERT INTO creatives(id, campaign_id, placement_id, kind, headline, card, status)
VALUES ('cr_first_test', 'c_first_test', 'chat_empty', 'card', 'Hello from the growth engine',
        '{"v":1,"layout":"stack","blocks":[{"type":"badge","text":"Test"},{"type":"heading","text":"Hello from the growth engine"},{"type":"text","text":"If you can read this in your chat window, a campaign made it from the admin panel to the app."}]}', 'ready')
ON CONFLICT (id) DO UPDATE SET status = 'ready';
SELECT 'live for ' || :'email' AS result;
