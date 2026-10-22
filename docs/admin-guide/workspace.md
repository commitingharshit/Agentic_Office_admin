---
title: Workspace pages
---

# Workspace pages

The Workspace group holds the Overview, Users, Sessions and Agent Runs pages.

## Overview

Page: /admin

The Overview page (Workspace group, first item in the sidebar) shows how the platform is doing from what the server records. Permission needed: `overview.read` (every role).

What it shows:

- Eight tiles: Registered users, New this week, Active this week, Devices, Synced events, Managed requests, Credits spent, Admin actions. "Admin actions" counts changes, not page views.
- User growth and activity charts: sign-ups per day, and active people per day (people who synced or used a managed model).
- Platform health: Database, Backups, Restore drill, WAL archiving, Sync, Devices reporting. **Details** opens Infrastructure.
- Compute and credits chart, and Recent activity (12 newest events; **Audit log** opens Security & Audit, which needs `audit.read`).

How to change the period:

1. Pick **Last 7 days**, 14, 30 or 90 days in the Date range box (default 14).
2. Click **Apply**.

Quick actions at the bottom: **Find a user**, **Create a coupon**, **Manage plans**.

Notes: "Active" is not a login count. Compute figures cover only managed (Agentic Office paid) models; bring-your-own-key and local-model use never reaches the server. Opening this page is audited as `view_overview`, and the health card as `view_health`.

## Users

Page: /admin/users

The Users page (Workspace group) lists everyone with an account, 25 per page. Permission needed: `users.read` (every role).

Find a person:

1. Type in **Search** (email, name or id).
2. Narrow with **Status** (Active, Disabled, Deleted), **Role** (User, Admin), **Plan**, **Sign-in** (Google, Microsoft, GitHub), and **Joined from** / **to** dates.
3. Click a column heading (User, Joined, Last active, Devices) to sort.
4. Click a person to open their detail page.

The table shows User, ID (click to copy), Sign-in, Plan, Role, Status, Joined, Last active, Devices and Credits. Deleted accounts only show when you pick Status = Deleted.

To download the list, click **Export CSV**. It keeps the current filters, holds up to 10,000 rows and has the columns id, email, display_name, role, status, providers, created_at, last_active_at, devices, workspaces, sessions, storage_bytes, memories. Cells that start with = + - or @ are quoted. Any role with `users.read` can export, and each export is audited as `export_users_csv`.

Listing is audited as `list_users`, with the filters used.

## User detail

Page: /admin/users/[id]

The User detail page (Workspace group, opened from Users) is one person's account, with eight tabs: Overview, Authentication & Devices, Workspace Sessions, Agent Runs, Usage & Credits, Support & Communications, Security & Audit, Marketplace. Permission to open: `users.read`; each tab needs its own read permission and says "Your role cannot view ..." without it. Opening is audited as `view_user`.

Buttons at the top (need `users.write`: support, superadmin; hidden on your own account):

1. **Disable account**: confirm "Disable account". The person cannot sign in again until enabled; their data is kept. A disabled account is refused on every device ("This account is disabled. Contact the administrator."). Keycloak is updated too when linked.
2. **Enable account**: lets them sign in again.
3. **Sign out everywhere**: ends device sign-ins and Keycloak sessions. It is separate from browser sessions (see the Authentication & Devices tab).

Overview tab: Status, Plan, Devices, Work sessions, Memories tiles, an Account card, and these forms:

- **Grant or adjust credits** (needs `credits.write`): Type, Pool, Amount, Expires after, Reason, **Record**. See Compute & Credits for the rules.
- **Plan** (needs `plans.write`): choose a plan and click **Set plan**. This changes the plan without a payment.
- **Administrator access** (needs `roles.write`): see the Roles page.

## User detail: Authentication & Devices

Page: /admin/users/[id]

The Authentication & Devices tab of the User detail page (Workspace group) shows how a person signs in and where. It needs `sessions.read` (superadmin, engineer, support, analyst). Without it the tab says "Your role cannot view sign-in sessions."

