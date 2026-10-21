-- Keycloak sign-in finds a person by the identity Keycloak gave them (provider 'keycloak', subject = Keycloak's user id) before anyone is known,
-- the same way the users table lets sign-in look people up. Reads only; writes still require the person's own id.
CREATE POLICY signin_lookup ON oauth_accounts FOR SELECT USING (current_setting('app.signin', true) = 'on');
