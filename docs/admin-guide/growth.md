---
title: Growth pages
---

# Growth pages

The Growth group manages in-app campaigns (promotions, release notes and task notices), their email, and release rollouts. Every page needs `growth.read` (all roles). Changing anything needs `growth.write` (create and edit; superadmin only), `growth.publish` (go live, publish a creative, send email; superadmin only) or `releases.write` (releases; superadmin and engineer). Buttons you cannot use are hidden. Changes are audited; reading is not.

## Growth overview

Page: /admin/growth

The Growth overview page (Growth group, titled "Growth") shows what people saw in the app, what they did with it and whether it helps, for the last 30 days. Permission needed: `growth.read` (every role).

- **Choices people made**: Active people, how many switched in-app promotions off, how many agreed to marketing email, how many unsubscribed in this period.
- **Campaigns**: Campaign, Status, Tier, Served, Impressions, Reached, Clicks, CTR, Dismissed, Converted, Held out. **Served** is how many times the server handed the promotion to someone's app (once a day per person); **Impressions** is what the app reported showing; **Reached** is impressions as a share of served. High Served with low Reached means the app is being sent the promotion but not drawing it (for example an older app, a hidden placement or a media file that does not load); Served of zero on a live campaign means nobody is eligible or nobody is signed in. A warning mark means the dismiss rate is over the guardrail. Click a campaign to open it.

Guardrail: a live promotion with at least 50 impressions and more than 35.0% of them dismissed is paused automatically; the check runs every 10 minutes, and looks at the last 7 days. With `growth.publish` click **Check guardrails now** to run it at once; the page then names what was paused, or says every live promotion is within its guardrails. Automatic pauses are audited as `guardrail_pause` by `system`.

The admin decides what is eligible; the app decides how it looks; a person's ad-free plan or "no promotions" switch decides whether anything promotional appears. Release notes and task notices still reach everyone.

## Campaigns

Page: /admin/growth/campaigns

The Campaigns page (Growth group) lists campaigns and creates new ones. A campaign is one message with a creative for each place it can appear. Permission to open: `growth.read`. Creating needs `growth.write` (superadmin).

Create a campaign:

1. In **New campaign** enter **Name** (1-160 characters).
2. Choose **Kind**: Promotion, Release note or Task notice.
3. Set **Priority** (-100 to 100), **Starts** and **Ends** (blank start means now; the end must be after the start).
4. Set **Holdout %** (0-50): that share of eligible people is shown nothing, to compare them with those who saw it.
5. Set limits: **Max shows** (1-100), **per (hours)** and **Gap (minutes)** between shows.
6. Click **Create**. You land on the campaign page: "Add a creative, publish it, then put the campaign live."

The table shows Name, Status (live, paused, scheduled or ended, with the pause reason), Kind, Creatives (placement and status), Window and Changed. At most 200 campaigns are listed. Audited as `create_campaign`.

## Campaign detail

Page: /admin/growth/campaigns/[id]

The Campaign detail page (Growth group, opened from Campaigns or Growth overview) is where one campaign is built and run. Reading needs `growth.read`. Saving needs `growth.write`; Go live, Pause, End, Publish creative and Email need `growth.publish` (superadmin only).

Run the campaign, in order:

1. For each placement section (chat empty, inbox, bottom strip) fill the creative: **Kind** (image, clip or card), **Headline** (required for image and clip), **Body**, **Button label**, **Button action** and **Action argument**. For a card paste the card JSON (version 1, at most 8000 bytes, 1-8 blocks, at most 2 buttons). Click **Save draft**.
2. For an image or clip click **Upload image** or **Upload clip**. PNG, JPEG, WebP up to 10 MB; MP4, WebM, MOV up to 60 MB. Wait for the worker to process it. The inbox and bottom strip do not take video. Media limits per placement: 4 MB, 1 MB, 300 KB.
3. Click **Publish creative**. A creative must be ready before it can be served.
4. Set **Audience**: Only plans, Not plans, Platforms (darwin, win32, linux), Locales, App at least, Signed up after/before, Only these people (user ids). Click **Save audience**.
5. Click **Go live**. It needs at least one ready creative ("A campaign goes live only with at least one ready creative."). **Pause** and **End** stop it.

Check a person: in **Would this person see it?** enter **User id**, a **Placement** and click **Explain**. Edit settings in **Settings** (includes **Behind flag**). Promotions never reach ad-free plans or people who turned promotions off. Each change is audited.

## Campaign email

Page: /admin/growth/email

The Campaign email page (Growth group) holds email templates for campaigns. Emails go through Resend to people who agreed to product email. Permission to open: `growth.read`. Saving a template needs `growth.write` (superadmin). Sending is done from a campaign's page.

Save a template:

1. In **New template** enter **Name** and **Subject** (up to 200 characters; `{{name}}` allowed).
2. Write the **HTML** and **Plain text**. Both must contain `{{unsubscribe_url}}`; `{{name}}` and `{{unsubscribe_url}}` are the only placeholders. HTML with scripts, `javascript:` or event handlers is refused.
3. Click **Save template**. The list shows Name, Subject, Version, Changed.

Sending (on Campaign detail, **Email the audience**, needs `growth.publish`): the campaign must be live or scheduled. Only active people who agreed to marketing email and have not unsubscribed, within the audience, receive it, each at most once per campaign, up to 500 per press ("More are waiting: send again to continue."). A complaint or permanent bounce switches that person's marketing email off.

The server refuses to send, and nothing is sent, if there is no email provider key (`RESEND_API_KEY`, `AO_MAIL_FROM`) or no unsubscribe setup (`AO_PUBLIC_URL`, a public https address, and `AO_UNSUBSCRIBE_KEY`). Account, security and billing email never uses this.

## Releases

Page: /admin/growth/releases

The Releases page (Growth group) records what shipped, the feature flag it switches on, and how far it is rolled out. Permission to open: `growth.read`. Changing needs `releases.write` (superadmin, engineer). Rolling out here changes the feature flag of a build that is already installed; it does not ship or sign a new app build. Pausing stops more people getting the feature but does not undo what they did.

Create a release:

1. In **New release** enter **Version** (like 1.5.0), **Channel** (canary, beta, stable) and **Title** (up to 160 characters).
2. Pick **Feature flag** (an existing flag, or none). Add **Release notes (shown in the inbox)**.
3. Click **Save release**. Saving the same version and channel again updates it.

Roll out (the stage buttons show only when the release has a feature flag): click **1%**, **5%**, **25%**, **50%** or **100%** on the row. This switches the flag on for that share of people (the same person always lands in the same slice). **Pause** (0%) switches it off for everyone. Status becomes rolling out, complete (100%) or paused. The History column shows the stages.

Click **Post release note** to add the note to everyone's inbox. Audited as `save_release`, `stage_release`, `announce_release`.
