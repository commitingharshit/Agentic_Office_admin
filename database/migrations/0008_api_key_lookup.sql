-- An API key is checked before the caller's user id is known, exactly like a device token
-- (see 0003): the sign-in lookup mode may read the key row, to find whose it is.
CREATE POLICY key_lookup ON api_keys FOR SELECT USING (current_setting('app.signin', true) = 'on');
