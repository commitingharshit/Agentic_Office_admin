# Do promotions reach the app?

The chain, and how to see where one breaks.

1. **Campaign is live** (admin: Growth, status live, inside its dates, kill switch `killswitch.promotions` off, creative approved, media variants ready for a clip).
2. **Person is eligible**: signed in, in-app promotions on, not on an ad-free plan, matches the targeting, under the frequency cap, not dismissed, not in the holdout slice.
3. **App asks**: the desktop app calls `GET /v1/promotions/eligible?placement=…&contract=1` with the device token on the placements `chat_empty`, `inbox` and `bottom_strip`. A signed-out window asks nothing.
4. **Gate lets it through**: `/v1/*` is open on the public API gate; `/admin/*` and webhooks are not.
5. **Server answers** and records **served** (once a day per person, campaign and placement).
6. **App draws it** and posts `impression`; clicks and dismissals follow. Media comes from signed `/v1/promotions/media/<id>` links on the same server.

Admin Growth shows Served, Impressions and Reached per campaign. Read them like this:

| Served | Impressions | Meaning |
|---|---|---|
| 0 | 0 | Nobody was eligible or nobody is signed in (check steps 1-3). |
| many | 0 | The server sends it, the app does not draw it (old app, placement hidden, media not loading). |
| many | close to Served | Delivered. |

Read-only check on the live database (run by the owner; the agent does not read production):

```sql
SELECT k.name, k.status,
       count(*) FILTER (WHERE e.type='served')     AS served,
       count(*) FILTER (WHERE e.type='impression') AS impressions,
       count(*) FILTER (WHERE e.type='holdout')    AS held_out,
       max(e.ts) AS last_event
  FROM campaigns k LEFT JOIN promo_events e ON e.campaign_id = k.id AND e.ts > now() - interval '7 days'
 GROUP BY k.id ORDER BY k.created_at DESC;
```

Before this change ("served" arrived with migration 0033) only impressions existed, so an ad that never left the server looked the same as one the app never drew.
