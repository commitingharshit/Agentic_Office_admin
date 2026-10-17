-- Device metrics for System health: timings and gauges a device reports (event write latency,
-- checkpoint time, retrieval p95, extraction-queue lag, outbox depth). Numbers only, never
-- content. Kept 30 days.
CREATE TABLE device_metrics (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   text NOT NULL,
  metrics     jsonb NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_device_metrics_time ON device_metrics (reported_at DESC);
ALTER TABLE device_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON device_metrics USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
GRANT SELECT, INSERT ON device_metrics TO ao_app;
GRANT USAGE ON SEQUENCE device_metrics_id_seq TO ao_app;
GRANT SELECT ON device_metrics TO ao_readonly;
GRANT SELECT, DELETE ON device_metrics TO ao_admin;
