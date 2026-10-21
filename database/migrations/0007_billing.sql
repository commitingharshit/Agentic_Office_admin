-- Plans, entitlements, credits, coupons, usage and API keys.
--
-- Money rules, enforced here and not in application code:
--  * credit_ledger is append-only (nobody holds UPDATE or DELETE); a balance is a sum of rows.
--  * The sync API role cannot write the ledger at all. It calls the ao_* functions below, which are
--    SECURITY DEFINER and always act for current_setting('app.user_id'), so a caller can only ever
--    redeem, reserve and settle for themselves.
--  * Reserving takes a per-user advisory lock, so two requests cannot both spend the same credits.
--  * A coupon redemption locks the coupon row, so the limit and the one-per-user rule hold under
--    concurrency. A coupon is never a credential: it only ever becomes a ledger grant.
-- Amounts are whole credits (bigint). Promotional credits are spent first and can expire; paid credits do not.

CREATE TABLE plans (
  id                 text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{1,40}$'),
  name               text NOT NULL,
  managed_inference  boolean NOT NULL DEFAULT false,
  features           jsonb NOT NULL DEFAULT '{}',
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plans(id, name, managed_inference) VALUES ('free', 'Free', false), ('beta', 'Beta', true);

CREATE TABLE subscriptions (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id     text NOT NULL REFERENCES plans(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  source      text
);

-- Per-user overrides of what a plan allows (a feature flag, a higher limit), optionally temporary.
CREATE TABLE entitlements (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL CHECK (key ~ '^[a-z0-9_.-]{1,60}$'),
  value       jsonb NOT NULL,
  expires_at  timestamptz,
  source      text,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE credit_ledger (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('grant', 'reserve', 'release', 'settle', 'expire', 'refund', 'adjust')),
  pool              text NOT NULL CHECK (pool IN ('promo', 'paid')),
  amount            bigint NOT NULL,
  reservation_id    bigint,
  grant_id          bigint REFERENCES credit_ledger(id),       -- an 'expire' row names the grant it expires
  coupon_code       text,
  grant_expires_at  timestamptz,                               -- on a promotional grant
  reason            text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('grant', 'release', 'refund') AND amount > 0)
      OR (kind IN ('reserve', 'settle') AND amount < 0)
      OR (kind = 'expire' AND amount <= 0)
      OR (kind = 'adjust' AND amount <> 0)),
  CHECK (kind <> 'expire' OR grant_id IS NOT NULL)
);
CREATE INDEX ix_ledger_user ON credit_ledger (user_id, id);
CREATE UNIQUE INDEX ux_ledger_one_expiry ON credit_ledger (grant_id) WHERE kind = 'expire';

CREATE TABLE credit_reservations (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      bigint NOT NULL CHECK (amount > 0),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'released')),
  request_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  closed_at   timestamptz,
  UNIQUE (user_id, request_id)
);

CREATE TABLE usage_events (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_id  bigint REFERENCES credit_reservations(id),
  request_id      text NOT NULL,
  model           text,
  tokens_in       bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out      bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost            bigint NOT NULL CHECK (cost >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);
CREATE INDEX ix_usage_user ON usage_events (user_id, created_at DESC);

-- Keys a user can use to call managed compute from their own tools. Only the hash is stored.
CREATE TABLE api_keys (
  id            text PRIMARY KEY,                    -- aok_<ulid>
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  prefix        text NOT NULL,                       -- first characters, so a user can tell keys apart
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX ix_api_keys_user ON api_keys (user_id);

CREATE TABLE coupons (
  code              text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{4,40}$'),
  amount            bigint NOT NULL CHECK (amount > 0),
  pool              text NOT NULL DEFAULT 'promo' CHECK (pool IN ('promo', 'paid')),
  max_redemptions   integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count    integer NOT NULL DEFAULT 0,
  starts_at         timestamptz,
  expires_at        timestamptz,
  grant_valid_days  integer CHECK (grant_valid_days IS NULL OR grant_valid_days > 0),   -- promotional credits expire this long after redemption
  plan_id           text REFERENCES plans(id),      -- also moves the user to this plan
  active            boolean NOT NULL DEFAULT true,
  note              text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (max_redemptions IS NULL OR redeemed_count <= max_redemptions)
);

CREATE TABLE coupon_redemptions (
  id           bigserial PRIMARY KEY,
  coupon_code  text NOT NULL REFERENCES coupons(code),
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id    bigint NOT NULL REFERENCES credit_ledger(id),
  redeemed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coupon_code, user_id)
);

-- Row-level security: a user sees only their own rows. Writes go through the functions below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'entitlements', 'credit_ledger', 'credit_reservations', 'usage_events', 'api_keys', 'coupon_redemptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I USING (user_id = current_setting('app.user_id', true))
                       WITH CHECK (user_id = current_setting('app.user_id', true))$p$, t);
  END LOOP;
END $$;

-- ── functions (SECURITY DEFINER: they act for app.user_id and nobody else) ──────────────────────

CREATE FUNCTION ao_uid() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'no_user'; END IF;
  RETURN v;
END $$;

