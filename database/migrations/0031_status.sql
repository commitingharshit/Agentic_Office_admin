-- Which services are up or down. The prober writes one row per check; service_status is the current answer per service.
-- Only coarse facts live here (service id, a human label, up/degraded/down, when, how long it took): the public status page and
-- GET /v1/status read nothing else, so no version, host, size or tenant can leak through them.
CREATE TABLE service_status (
  service     text PRIMARY KEY CHECK (service ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  state       text NOT NULL CHECK (state IN ('up', 'degraded', 'down')),
  latency_ms  integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  checked_at  timestamptz NOT NULL DEFAULT now(),
  since       timestamptz NOT NULL DEFAULT now(),   -- when the state last changed
  sort        integer NOT NULL DEFAULT 100
);
CREATE TABLE status_checks (
  id          bigserial PRIMARY KEY,
  service     text NOT NULL CHECK (service ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  state       text NOT NULL CHECK (state IN ('up', 'degraded', 'down')),
  latency_ms  integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  checked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_checks_service_time ON status_checks (service, checked_at DESC);
CREATE INDEX status_checks_time ON status_checks (checked_at);

GRANT SELECT ON service_status, status_checks TO ao_readonly, ao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_status, status_checks TO ao_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ao_admin;
