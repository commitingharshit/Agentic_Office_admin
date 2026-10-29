-- Live Laya: the gateway asks Laya before a turn (route laya_live:rules_*, status pending) and, when the turn ends, reports who really
-- decided (Laya, or the rules when Laya was too slow or failed), the route and status, and the session/response ids that a Keep/Undo
-- in laya_outcome carries. turn_id is the gateway's own id for the turn, sent with the ask, so the report finds the row even when the
-- gateway stopped waiting for Laya and never saw the answer.
ALTER TABLE laya_shadow ADD COLUMN turn_id text, ADD COLUMN decided_by text, ADD COLUMN session_id text, ADD COLUMN response_id text;
CREATE INDEX ix_laya_shadow_turn ON laya_shadow (user_id, turn_id) WHERE turn_id IS NOT NULL;

-- The app role may find its own row by turn_id and fill in these columns, still without reading anyone's words (user_id: the
-- row-level policy reads it).
GRANT SELECT (user_id, turn_id) ON laya_shadow TO ao_app;
GRANT UPDATE (route, status, decided_by, session_id, response_id) ON laya_shadow TO ao_app;
