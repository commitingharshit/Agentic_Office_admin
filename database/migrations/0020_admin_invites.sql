-- An administrator adds another administrator by email before that person has ever signed in. The invite waits; the first time the
-- person signs in to the console with that VERIFIED email, they become an administrator with the chosen role (through the same guarded
-- role code as every other change). An unverified email never claims an invite. Invites are used once and can be revoked.
CREATE TABLE admin_invites (
  email        text PRIMARY KEY CHECK (email = lower(email) AND length(email) <= 320),
  admin_role   text NOT NULL,
  invited_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  accepted_by  text
);
GRANT SELECT ON admin_invites TO ao_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_invites TO ao_admin;
