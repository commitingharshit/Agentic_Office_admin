-- Four plans with prices and entitlements in the database, and the payment records behind them.
-- Money is integers in minor units with a currency code. A provider's notice is only ever an OBSERVATION; settling an order is a separate step done by
-- ao_activate_order, which either does all of its work or none, and cannot run twice for one order.

-- ── prices ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE plan_prices (
  plan_id           text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  currency          text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  billing_interval  text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),          -- paise for inr, cents for usd: never a float
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, currency, billing_interval)
);
INSERT INTO plan_prices(plan_id, currency, billing_interval, amount_minor)
  SELECT id, 'inr', coalesce(billing_interval, 'month'), price_cents FROM plans WHERE price_cents IS NOT NULL;
ALTER TABLE plans DROP COLUMN price_cents, DROP COLUMN currency, DROP COLUMN billing_interval;

-- ── entitlements of a plan (enforced by the server, never by the app) ───────────────────────────
ALTER TABLE plans
  ADD COLUMN max_concurrent_runs  integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 100),     -- cloud requests in flight at once
  ADD COLUMN max_job_seconds      integer NOT NULL DEFAULT 600 CHECK (max_job_seconds BETWEEN 10 AND 86400),
  ADD COLUMN requests_per_minute  integer NOT NULL DEFAULT 20 CHECK (requests_per_minute BETWEEN 1 AND 10000),
  ADD COLUMN allowed_models       text[],                                                                        -- NULL = every model the platform offers
  ADD COLUMN top_up_eligible      boolean NOT NULL DEFAULT false;

-- Four plans. Pro, Max 5x and Max 20x are DRAFTS: inactive, no price and no included credits until the owner approves them.
DELETE FROM plans WHERE id = 'team' AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE plan_id = 'team') AND NOT EXISTS (SELECT 1 FROM coupons WHERE plan_id = 'team');
UPDATE plans SET sort_order = 0,  description = 'Local editing with your own model key or a local model, and a small cloud allowance.' WHERE id = 'free';
-- The beta plan predates limits: its testers keep generous ones rather than falling to the new defaults.
UPDATE plans SET max_concurrent_runs = 20, requests_per_minute = 600 WHERE id = 'beta';
UPDATE plans SET sort_order = 10, name = 'Pro', description = 'Regular use of Agentic Office compute, advanced agents and more simultaneous runs.', max_concurrent_runs = 2, requests_per_minute = 40, top_up_eligible = true WHERE id = 'pro';
INSERT INTO plans(id, name, description, managed_inference, active, sort_order, max_concurrent_runs, requests_per_minute, top_up_eligible) VALUES
  ('max5x',  'Max 5x',  'A much larger allowance for heavy daily work, with more simultaneous agent runs.', true, false, 20, 5,  80,  true),
  ('max20x', 'Max 20x', 'The largest allowance, for power users and heavy workflows, with priority capacity.', true, false, 30, 10, 120, true)
ON CONFLICT (id) DO NOTHING;

-- ── plan changes, for the record ────────────────────────────────────────────────────────────────
CREATE TABLE plan_change_events (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_plan  text,
  to_plan    text,
  reason     text NOT NULL,
  order_id   text,
  actor      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_plan_changes_user ON plan_change_events (user_id, created_at DESC);

-- ── ledger: say where a grant came from, and never let one reason grant twice ───────────────────
ALTER TABLE credit_ledger ADD COLUMN source text, ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX ux_ledger_idempotency ON credit_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── payments ────────────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE invoice_seq START 1001;

CREATE TABLE payment_orders (
  id                   text PRIMARY KEY,                                   -- ord_<ulid>; also the order id given to the provider
  user_id              text NOT NULL REFERENCES users(id),
  plan_id              text NOT NULL REFERENCES plans(id),
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),            -- copied from plan_prices at checkout, never from the client
  currency             text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  billing_interval     text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  provider             text NOT NULL,
  status               text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'observed', 'review', 'settled', 'failed', 'expired', 'cancelled', 'refunded', 'rejected')),
  expires_at           timestamptz NOT NULL,
  observed_at          timestamptz,
  provider_reference   text,                                                -- the bank reference the provider reported (UTR), if any
  settled_at           timestamptz,
  settled_by           text,
  settlement_evidence  jsonb,
  review_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_orders_user ON payment_orders (user_id, created_at DESC);
