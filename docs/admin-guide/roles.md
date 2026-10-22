---
title: Admin roles and permissions
---

# Admin roles and permissions

Five admin roles exist: superadmin, engineer, support, finance and analyst. The API checks the role on every request; the console only hides what a role cannot open.

## How roles work

A person is an administrator when their account type is Administrator. Each administrator has one admin role. An administrator with no stored role counts as a superadmin (this is how accounts worked before roles existed).

The API checks a permission before every action. If your role lacks it, the action fails with "Your admin role (support) cannot do this." (HTTP 403) and the refusal is written to the audit log as a `denied` entry. When you see this, ask a superadmin to do it or to change your role.

A disabled administrator account is refused everywhere: "This account is not an active admin."

## Superadmin

Can do everything: every read, every change, plus all marketplace permissions (when the marketplace role list gives them that role). Only a superadmin can change roles, add administrators, decide access requests, create or edit campaigns and email templates, publish campaigns, and create or verify marketplace publishers. Only a superadmin holds `users.delete`, `roles.write`, `growth.write` and `growth.publish`.

Keep at least two superadmins: the last active superadmin cannot be demoted.

## Engineer

Keeps the product running. Can read: overview, users, roles and settings, sessions, agent runs, usage, product analytics, audit log, infrastructure, feature flags, support tickets, payments, growth. Can change: feature flags (`flags.write`) and release rollouts (`releases.write`).

Cannot: change any account, credits, coupons, plans or payments; see Billing & Plans, Coupons or Communications (it lacks `plans.read`, `coupons.read`, `comms.read`); change roles; edit campaigns.

## Support

Helps customers. Can read: overview, users, sessions, runs, credits, coupons, plans, communications, support tickets, audit log, flags, payments, growth. Can change: accounts (`users.write`: disable, enable, sign out, end device and browser sessions), announcements (`comms.write`), tickets (`support.write`), and download the users CSV.

Cannot: grant credits, change plans, coupons or payments, see Compute & Credits, Product Analytics, Infrastructure, Access requests or Settings, delete anyone, or change roles.

## Finance

Handles money. Can read: overview, users, credits, coupons, plans, payments, usage, product analytics, audit log, growth. Can change: credits (`credits.write`), coupons (`coupons.write`), plans and a person's plan (`plans.write`), and payments (`payments.write`: settle, reject, refund, reconcile).

Cannot: disable or change accounts, see sessions, runs, support, flags, infrastructure, Communications, Access requests or Settings.

## Analyst

Read-only product intelligence. Can read: overview, users, sessions, runs, usage, product analytics, infrastructure, flags, plans, coupons, growth. Cannot change anything, and cannot see payments, the audit log, support, communications, credits or roles.

## Marketplace permissions

The marketplace pages do not use the table above. They use the marketplace API's own list, set by the server setting `AO_MARKETPLACE_ROLES` (entries `user-id:role`). A role maps to: superadmin all of read, write, review, moderate, policy; engineer read, write, review; analyst read only; support and finance none.

An administrator who is not on that list is treated as analyst, so they can read the marketplace but not change it. If none are listed, the whole marketplace is read-only. Meaning of each permission: write submits packages and deprecates versions; review claims, approves, rejects and publishes; moderate quarantines, revokes, deletes reviews, resolves reports and halts a type; policy edits the install policy and type policy.

## What the console does not offer

Some API permissions have no button in the console: `users.export` (a per-person metadata export), `users.delete` (account deletion, which requires typing the person's email), `sql.read` (a read-only SQL endpoint) and `settings.read`. Use the API for these.

## Change someone's role

Needs `roles.write` (superadmin).

1. Open Users, then open the person.
2. On the Overview tab, find **Administrator access**. This section is hidden on your own account.
3. To make a user an administrator, set **Account type** to Administrator and click **Change role**. The new administrator gets the superadmin role at first, so next step is required.
4. Set **Administrator role** to the role they should have and click **Set role**.
5. To remove admin access, set **Account type** to User and click **Change role**. Their admin role is deleted.

Or use System Settings: pick a role next to a person under Administrators and click **Save**, or add someone by email with **Add administrator** (default role support).

Rules enforced by the API:

- You cannot change your own role: "You cannot change your own role."
- Only an active account can be made an administrator.
- The last active superadmin cannot be demoted or turned into a user: "That is the last admin. Make someone else an admin first." (or "...last superadmin..." when changing the admin role).
- A role change on an account that is not an admin first needs Account type = Administrator: "Make them an admin first."
- Every change is audited (`set_role`, `set_admin_role`). A change made with **Change role** is also copied to the person's Keycloak account when one is linked.
