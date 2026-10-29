-- Laya shadow mode for the app's own chat: Hermes on the person's laptop answers with their own model provider, then posts the request
-- to POST /v1/laya/predict. Those rows have no request id or model of ours, but carry the workspace note Laya reads and the route
-- Hermes took (inline / orchestrate) with how the turn ended, for comparison with Laya's pick.
ALTER TABLE laya_shadow ALTER COLUMN request_id DROP NOT NULL, ALTER COLUMN model DROP NOT NULL,
  ADD COLUMN workspace text, ADD COLUMN route text, ADD COLUMN status text;

COMMENT ON TABLE laya_shadow IS 'Laya shadow mode: a request''s last user message and Laya''s predicted pattern, from managed inference (with our request id and model) or from the app''s own chat via /v1/laya/predict (with the route Hermes took). Calibration data only; deleted after 60 days.';