CREATE INDEX ix_orders_status ON payment_orders (status, created_at DESC);
-- one live checkout per person and plan: two clicks, or two windows, share the same order
CREATE UNIQUE INDEX ux_orders_one_open ON payment_orders (user_id, plan_id) WHERE status IN ('created', 'pending');

CREATE TABLE payment_attempts (
  id                   text PRIMARY KEY,
  order_id             text NOT NULL REFERENCES payment_orders(id),
  provider             text NOT NULL,
  provider_payment_id  text,
  checkout_url         text,
  status               text NOT NULL DEFAULT 'created',
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX ix_attempts_order ON payment_attempts (order_id);

-- Everything a provider told us, kept as received; (provider, delivery id) is unique so a replay changes nothing.
CREATE TABLE payment_events (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,
  delivery_id     text,
  order_id        text REFERENCES payment_orders(id),
  event           text NOT NULL,
  signature_ok    boolean NOT NULL,
  payload         jsonb,
  outcome         text NOT NULL,                                          -- what we did with it: observed, review, ignored_duplicate, rejected_amount, ...
  received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_events_delivery ON payment_events (provider, delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX ix_events_order ON payment_events (order_id, id);

CREATE TABLE subscription_periods (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id),
  plan_id    text NOT NULL REFERENCES plans(id),
  order_id   text NOT NULL UNIQUE REFERENCES payment_orders(id),          -- one period per paid order
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL CHECK (ends_at > starts_at),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_periods_user ON subscription_periods (user_id, starts_at DESC);

CREATE TABLE invoices (
  id            text PRIMARY KEY,
  number        text NOT NULL UNIQUE,
  user_id       text NOT NULL REFERENCES users(id),
  order_id      text NOT NULL UNIQUE REFERENCES payment_orders(id),
  plan_id       text NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      text NOT NULL,
  period_id     text REFERENCES subscription_periods(id),
  issued_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_invoices_user ON invoices (user_id, issued_at DESC);

-- ── settlement: all or nothing, once per order ──────────────────────────────────────────────────
CREATE FUNCTION ao_activate_order(p_order text, p_actor text, p_evidence jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o payment_orders%ROWTYPE; pl plans%ROWTYPE; s subscriptions%ROWTYPE; period_id text; inv_id text; inv_no text;
        starts timestamptz; ends timestamptz; had_active boolean; credits bigint := 0; grant_id bigint; from_plan text;
BEGIN
  SELECT * INTO o FROM payment_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF o.status = 'settled' THEN RETURN jsonb_build_object('already', true, 'order_id', o.id); END IF;       -- a second attempt does nothing
  IF o.status NOT IN ('observed', 'review') THEN RAISE EXCEPTION 'order_not_settleable:%', o.status; END IF;
  IF p_evidence IS NULL OR p_evidence->>'amount_minor' IS NULL OR (p_evidence->>'amount_minor')::bigint <> o.amount_minor OR lower(coalesce(p_evidence->>'currency', '')) <> o.currency THEN
    RAISE EXCEPTION 'amount_mismatch';
  END IF;
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'actor_required'; END IF;
  SELECT * INTO pl FROM plans WHERE id = o.plan_id;
  PERFORM set_config('app.user_id', o.user_id, true);      -- the rows below belong to the buyer; row-level security is satisfied honestly
  SELECT * INTO s FROM subscriptions WHERE user_id = o.user_id FOR UPDATE;
  had_active := FOUND AND s.status = 'active' AND s.plan_id = o.plan_id AND s.ends_at IS NOT NULL AND s.ends_at > now();
  from_plan := CASE WHEN FOUND AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > now()) THEN s.plan_id ELSE 'free' END;
  starts := CASE WHEN had_active THEN s.ends_at ELSE now() END;                                            -- renewing the same plan continues from where it ends
  ends := starts + CASE o.billing_interval WHEN 'year' THEN interval '1 year' ELSE interval '1 month' END;
  period_id := 'per_' || substr(md5(o.id || 'period'), 1, 24);
  INSERT INTO subscription_periods(id, user_id, plan_id, order_id, starts_at, ends_at) VALUES (period_id, o.user_id, o.plan_id, o.id, starts, ends);
  INSERT INTO subscriptions(user_id, plan_id, status, started_at, ends_at, source) VALUES (o.user_id, o.plan_id, 'active', CASE WHEN had_active THEN s.started_at ELSE now() END, ends, 'payment ' || o.id)
    ON CONFLICT (user_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', started_at = excluded.started_at, ends_at = excluded.ends_at, source = excluded.source;
  inv_id := 'inv_' || substr(md5(o.id || 'invoice'), 1, 24);
  inv_no := 'AO-' || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-' || nextval('invoice_seq');
  INSERT INTO invoices(id, number, user_id, order_id, plan_id, amount_minor, currency, period_id) VALUES (inv_id, inv_no, o.user_id, o.id, o.plan_id, o.amount_minor, o.currency, period_id);
  IF pl.monthly_credits > 0 THEN
    credits := pl.monthly_credits * CASE o.billing_interval WHEN 'year' THEN 12 ELSE 1 END;
    INSERT INTO credit_ledger(user_id, kind, pool, amount, grant_expires_at, reason, created_by, source, idempotency_key)
      VALUES (o.user_id, 'grant', 'promo', credits, ends, 'plan allowance, ' || pl.name, p_actor, 'plan_period', 'order:' || o.id) RETURNING id INTO grant_id;
  END IF;
  INSERT INTO plan_change_events(user_id, from_plan, to_plan, reason, order_id, actor) VALUES (o.user_id, from_plan, o.plan_id, CASE WHEN had_active THEN 'renewal' ELSE 'payment' END, o.id, p_actor);
  UPDATE payment_orders SET status = 'settled', settled_at = now(), settled_by = p_actor, settlement_evidence = p_evidence, updated_at = now() WHERE id = o.id;
  RETURN jsonb_build_object('order_id', o.id, 'period_id', period_id, 'invoice_id', inv_id, 'invoice_number', inv_no, 'credits', credits, 'starts_at', starts, 'ends_at', ends);
END $$;

-- A settled order that is refunded: the plan period ends now and what is left of its allowance is withdrawn. (The money itself is returned outside this system.)
CREATE FUNCTION ao_refund_order(p_order text, p_actor text, p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o payment_orders%ROWTYPE; g record; promo bigint; take bigint := 0; ended boolean := false;
BEGIN
  SELECT * INTO o FROM payment_orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF o.status = 'refunded' THEN RETURN jsonb_build_object('already', true); END IF;
  IF o.status <> 'settled' THEN RAISE EXCEPTION 'order_not_refundable:%', o.status; END IF;
  IF coalesce(btrim(p_actor), '') = '' OR coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'reason_required'; END IF;
  PERFORM set_config('app.user_id', o.user_id, true);
  UPDATE subscriptions SET status = 'cancelled', ends_at = now() WHERE user_id = o.user_id AND source = 'payment ' || o.id;
  ended := FOUND;
  SELECT id, amount INTO g FROM credit_ledger WHERE idempotency_key = 'order:' || o.id AND kind = 'grant';
  IF FOUND AND NOT EXISTS (SELECT 1 FROM credit_ledger e WHERE e.kind = 'expire' AND e.grant_id = g.id) THEN
    SELECT coalesce(sum(amount), 0) INTO promo FROM credit_ledger WHERE user_id = o.user_id AND pool = 'promo';
    take := least(g.amount, greatest(promo, 0));
    INSERT INTO credit_ledger(user_id, kind, pool, amount, grant_id, reason, created_by, source) VALUES (o.user_id, 'expire', 'promo', -take, g.id, 'refunded: ' || p_reason, p_actor, 'refund');
  END IF;
  INSERT INTO plan_change_events(user_id, from_plan, to_plan, reason, order_id, actor) VALUES (o.user_id, o.plan_id, 'free', 'refund: ' || p_reason, o.id, p_actor);
  UPDATE payment_orders SET status = 'refunded', updated_at = now(), review_reason = p_reason WHERE id = o.id;
  RETURN jsonb_build_object('order_id', o.id, 'subscription_ended', ended, 'credits_withdrawn', take);
END $$;

-- ── the billing role: payment records only. It cannot read people, settle an order or touch the ledger. ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ao_billing') THEN CREATE ROLE ao_billing LOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO ao_billing;
GRANT SELECT ON plans, plan_prices TO ao_billing;
GRANT SELECT (id, email, status) ON users TO ao_billing;
GRANT SELECT, INSERT, UPDATE ON payment_orders, payment_attempts TO ao_billing;
GRANT SELECT, INSERT ON payment_events TO ao_billing;
GRANT UPDATE (order_id, outcome) ON payment_events TO ao_billing;
GRANT USAGE ON SEQUENCE payment_events_id_seq TO ao_billing;
CREATE POLICY billing_reads_users ON users FOR SELECT TO ao_billing USING (true);

REVOKE ALL ON FUNCTION ao_activate_order(text, text, jsonb), ao_refund_order(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ao_activate_order(text, text, jsonb), ao_refund_order(text, text, text) TO ao_admin;

-- ── everyone else ───────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON plan_prices TO ao_app, ao_readonly, ao_admin;
GRANT INSERT, UPDATE, DELETE ON plan_prices TO ao_admin;
GRANT SELECT ON payment_orders, payment_attempts, payment_events, subscription_periods, invoices, plan_change_events TO ao_readonly, ao_admin;
GRANT UPDATE (status, review_reason, updated_at) ON payment_orders TO ao_admin;
GRANT INSERT ON payment_events TO ao_admin;
GRANT USAGE ON SEQUENCE payment_events_id_seq TO ao_admin;
GRANT SELECT ON plan_change_events, subscription_periods, invoices TO ao_app;
GRANT SELECT ON payment_orders TO ao_app;
GRANT INSERT ON plan_change_events TO ao_admin;
GRANT USAGE ON SEQUENCE plan_change_events_id_seq TO ao_admin;
ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_own_read ON payment_orders FOR SELECT TO ao_app USING (user_id = current_setting('app.user_id', true));
CREATE POLICY orders_billing ON payment_orders TO ao_billing USING (true) WITH CHECK (true);
CREATE POLICY orders_staff ON payment_orders TO ao_readonly, ao_admin USING (true) WITH CHECK (true);
ALTER TABLE subscription_periods ENABLE ROW LEVEL SECURITY; ALTER TABLE invoices ENABLE ROW LEVEL SECURITY; ALTER TABLE plan_change_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON subscription_periods FOR SELECT TO ao_app USING (user_id = current_setting('app.user_id', true));
CREATE POLICY own_rows ON invoices FOR SELECT TO ao_app USING (user_id = current_setting('app.user_id', true));
CREATE POLICY own_rows ON plan_change_events FOR SELECT TO ao_app USING (user_id = current_setting('app.user_id', true));
CREATE POLICY staff ON subscription_periods TO ao_readonly, ao_admin USING (true);
CREATE POLICY staff ON invoices TO ao_readonly, ao_admin USING (true);
GRANT SELECT ON invoices TO ao_billing;
CREATE POLICY billing_reads ON invoices FOR SELECT TO ao_billing USING (true);
CREATE POLICY staff ON plan_change_events TO ao_readonly, ao_admin USING (true) WITH CHECK (true);
