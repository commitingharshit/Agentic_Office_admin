---
title: System pages
---

# System pages

The System group holds Feature Flags, Infrastructure, Notifications, Security & Audit, Access requests and Settings.

## Feature Flags

Page: /admin/flags

The Feature Flags page (System group) switches behaviour on or off for everyone, a plan, or a share of people. The server decides; the app only asks. Permission to open: `flags.read` (superadmin, engineer, support, analyst). Adding, changing and deleting need `flags.write` (superadmin, engineer).

Add or change a flag (saving an existing key overwrites it):

1. In **Add or change a flag** enter **Key**: lower-case letters, digits, `.` `_` or `-`, starting with a letter or digit, up to 60 characters.
2. Enter **What it does** (up to 300 characters).
3. Set **Rollout %** (whole number 0-100, default 100). A person always lands in the same slice of a rollout.
4. Optionally **Only these plans (comma-separated)**; blank means all plans.
5. Tick **On** and click **Save flag**.

The table shows Key, State, Rollout, Plans, What it does, Changed. To remove one click **Delete**, then **Delete flag**; anything that depended on it falls back to its default.

The flag `killswitch.managed_inference`, when on, makes the server refuse managed inference for the people it covers, whatever the app does. Audited as `save_flag` and `delete_flag`.

## Infrastructure

Page: /admin/infrastructure

The Infrastructure page (System group) shows what the platform runs on, read from the database and the backup store. Nothing here exposes a host secret and nothing can be changed. Permission needed: `infra.read` (superadmin, engineer, analyst).

Services table (at the top): which servers are up or down. One row per service (Database, Sign-in, Package verifier, App sign-in API, Status page and any others the platform runs) with its state (up, degraded or down), answer time, availability over 90 days, when it was last checked and since when it has been in this state. A single failed check shows as degraded; two in a row show as down; a slow answer is degraded. A service nobody has confirmed for 3 minutes is shown as down, because the checker itself may be what stopped. When something is down, the bell and Notifications list it ("N services are down: ...") for roles that can open this page. The same list without the details is public on the app's sign-in address under /status, for people who only need to know whether the service is up.

Tiles: Database (size, connections), Latest backup (hours ago; restore drill passed or FAILED), Sync in the last 24 hours (p95 lag), Devices reporting.

Checks table: Postgres (reachable, version, up since), Backups, WAL archiving. Backups count as healthy only when a backup store is configured, no error, and the latest backup is under 36 hours old; otherwise the row says "check". Also shown: the 12 largest tables (approximate rows, size) and App versions in use (known only from people who share usage; otherwise "None have, so this list is empty").

"No backup store configured" or "none have reported" are normal on a fresh install, not faults of the console. Opening the health data is audited as `view_health`.

## Notifications

Page: /admin/notifications

The Notifications page (System group) lists what needs a person right now, read from the database each time you open it. Permission needed: `overview.read` (every role). It lists only what your role can open. The bell in the top bar shows the same list.

Items, each with a level (Needs you, Look at, For your information):

- Payments waiting for a bank check (needs `payments.read`).
- Checkouts open for over an hour (`payments.read`).
- Payment notices with a bad signature in the last day (`payments.read`).
- Open support tickets (`support.read`).
- People asking for admin access (`roles.write`).
- New people in the last day (`users.read`).

Click an item to open the page it points at. With nothing to do the page says "Nothing needs attention".

Alerts are not sent anywhere by themselves: there is no email or chat delivery of notifications.

## Security & Audit

Page: /admin/audit

The Security & Audit page (System group) lists administrator actions, including the ones that were refused. Permission needed: `audit.read` (superadmin, engineer, support, finance).

1. Filter by **Action** (exact name such as `set_role`, `settle_payment`, `denied`) or **Target user id** (usr_...).
2. Read When, Admin (id; click to copy), Action, Target, Detail (the first 120 characters of the details). Newest first, 50 per page.
3. Refused actions appear as `denied` with the permission needed, the role, method and path.

What is written: changes (account, credits, plans, coupons, payments, flags, announcements, tickets, roles, growth, marketplace) and some views: `view_overview`, `view_health`, `list_users`, `view_user`, `view_credits`, `list_coupons`, `export`, `export_users_csv`, and every marketplace read (`marketplace.` prefix). Not written: reads of Sessions, Agent Runs, Product Analytics, Reliability, Payments, Support, Flags, Plans or the audit log itself. Entries made through the console show which service token carried them (`via`). Automatic guardrail pauses appear as `guardrail_pause` by `system`.

## Access requests

Page: /admin/access

The Access requests page (System group) lists people who signed in and asked to become administrators. Nobody is let in until a superadmin approves. Permission to open: `roles.read` (superadmin, engineer). Deciding needs `roles.write` (superadmin); others see "only an administrator who manages roles can decide them".

People ask from the sign-in screen: after "That page is for administrators." they press **Request admin access** with an optional reason (300 characters). Asking again reuses the open request.

Decide a request:

1. Open Access requests. Waiting requests show first; **Show history** includes decided ones, **Show waiting only** goes back.
2. To approve, pick a role in the box (default analyst) and click **Approve**. Choose the narrowest role that does the job.
3. To refuse, optionally type a **Reason** and click **Decline**.
4. Tell the person to sign in again: after approval they sign in again and the console opens.

A request is decided once ("This request was already approved."). Approving makes the person an administrator through the same guarded code as every role change; if that fails the request goes back to waiting. The decision must be made as a signed-in person. Audited as `approve_access` and `decline_access`. The bell counts pending requests for people who can decide them.

## Settings

Page: /admin/settings

The Settings page (System group) shows who can administer Agentic Office and how the console is protected. Permission to open: `roles.read` (superadmin, engineer). Changing needs `roles.write` (superadmin).

Sections:

- **Administrators**: Person, Status, Last active, Admin role. To change a role pick one in the box and click **Save**; you cannot change your own.
- **Add administrator**: enter the email, pick a role (default support) and click **Add administrator**. An existing account is promoted now; otherwise the person becomes an administrator the first time they sign in with that verified email. The **Waiting to sign in** table lists open invites; **Remove** deletes one. Adding someone who is already an administrator is refused.
- **Integrations**: Sign-in (Keycloak), Email delivery, Payments, Managed AI models: each says connected or not set up, with steps. Secrets are never typed into the console; they live in the server's environment files and in Keycloak.
- **Two-step verification**: shows whether administrators must use an authenticator app. With Keycloak, follow the numbered steps: open your Keycloak security page, Account security, Signing in, Authenticator application, **Set up**, scan the QR code, enter the 6-digit code, name the device and save. Enforcing the code for the admin role is a Keycloak realm setting, not a switch on this page.

Audited as `invite_admin`, `revoke_admin_invite`, `set_admin_role`. Rules for roles are on the Roles page.
