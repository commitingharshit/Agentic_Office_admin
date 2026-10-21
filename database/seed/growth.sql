-- LOCAL DEVELOPMENT SEED for the growth stack. It makes three people with fixed, publicly known dev tokens, one campaign on each placement,
-- a release and an email template, so the window and the console have something to show. NEVER run it against a real database:
-- it refuses unless the database holds nothing but seed people, or you set  SET ao.allow_seed = 'yes'  on purpose.
DO $$ BEGIN
  IF (SELECT count(*) FROM users WHERE id NOT LIKE 'usr_seed_%') > 0 AND coalesce(current_setting('ao.allow_seed', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'growth seed refused: this database has real people in it';
  END IF;
END $$;

INSERT INTO users(id, email, display_name, email_verified, role, status) VALUES
  ('usr_seed_free',   'free@seed.example.test',   'Free Fiona',      true, 'user',  'active'),
  ('usr_seed_adfree', 'adfree@seed.example.test', 'Ad-free Alex',    true, 'user',  'active'),
  ('usr_seed_optout', 'optout@seed.example.test', 'Opted-out Omar',  true, 'user',  'active'),
  ('usr_seed_admin',  'admin@seed.example.test',  'Admin Ada',       true, 'admin', 'active')
ON CONFLICT (id) DO NOTHING;

-- Dev tokens (the app sends these as Bearer tokens): aod_seed_<who>_dev_token. Only their hashes are stored, as for real tokens.
INSERT INTO device_tokens(id, user_id, token_hash, device_name, platform, expires_at)
SELECT 'dtk_seed_' || w, 'usr_seed_' || w, encode(sha256(convert_to('aod_seed_' || w || '_dev_token', 'UTF8')), 'hex'), 'seed ' || w, 'darwin', now() + interval '365 days'
FROM unnest(ARRAY['free', 'adfree', 'optout']) AS w ON CONFLICT (id) DO NOTHING;

INSERT INTO entitlements(user_id, key, value, source) VALUES ('usr_seed_adfree', 'ad_free', 'true'::jsonb, 'seed') ON CONFLICT DO NOTHING;
INSERT INTO user_promo_prefs(user_id, in_app) VALUES ('usr_seed_optout', false) ON CONFLICT (user_id) DO NOTHING;

-- One live campaign per placement, for everyone (no target lists), each a valid promo-card v1.
INSERT INTO campaigns(id, name, status, tier, priority, starts_at, max_impressions, per_seconds, min_gap_seconds) VALUES
  ('seed_chat',  'Seed: assistant tip',  'live', 'promo',   10, now() - interval '1 day', 100, 86400, 0),
  ('seed_inbox', 'Seed: inbox offer',    'live', 'promo',   10, now() - interval '1 day', 100, 86400, 0),
  ('seed_strip', 'Seed: bottom strip',   'live', 'promo',   10, now() - interval '1 day', 100, 86400, 0)
ON CONFLICT (id) DO NOTHING;
INSERT INTO campaign_targets(campaign_id) SELECT id FROM campaigns WHERE id LIKE 'seed_%' ON CONFLICT DO NOTHING;
INSERT INTO creatives(id, campaign_id, placement_id, kind, headline, body, cta_label, cta_action, card, status) VALUES
  ('seed_chat_cr', 'seed_chat', 'chat_empty', 'card', 'Try Pro', '', NULL, NULL,
   '{"v":1,"layout":"stack","tone":"accent","blocks":[{"type":"badge","text":"New"},{"type":"heading","text":"Longer documents, faster edits"},{"type":"text","text":"Pro raises the limits on documents and agent runs."}],"actions":[{"label":"See plans","action":{"command":"open_plans"}},{"label":"Not now","action":{"command":"dismiss"}}]}', 'ready'),
  ('seed_inbox_cr', 'seed_inbox', 'inbox', 'card', 'Spring offer', '', NULL, NULL,
   '{"v":1,"layout":"stack","blocks":[{"type":"heading","text":"Bring a colleague"},{"type":"checklist","items":["Share a document","Review edits together"]}],"actions":[{"label":"Learn more","action":{"command":"open_url","arg":"https://example.com/collab"}}]}', 'ready'),
  ('seed_strip_cr', 'seed_strip', 'bottom_strip', 'card', 'Tip', '', 'Plans', '{"command":"open_plans"}',
   '{"v":1,"layout":"row","blocks":[{"type":"heading","text":"Need more room to work?"}]}', 'ready')
ON CONFLICT (id) DO NOTHING;

INSERT INTO releases(id, version, channel, title, notes_md, status, published_at, created_by) VALUES
  ('seed_rel_1_96', '1.96.0', 'stable', 'Seed release', 'Seed release notes.', 'complete', now(), 'usr_seed_admin') ON CONFLICT (id) DO NOTHING;
INSERT INTO announcements(id, title, body, level, active, starts_at) VALUES
  ('ann_seed_release', 'What is new in 1.96', 'Seed release notes for the inbox.', 'info', true, now() - interval '1 hour') ON CONFLICT (id) DO NOTHING;

INSERT INTO email_templates(id, name, subject, html, text, updated_by) VALUES
  ('seed_welcome', 'Seed: product news', 'What is new in Agentic Office',
   '<p>Hello {{name}},</p><p>Seed product news.</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
   'Hello {{name}}, seed product news. Unsubscribe: {{unsubscribe_url}}', 'usr_seed_admin') ON CONFLICT (id) DO NOTHING;
