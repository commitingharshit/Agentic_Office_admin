-- One live account per email address (case-insensitive). Better Auth links a Google or Microsoft sign-in to the existing person by
-- verified email, which only works if an email names one person. A deleted account does not hold its address.
-- Audited first on the live data (2026-10-21): no duplicates, no missing emails.
CREATE UNIQUE INDEX ux_users_email_live ON users (lower(email)) WHERE status <> 'deleted' AND email IS NOT NULL;
