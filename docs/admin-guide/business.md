---
title: Business pages
---

# Business pages

The Business group holds Billing & Plans, Payments, Compute & Credits, Coupons and Communications.

## Billing & Plans

Page: /admin/billing

The Billing & Plans page (Business group) shows what each plan costs and gives, and who is on it. Permission to open: `plans.read` (superadmin, support, finance, analyst). Creating or editing plans needs `plans.write` (finance, superadmin); other roles see no Edit button.

Sections: Plans (Plan, Price, Credits / month, Compute, Subscribers, State), New plan, and Subscriptions (User, Plan, Status, Since, Ends, Source). Active users with no subscription row are on the default free plan; the page counts them.

Edit a plan:

1. In the Plans table click **Edit** on the row.
2. Change fields: Name, What it is for, Price, Currency (3 letters, default inr), Billed (Not billed, Monthly, Yearly), Credits each month, Runs at once (1-100), Longest job (s) (10-86400), Requests / min (1-10000), Models (blank = all), May buy top-ups, Agentic Office compute, and On.
3. Click **Save**.

Create a plan: fill **New plan** (Id of 1-40 lower-case letters, digits, _ or -) and click **Create plan**. A new plan with a price is switched on at once; one without a price is a draft.

Rules: price is typed in whole units (rupees by default) and stored in cents; leaving Price blank removes the price. A plan can be on only with a price (0 for free): "Set a price (0 for a free plan) before switching the plan on." The free plan cannot be switched off. A payment never activates a plan by itself. Changes are audited (`create_plan`, `update_plan`).

## Payments

Page: /admin/payments

The Payments page (Business group) lists every order and what the payment provider reported. Permission to open: `payments.read` (superadmin, engineer, support, finance). A plan is activated only when an administrator confirms the bank received the money.

Read the page:

- Counters: to check (observed), in review, open checkouts, settled.
- **Status** box and **Filter** narrow the list: observed, review, pending, settled, failed, expired, cancelled, refunded, rejected. Orders needing a bank check sort first; up to 200 orders show.
- Yellow notices say if no provider is switched on (people cannot check out; old orders can still be reviewed) or the provider is experimental (a notice from it is an observation, never proof of payment).

Click an order id to open it. Open checkouts expire automatically (10 minutes after they are created by default). The notification bell warns of orders waiting for a bank check, checkouts open over an hour, and bad webhook signatures in the last day.

## Payment detail

Page: /admin/payments/[id]

The Payment detail page (Business group) shows one order and the steps you can take. Reading needs `payments.read`; every button needs `payments.write` (finance, superadmin). Each step needs a reason of 3 to 500 characters and is audited.

Settle an order the provider reported as paid (status observed or review):

1. Open your bank statement and find a credit of exactly the order amount.
2. Enter **Amount the bank received**. It must equal the order amount, or it is refused.
3. Enter **Bank reference** (6-40 letters, digits or hyphens). Required for an order in review that has no provider reference; if the provider gave one, yours must match.
4. Enter **How you checked** and click **Settle and activate**. The person's account must be active.

Other steps:

- **Reject (activates nothing)** with **Reject: why**: only for observed or review orders.
- **Reconcile now** (pending or created orders): asks the provider what it knows; records its answer; activates nothing. Refused if payments are not switched on.
- **Refund and return to Free** with **Why** (settled orders only): records the refund and takes the plan back. Sending the money back happens in your bank or with the provider, not here.

The page also lists What happened, Provider attempts and Notices received (signature valid or bad). Audit entries: `settle_payment`, `reject_payment`, `refund_payment`, `reconcile_payment`.

## Compute & Credits

Page: /admin/compute

The Compute & Credits page (Business group) shows inference that Agentic Office pays for, and the credits that pay for it. Permission to open: `usage.read` (superadmin, engineer, finance, analyst). Adding credits needs `credits.write` (finance, superadmin).

Only managed inference is counted. Requests made with a person's own API key or a local model never reach the server and are not shown.

1. Pick **Last 7 days**, 30 or 90 days and click **Apply**.
2. Read tiles: Managed requests, Credits spent (and granted), Tokens, Outstanding credits (promo and paid).
3. Choose the tab **By model**, **By user** (top 50 by credits) or **By day**.

Add credits by hand (**Add credits by hand** section):

1. Enter **Their email**: the exact email of an existing account; otherwise "No one has that email. They need to sign in once first."
2. Choose **Type**: Grant, Refund or Adjust (±), and **Pool**: Paid or Promotional.
3. Enter **Amount** (whole number, 1 to 1,000,000,000); only an adjustment may be negative, and a deduction may not take a pool below zero.
4. For a promotional grant optionally set **Expires after (days, promo)** (1-3650).
5. Enter **Reason (kept in the ledger)**, at least 3 characters, and click **Record**.

Audited as `adjust_credits` (reason kept to 200 characters).

## Coupons

Page: /admin/coupons

The Coupons page (Business group) creates coupons that turn into credit grants when someone redeems them. Permission to open: `coupons.read` (superadmin, support, finance, analyst). Creating or switching needs `coupons.write` (finance, superadmin).

Create a coupon:

1. Open **New coupon**.
2. **Code (blank to generate)**: 4-40 letters, digits, _ or - (made upper-case); blank makes one like AO-1A2B3C-4D5E6F. A repeat is refused: "That code already exists."
3. **Credits** (1 or more), **Pool** (Promotional or Paid).
4. Optional: **Max uses** (1 to 1,000,000; blank is unlimited), **Credits last (days)** (1-3650, promo credits only), **Also sets plan** (an active plan), **Code valid until** (date), **Note** (500 characters).
5. Click **Create**.

Switch a coupon: click **Disable** or **Enable** on its row and confirm. Disabling stops new redemptions; credits already granted stay.

The table (newest 500) shows Code, Credits, Pool, Used (of max), Plan, Valid until, Note, State. Audited as `create_coupon`, `disable_coupon`, `enable_coupon`.

Redeeming people see "This code is not valid." for an unknown, disabled, expired or used-up code, and "You have already used this code." if they used it. The valid-until date is read as the start of that day (midnight UTC), so the code stops working at the beginning of that date.

## Communications

Page: /admin/communications

The Communications page (Business group) publishes announcements people see inside the app, and can email them. Permission to open: `comms.read` (superadmin, support). Publishing and switching need `comms.write` (same two roles). Each person sees an announcement until they dismiss it.

Channel tiles: In-app (connected), Email (connected or "not configured"), WhatsApp ("No integration exists yet").

Publish an announcement:

1. In **New announcement** enter **Title** (up to 160 characters) and **Message** (up to 4000).
2. Pick **Kind**: Information or Warning.
3. Optionally **Only these plans** (comma-separated plan ids; blank = all) and **Stop showing on** (date).
4. Click **Publish**.

On a row, **Switch off** / **Switch on** hides or shows it. The table shows Read by and Emailed counts (and failures); newest 100 listed.

Email an announcement: the **Email** button appears only on a live announcement and only when email is connected. Type `SEND` and click **Send email**. It goes to every active person with an address who has not had it yet, up to 500 per press; each result is recorded. If some fail you see "N sent, M failed"; press again to retry them. Email is off until `RESEND_API_KEY` and `AO_MAIL_FROM` are set on the API service. Templates and scheduling are not built.
