-- 0034: memory text on the server, so administrators can read a person's memories in the console.
-- Before this, memories reached the server only as encrypted blobs. Now the device also sends the
-- plaintext of each synced memory (never one kept "on this computer only": those are never synced).
-- Its own table, not a column on memory_references, so the SQL runner (ao_readonly) cannot read it:
-- only the sync API (ao_app, own rows) and the admin API (ao_admin) can.
CREATE TABLE memory_contents (
  memory_id  text PRIMARY KEY REFERENCES memory_references(memory_id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_memcontent_user ON memory_contents (user_id);

ALTER TABLE memory_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_contents FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON memory_contents USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_contents TO ao_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_contents TO ao_admin;

COMMENT ON TABLE memory_contents IS 'The plaintext of each synced memory, for administrators to read in the console. Not readable by the SQL runner. Removed when the person forgets the memory.';
COMMENT ON TABLE memory_references IS 'Pointers to agent memory items a person synced: id, kind and version. The text is in memory_contents.';
