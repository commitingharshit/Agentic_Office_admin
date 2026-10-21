-- A signed-in person who is not an administrator can ask for admin access; an administrator approves (choosing the admin role) or declines.
-- Approving goes through the same role code as every other role change, so its guards (active account, last superadmin) apply. The request
-- only records who asked, a short note, and what was decided and by whom.
CREATE TABLE access_requests (
  id            text PRIMARY KEY,                                           -- req_<ulid>
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note          text CHECK (note IS NULL OR length(note) <= 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,
  decided_role  text,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300)
);
-- one open request per person: asking twice shows the same request
CREATE UNIQUE INDEX ux_access_one_pending ON access_requests (user_id) WHERE status = 'pending';
CREATE INDEX ix_access_status ON access_requests (status, created_at DESC);
GRANT SELECT ON access_requests TO ao_readonly;
GRANT SELECT, INSERT, UPDATE ON access_requests TO ao_admin;