Sections:

- **Keycloak**: Account status, Email verified, Authenticator app (Set up or Not set up), live sessions and recent events. Shown only when Keycloak is configured. Button **End Keycloak sessions** (needs `users.write`) also signs them out of every desktop device.
- **Sign-in history**: when, through what, app, device, address. Recorded only from the moment people sign in through Keycloak.
- **Sign-in methods**: linked providers and whether each is active or revoked.
- **Device sign-ins**: desktop tokens with Device, Platform, Signed in, Last used, Expires, State. Click **Sign out** on a live row, then **Sign out device**.
- **Browser sessions**: click **End** on one row, or **End all**, to sign them out of the browser. Both need `users.write`.
- **Registered devices**: name, platform, app version, first and last seen.

Each of these actions is audited (`revoke_device`, `revoke_browser_sessions`, `sign_out`).

## User detail: usage, sessions, runs, marketplace and audit tabs

Page: /admin/users/[id]

These tabs of the User detail page (Workspace group) show one person's records.

- **Workspace Sessions**: their synced work sessions (id, events, started, last event); needs `sessions.read`. Contents stay encrypted.
- **Agent Runs**: runs they shared; empty unless the person turned on "share usage" in the app; needs `runs.read`.
- **Usage & Credits**: Paid credits, Promotional credits, Managed requests, Plan, and the Credit ledger (When, Kind, Pool, Amount, Why, By; newest 100). Needs `credits.read` (superadmin, support, finance).
- **Support & Communications**: a placeholder. It says tickets and messages will be listed "once the Support and Communications modules are switched on". Use the Support page for tickets.
- **Security & Audit**: the audit entries naming this person as target (newest 50); needs `audit.read`. Refused attempts show as `denied`.
- **Marketplace**: Installed, Failed installs, Favorites, Reviews tiles; installed extensions, teams, favorites and reviews. Needs `marketplace.read`.

## Sessions

Page: /admin/sessions

The Sessions page (Workspace group) lists work sessions synced from people's devices: when and how active, never what was said. Permission needed: `sessions.read` (superadmin, engineer, support, analyst).

1. Type an email or session id in **Search**.
2. Read the table: Session, User, Events, Started, Last activity. Click Started or Last activity to sort.
3. Click a session id to open it, or a user to open their account.

Titles, prompts and documents are encrypted on the device, so only ids, owner, event counts and times appear. Reading this page is not written to the audit log.

## Session detail

Page: /admin/sessions/[id]

The Session detail page (Workspace group, opened from Sessions) shows one synced session: tiles for Events, Started, Last event and Agent runs; a chart of Events by type; and a table of Agent runs (Run, Agent, State, Started, Tokens; up to 50). Permission needed: `sessions.read`.

Event contents are never shown: only types, counts and times. The Agent runs table is empty ("No runs shared for this session") unless the person shares usage. Click a run id to open the run.

## Agent Runs

Page: /admin/runs

The Agent Runs page (Workspace group) lists what the agent did as ids, states, timings and token counts, 25 per page. Permission needed: `runs.read` (superadmin, engineer, support, analyst).

1. Read the blue notice first: "X of Y active users have shared run details". Runs arrive only from people who opted in to share usage; nothing is collected by default.
2. Use **State** to filter: Running, Succeeded, Failed, Cancelled.
3. Read Run, User, Agent, State, Started, Duration, Tokens. Click a run id to open it.

With nobody sharing, the page says "No agent runs shared yet". This is expected, not a fault.

## Run detail

Page: /admin/runs/[id]

The Run detail page (Workspace group, opened from Agent Runs) shows one run: its State, run id, the person, and tiles for Agent, Started, Duration (or "running") and Tokens (in and out). A table lists Sub-runs started by this run; click one to open it. Permission needed: `runs.read`. No prompts, outputs or document content are shown.