-- Promotional grants past their date lapse (what is left of them), and reservations nobody settled
-- are released. Called by every function that reads or spends a balance.
CREATE FUNCTION ao_expire_due(p_uid text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; r record; promo bigint; take bigint;
BEGIN
  FOR r IN SELECT id FROM credit_reservations WHERE user_id = p_uid AND status = 'open' AND expires_at <= now() ORDER BY id LOOP
    INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id, reason)
      SELECT user_id, 'release', pool, -amount, r.id, 'reservation expired' FROM credit_ledger WHERE reservation_id = r.id AND kind = 'reserve';
    UPDATE credit_reservations SET status = 'released', closed_at = now() WHERE id = r.id;
  END LOOP;
  FOR g IN SELECT id, amount FROM credit_ledger gl
            WHERE gl.user_id = p_uid AND gl.kind = 'grant' AND gl.pool = 'promo' AND gl.grant_expires_at <= now()
              AND NOT EXISTS (SELECT 1 FROM credit_ledger e WHERE e.kind = 'expire' AND e.grant_id = gl.id)
            ORDER BY gl.grant_expires_at, gl.id LOOP
    SELECT coalesce(sum(amount), 0) INTO promo FROM credit_ledger WHERE user_id = p_uid AND pool = 'promo';
    take := least(g.amount, greatest(promo, 0));
    INSERT INTO credit_ledger(user_id, kind, pool, amount, grant_id, reason) VALUES (p_uid, 'expire', 'promo', -take, g.id, 'promotional credits expired');
  END LOOP;
END $$;

CREATE FUNCTION ao_credit_balance() RETURNS TABLE (promo bigint, paid bigint, reserved bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := ao_uid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(v, 0));
  PERFORM ao_expire_due(v);
  RETURN QUERY SELECT
    coalesce((SELECT sum(l.amount) FROM credit_ledger l WHERE l.user_id = v AND l.pool = 'promo'), 0)::bigint,
    coalesce((SELECT sum(l.amount) FROM credit_ledger l WHERE l.user_id = v AND l.pool = 'paid'), 0)::bigint,
    coalesce((SELECT sum(r.amount) FROM credit_reservations r WHERE r.user_id = v AND r.status = 'open'), 0)::bigint;
END $$;

CREATE FUNCTION ao_redeem_coupon(p_code text) RETURNS TABLE (amount bigint, pool text, plan_id text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := ao_uid(); c coupons%ROWTYPE; lid bigint;
BEGIN
  SELECT * INTO c FROM coupons WHERE code = upper(btrim(p_code)) FOR UPDATE;   -- serialises everyone redeeming this code
  IF NOT FOUND OR NOT c.active OR (c.starts_at IS NOT NULL AND c.starts_at > now()) OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN
    RAISE EXCEPTION 'coupon_invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE coupon_code = c.code AND user_id = v) THEN RAISE EXCEPTION 'coupon_already_redeemed'; END IF;
  IF c.max_redemptions IS NOT NULL AND c.redeemed_count >= c.max_redemptions THEN RAISE EXCEPTION 'coupon_exhausted'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v, 0));
  INSERT INTO credit_ledger(user_id, kind, pool, amount, coupon_code, grant_expires_at, reason)
    VALUES (v, 'grant', c.pool, c.amount, c.code,
            CASE WHEN c.pool = 'promo' AND c.grant_valid_days IS NOT NULL THEN now() + make_interval(days => c.grant_valid_days) END,
            'coupon ' || c.code) RETURNING id INTO lid;
  INSERT INTO coupon_redemptions(coupon_code, user_id, ledger_id) VALUES (c.code, v, lid);
  UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE code = c.code;
  IF c.plan_id IS NOT NULL THEN
    INSERT INTO subscriptions(user_id, plan_id, source) VALUES (v, c.plan_id, 'coupon ' || c.code)
      ON CONFLICT (user_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', source = excluded.source, started_at = now(), ends_at = NULL;
  END IF;
  RETURN QUERY SELECT c.amount, c.pool, c.plan_id;
END $$;

-- Holds `p_amount` credits for one request (promotional first). Refused when the balance cannot cover it.
-- The same request id returns the same reservation, so a retried call never holds twice.
CREATE FUNCTION ao_credit_reserve(p_amount bigint, p_request text, p_ttl_seconds integer DEFAULT 600) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := ao_uid(); rid bigint; promo bigint; paid bigint; from_promo bigint;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_request IS NULL OR btrim(p_request) = '' THEN RAISE EXCEPTION 'bad_request_id'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v, 0));
  PERFORM ao_expire_due(v);
  SELECT id INTO rid FROM credit_reservations WHERE user_id = v AND request_id = p_request;
  IF FOUND THEN RETURN rid; END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE pool = 'promo'), 0), coalesce(sum(amount) FILTER (WHERE pool = 'paid'), 0) INTO promo, paid FROM credit_ledger WHERE user_id = v;
  promo := greatest(promo, 0); paid := greatest(paid, 0);
  IF promo + paid < p_amount THEN RAISE EXCEPTION 'insufficient_credits'; END IF;
  from_promo := least(promo, p_amount);
  INSERT INTO credit_reservations(user_id, amount, request_id, expires_at) VALUES (v, p_amount, p_request, now() + make_interval(secs => greatest(p_ttl_seconds, 1))) RETURNING id INTO rid;
  IF from_promo > 0 THEN INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id) VALUES (v, 'reserve', 'promo', -from_promo, rid); END IF;
  IF p_amount - from_promo > 0 THEN INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id) VALUES (v, 'reserve', 'paid', -(p_amount - from_promo), rid); END IF;
  RETURN rid;
