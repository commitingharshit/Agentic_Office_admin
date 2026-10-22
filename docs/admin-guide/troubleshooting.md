---
title: Troubleshooting
---

# Troubleshooting

Common situations, each checked against the console and API code. Where the fix needs a server setting, ask the person who runs the platform.

## I cannot open the admin console

Page: /admin

If the console shows "Not found" for every page, the address you used is not in the server setting `ADMIN_HOSTS`. The console answers only on listed host names (loopback only when unset), even for administrators. `localhost` must also be listed, or every action ends on a "Not found" page after it succeeded.

If you see "That page is for administrators.", your account is not an administrator. Press **Request admin access** (shown when you are signed in) and ask a superadmin to approve it on the Access requests page; then sign in again.

If you see "This account is disabled. Contact the administrator.", a user with `users.write` must enable the account.

Other sign-in messages: "That sign-in took too long or was started in another window. Try again.", "Sign-in was cancelled.", "An account with this email already exists. Sign in the way you did before, or verify your email address first." and "Sign-in did not complete. Try again, and tell an administrator if it keeps happening." With Keycloak the console session lasts 8 hours; sign in again after that.

A red dot "Down" next to the bell means the admin API does not answer. Pages then show errors; "The admin API is not configured (AO_ADMIN_API_URL, AO_ADMIN_API_TOKEN)." means those settings are missing.

## An action shows a 403 or "Your admin role cannot do this"

Page: /admin

The message "Your admin role (support) cannot do this." means your role lacks the permission. Nothing was changed, and the refusal is recorded in the audit log as `denied`. Ask a superadmin to do it or to change your role (see the Roles page). In the marketplace the message reads "Your role (analyst) does not have marketplace.write."; the marketplace role list on the server decides those, not the role table. "This account is not an active admin." means the account was disabled or is no longer an administrator.

## A person cannot sign in to the app

Page: /admin/users

Open the person on the Users page. If Status is Disabled, click **Enable account** (needs `users.write`); the app refuses disabled accounts on every device with "This account is disabled. Contact the administrator." A deleted account answers "This account was deleted."

On the Authentication & Devices tab, the Keycloak section shows whether the account is enabled there, whether the email is verified, and recent events with errors. An unverified email never joins an existing account; the person must verify it. **Sign out everywhere** and **End all** (browser sessions) end stuck sessions so they can sign in fresh.

If a message says "Keycloak could not be updated; the account is still handled here, so try again", the change took effect in Agentic Office but Keycloak was unreachable.

## A coupon says it is not valid

Page: /admin/coupons

People see the same message, "This code is not valid.", for an unknown code, a disabled coupon, a coupon not yet started, an expired coupon and one whose uses are used up. "You have already used this code." means that person redeemed it before.

On the Coupons page check the row: State (disabled means **Enable** it), Valid until, and Used against the maximum. The "Code valid until" date counts from the start of that day (midnight UTC), so a code ends at the beginning of the date you chose. The console cannot edit an expiry or a maximum; create a new coupon instead. Credits already granted stay when a coupon is disabled.

## A payment is stuck or pending

Page: /admin/payments

Open the Payments page and read the status:

- **pending** (open checkout): no payment reported yet. Checkouts expire by themselves, after 10 minutes by default. Click **Reconcile now** on the order to ask the provider; it records what the provider says and activates nothing.
- **observed** or **review**: the provider says it is paid, which is not proof. Check the bank, then settle or reject. Settling is refused if the amount differs ("The bank amount (...) is not the order amount (...)"), the bank reference differs, a review order has no reference, or the person's account is not active.
- **expired**, **failed**, **rejected**: nothing was activated.

If the page says no payment provider is switched on, people cannot check out. Payment actions need `payments.write` (finance, superadmin).

## A marketplace upload fails with 503

Page: /admin/marketplace/publish

The Publish New page shows the server's answer:

- 503 `scanner_unavailable`: "Skill submissions are paused: the package security scanner is unavailable on this server." The scanner failed its start-up check. Ask the platform owner to fix it (it needs python3 and the vendored hermes-agent checkout); skill uploads stay paused until then.
- 503 `compiler_unavailable`: "Agent and bundle submissions are paused: the blueprint compiler is unavailable on this server." The server rechecks every minute and recovers by itself once its dependency is back.

Other refusals: "Publisher X does not exist; only a superadmin can create one."; the manifest id must start with the chosen publisher; 403 for public or org visibility without review permission; a file over 64 MiB; a file that is not a ZIP. A version showing "not verified" cannot be approved until a rescan verifies it; for templates this also happens when the render check is not set up.

If every marketplace button is missing or refused, you are not listed with a write role in the server's `AO_MARKETPLACE_ROLES`, so you are read-only.

## Campaign or announcement email is off

Page: /admin/communications

On Communications the Email tile says "not configured" and no **Email** button appears when there is no email provider key. The server needs `RESEND_API_KEY` and `AO_MAIL_FROM`. Campaign email adds: "Marketing email needs a working unsubscribe link: set AO_PUBLIC_URL (a public https address for this API) and AO_UNSUBSCRIBE_KEY. Nothing was sent." Email is also refused if the campaign is not live or scheduled. A template cannot even be saved without `{{unsubscribe_url}}` in both its HTML and its text.

If a send shows "N sent, M failed", failures are recorded; press the button again to retry only those people.

## The two-factor banner is showing

Page: /admin/settings

The yellow banner "Two-factor sign-in is not enforced for administrators" shows when two-step sign-in is not required: with Keycloak, when `KEYCLOAK_ADMIN_OTP` is not `enforced`; otherwise when `ADMIN_REQUIRE_MFA` is `false`. It does not block you. Set up your own authenticator on the Settings page (steps are there). The banner goes away only when the server setting is changed, which the platform owner does after everyone has registered an authenticator.

## A page is empty, or a campaign will not go live

Pages built on shared usage (Agent Runs, Product Analytics, Reliability, and App versions on Infrastructure) are empty until people turn on "share usage" in the app. This is expected, not a fault.

A campaign will not go live until a creative is published ("A campaign goes live only with at least one ready creative."). A creative cannot be published while its media is still processing ("The media is not processed yet"). A plan cannot be switched on without a price ("Set a price (0 for a free plan) before switching the plan on.").

## People say the app is down or sign-in does not work

Open Infrastructure (System group) and look at the Services table first. If Sign-in or App sign-in API is down or degraded, the problem is on the server side, not the person's account: the bell will also list it. Check the public status page at /status on the app's sign-in address from a network outside your own. If everything is up there, look at the one person: Users, then the user's Authentication tab shows their recent sign-ins and whether the account is disabled.
