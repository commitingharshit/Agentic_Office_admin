---
title: Privacy and what is logged
---

# Privacy and what is logged

This page says what administrators can never see in the console, what they can see, and what the platform records about administrators. It is taken from how the admin API queries the database.

## What admins can never see

The admin API reads account data through a read-only database role. The queries behind the console never select:

- Document content, prompts, transcripts and model answers. They are encrypted on the person's devices.
- File names, workspace names and session titles. A user export leaves these columns out.
- Memories: only the count and stored size of a person's memories are shown, never their text or names.
- The contents of synced events. `session_events.payload` is never selected, and the read-only database role is not even granted that column. Only an event's type, count and time are shown.
- API key secrets. Keys are stored as hashes, and no admin page lists or reveals them.
- Passwords and one-time codes. Keycloak keeps those; the console shows only whether an authenticator app is set up.

Run, session and usage pages show ids, counts, timings, states and token numbers only.

## What admins can see

- Account facts: email, display name, sign-in provider, status, plan, dates, last activity, number of devices, workspaces, sessions, memories and bytes stored.
- Sign-in facts: device names and platforms, browser user agent, and IP addresses of sign-ins, as recorded from Keycloak.
- Credit ledger rows, with the reasons administrators typed.
- Text people chose to write for you: support tickets and replies, marketplace reviews, and install failure reasons (device-reported, with hosts, urls, emails, paths and ids removed).
- Order amounts, provider references and the bank reference an administrator typed.

The marketplace pages show user ids rather than emails.

## Shared usage is opt-in

Agent Runs, Product Analytics, Reliability and the app-version list are built only from people who turned on "share usage" in the app. It is off by default. Each of these pages states how many people share out of how many are active, and shows an empty state rather than zeros when nobody shares. Usage of a person's own API key or a local model never reaches the server and is never counted.

Support diagnostics are never collected automatically; a person can describe a problem in a ticket.

## What is logged about administrators

Every change an administrator makes is written to the audit log (Security & Audit) with who did it, the action, the person it concerns and details (such as a credit reason, a coupon code, a flag key). Refused actions are logged as `denied`. Entries made through the console also record which service token carried them.

Some views are logged too: opening Overview or the health data, listing or opening users, viewing a person's credits, listing coupons, exporting users (`export_users_csv`), and every marketplace read. Reads of Sessions, Agent Runs, Analytics, Reliability, Payments, Support, Flags, Plans and the audit log are not logged.

Deleting a marketplace review keeps only a hash and the length of its text in the audit log. SQL run through the API is logged with its text (first 4000 characters).

## The help assistant

The Help button sends only the question and the matching guide excerpts, plus your admin role, to the model provider. Emails, key-like strings, long hex or digit runs and bearer tokens are removed from the question first. No user records, audit rows or settings are sent. The platform keeps who asked, a hash and the length of the question (not the text), the guide pages used, and whether you voted it helpful. Do not paste customer details into it.