END $$;

-- Gives back the unused hold and charges what was really used (never more than was reserved).
CREATE FUNCTION ao_credit_settle(p_reservation bigint, p_cost bigint, p_model text, p_in bigint, p_out bigint) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := ao_uid(); r credit_reservations%ROWTYPE; uid bigint; promo bigint; cost bigint; from_promo bigint;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v, 0));
  SELECT * INTO r FROM credit_reservations WHERE id = p_reservation AND user_id = v FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation_not_found'; END IF;
  IF r.status = 'settled' THEN SELECT id INTO uid FROM usage_events WHERE reservation_id = r.id; RETURN uid; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'reservation_closed'; END IF;
  cost := least(p_cost, r.amount);
  INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id)
    SELECT user_id, 'release', pool, -amount, r.id FROM credit_ledger WHERE reservation_id = r.id AND kind = 'reserve';
  IF cost > 0 THEN
    SELECT coalesce(sum(amount), 0) INTO promo FROM credit_ledger WHERE user_id = v AND pool = 'promo';
    from_promo := least(greatest(promo, 0), cost);
    IF from_promo > 0 THEN INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id) VALUES (v, 'settle', 'promo', -from_promo, r.id); END IF;
    IF cost - from_promo > 0 THEN INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id) VALUES (v, 'settle', 'paid', -(cost - from_promo), r.id); END IF;
  END IF;
  UPDATE credit_reservations SET status = 'settled', closed_at = now() WHERE id = r.id;
  INSERT INTO usage_events(user_id, reservation_id, request_id, model, tokens_in, tokens_out, cost)
    VALUES (v, r.id, r.request_id, left(p_model, 100), greatest(coalesce(p_in, 0), 0), greatest(coalesce(p_out, 0), 0), cost) RETURNING id INTO uid;
  RETURN uid;
END $$;

-- The upstream call failed: give the whole hold back and charge nothing.
CREATE FUNCTION ao_credit_release(p_reservation bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text := ao_uid(); r credit_reservations%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(v, 0));
  SELECT * INTO r FROM credit_reservations WHERE id = p_reservation AND user_id = v FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation_not_found'; END IF;
  IF r.status <> 'open' THEN RETURN; END IF;
  INSERT INTO credit_ledger(user_id, kind, pool, amount, reservation_id, reason)
    SELECT user_id, 'release', pool, -amount, r.id, 'released unused' FROM credit_ledger WHERE reservation_id = r.id AND kind = 'reserve';
  UPDATE credit_reservations SET status = 'released', closed_at = now() WHERE id = r.id;
END $$;

-- Per-user balance for the admin views (the owner reads past row-level security).
CREATE VIEW admin_user_credits AS
  SELECT u.id AS user_id,
         coalesce(sum(l.amount) FILTER (WHERE l.pool = 'promo'), 0)::bigint AS promo,
         coalesce(sum(l.amount) FILTER (WHERE l.pool = 'paid'), 0)::bigint AS paid,
         coalesce((SELECT s.plan_id FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active'), 'free') AS plan_id
  FROM users u LEFT JOIN credit_ledger l ON l.user_id = u.id GROUP BY u.id;

-- ── grants ──────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION ao_uid(), ao_expire_due(text), ao_credit_balance(), ao_redeem_coupon(text),
  ao_credit_reserve(bigint, text, integer), ao_credit_settle(bigint, bigint, text, bigint, bigint), ao_credit_release(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ao_credit_balance(), ao_redeem_coupon(text), ao_credit_reserve(bigint, text, integer),
  ao_credit_settle(bigint, bigint, text, bigint, bigint), ao_credit_release(bigint) TO ao_app;

GRANT SELECT ON plans, subscriptions, entitlements, credit_ledger, credit_reservations, usage_events, coupon_redemptions TO ao_app;
GRANT SELECT, INSERT, UPDATE ON api_keys TO ao_app;

GRANT SELECT ON plans, subscriptions, entitlements, credit_ledger, credit_reservations, usage_events, coupons, coupon_redemptions, admin_user_credits TO ao_readonly;
GRANT SELECT (id, user_id, name, prefix, created_at, last_used_at, revoked_at) ON api_keys TO ao_readonly;

GRANT SELECT, INSERT, UPDATE ON plans, subscriptions, entitlements, coupons TO ao_admin;
GRANT DELETE ON entitlements TO ao_admin;
GRANT SELECT, INSERT ON credit_ledger TO ao_admin;                       -- append-only, even for the admin API
GRANT SELECT ON credit_reservations, usage_events, coupon_redemptions, admin_user_credits TO ao_admin;
GRANT SELECT, UPDATE (revoked_at) ON api_keys TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_admin;
