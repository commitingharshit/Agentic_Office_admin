---
title: Intelligence pages
---

# Intelligence pages

The Intelligence group holds Product Analytics, Reliability and Support. The first two are computed only from people who turned on "share usage" in the app (off by default); every figure is read against the number of people sharing, never against all users.

## Product Analytics

Page: /admin/analytics

The Product Analytics page (Intelligence group) shows what people do with the agent: who gets a first result, and which modes and documents they use. Permission needed: `analytics.read` (superadmin, engineer, finance, analyst).

1. Pick **Last 7 days**, 30 or 90 days in the Date range box and click **Apply** (default 30).
2. Read the notice first: "X of Y active users share usage." Every figure below covers only those people.
3. Tiles: People sharing, Ran the agent, Got a successful result (with the share of those who ran it).
4. Tables: **Compute mode** (Agentic Office compute, Own API key, Local model, Not stated), **Document types checked** (by format), **Agents**; plus a Runs per day chart.

If nobody shares, the page shows "Nobody is sharing usage yet" instead of zeros. This is expected: sharing is off by default. Reading this page is not written to the audit log.

## Reliability

Page: /admin/reliability

The Reliability page (Intelligence group) shows how often the agent finishes the job, how long it takes and where it fails. Permission needed: `runs.read` (superadmin, engineer, support, analyst).

1. Pick **Last 7 days**, 14, 30 or 90 days and click **Apply** (default 14).
2. Read the notice: how many active users share usage, and how many of them sent runs in the period.
3. Tiles: Success rate (succeeded out of finished runs; cancelled and still-running runs are left out), Runs, Median duration, 95th percentile.
4. Sections: Runs per day, Failures by category, Client versions, Tools (calls, failed, failure rate, retries; top 20), Models, Document checks.

With no shared runs the page says "No shared runs in this period" and shows no rate, rather than a rate of zero. The rate describes only people who share usage, not everyone.

## Support

Page: /admin/support

The Support page (Intelligence group) lists tickets people open from the app. Nothing arrives unless the person writes it; diagnostics are never collected automatically. Permission to open: `support.read` (superadmin, engineer, support). Replying and changing status need `support.write` (superadmin, support).

1. Use **Status** to filter: Open, Waiting for the person, Closed.
2. Read Subject, From, Status, Messages, Last activity (newest 200 tickets).
3. Click a subject to open the ticket.

The bell and Notifications page count open tickets for roles that can read support.

## Ticket detail

Page: /admin/support/[id]

The Ticket detail page (Intelligence group, opened from Support) shows one ticket's conversation. Reading needs `support.read`; replying and changing status need `support.write` (superadmin, support).

Reply:

1. Open the ticket. The Conversation section lists every message, the person's and support's.
2. In **Reply**, write the **Message** (1 to 4000 characters).
3. Click **Send reply**. The ticket moves to Waiting for the person.

Change status: use the status box at the top (Open, Waiting for the person, Closed) and click **Set**. A closed ticket shows no reply box, and the person cannot reply to it ("This ticket is closed. Open a new one."). When the person replies, the ticket reopens as Open. A person can have at most 10 tickets open at once. Replies and status changes are audited (`reply_ticket`, `set_ticket_status`). The text shown is what the person wrote, as written.
