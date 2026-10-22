---
title: Marketplace pages
---

# Marketplace pages

The Marketplace group manages listings (templates, skills, agents, bundles and other types), their versions, publishers, review and security. Marketplace permissions come from the marketplace API's own role list (server setting `AO_MARKETPLACE_ROLES`), not from the Roles table; an administrator not on that list can read but not change anything. Every marketplace view and change is written to the audit log with an action starting `marketplace.`.

A version moves through these states: draft, validating, testing, submitted, in review, approved, published, rejected, deprecated, quarantined, revoked.

## Marketplace Overview

Page: /admin/marketplace

The Marketplace Overview page (Marketplace group) summarizes the marketplace. Permission needed: `marketplace.read`.

It shows tiles for Published listings (by type), Waiting for review (submitted and in review), Installs (active now, uninstalled), Failed installs (with failure rate) and Quarantined / revoked, plus a chart of published listings by type and the five oldest items under **Next up**. **Open review queue** opens the Review Queue page.

**How much the app reports** says how many devices report installs out of how many are known. Counts cover only those devices. "Not collected" lists figures with no data source (invocations, workflow completions, first-use activation); no number is shown for them.

## Catalog

Page: /admin/marketplace/catalog

The Catalog page (Marketplace group) lists every listing with its latest version; state and security outcome are the latest version's. Permission needed: `marketplace.read`.

1. Filter with **Search** (name or id), **Type**, **Publisher** (publisher id), **Visibility** (public, org, team, private), **State**, **Risk tier** (data, declarative, executable) and **Manual review**.
2. Read Name, Type, Risk, Publisher, Visibility and trust, State, Version, Installs, Active, Rating, Updated, Security, Verification (Pass, Partly, None, Failed).
3. Click a version number to open its Version detail page. Use **Next** for more.

## Publish New

Page: /admin/marketplace/publish

The Publish New page (Marketplace group) uploads a package ZIP. The server validates it; nothing is listed until a reviewer approves and publishes it. Permission needed: `marketplace.write` (superadmin, engineer when configured).

1. In Step 1 click the type: template, skill, agent or bundle are Available. Other types say "Not available from this page".
2. In Step 2 choose **Package (.zip)** (at most 64 MiB), **Publisher (existing only)**, **Visibility** (default private; public and org can only be asked by a role with review permission, others get 403) and, for team visibility, **Team id**.
3. Click **Upload and validate**.
4. Read the Validation result. "Not verified" means a required check did not run and the version cannot be approved until a rescan verifies it. A failed required check rejects the version automatically; it never enters the queue.

Errors you may see: skill uploads answer 503 scanner_unavailable when the package scanner is down; agent and bundle uploads answer 503 compiler_unavailable when the blueprint compiler is down; the manifest id must start with the publisher; a publisher below the type's minimum trust is refused. If no publisher exists, a superadmin creates one on Publishers.

## Submissions

Page: /admin/marketplace/submissions

The Submissions page (Marketplace group) lists versions waiting for a decision, oldest first, up to 100. Permission needed: `marketplace.read`. It only reads; deciding happens on Review Queue.

Use **State** to show submitted only or in review only. Columns: Listing, Type, Publisher, Version, State, Security (verdict and "not verified"), Submitted. Click the listing to open the Version detail. Packages that fail a required check are rejected at once and never appear here; find them in Catalog with State "rejected".

## Review Queue

Page: /admin/marketplace/review

The Review Queue page (Marketplace group) is where reviewers claim, approve, reject and publish versions. Reading needs `marketplace.read`; the buttons need the permission shown: `marketplace.review` for Claim, Approve, Reject and Publish; `marketplace.write` for Deprecate and Rescan; `marketplace.moderate` for Quarantine and Revoke.

Buttons appear only when the version's state allows them: Claim (submitted), Approve (submitted or in review), Reject (submitted, in review, approved), Publish (approved), Deprecate (published), Quarantine (published, approved, deprecated), Revoke (any version past testing that is not already revoked; final).

1. Click **Claim** to move a version to in review.
2. Click **Approve**. A verified security scan is required (409 scan_required or scan_failed otherwise).
3. Click **Publish**. It becomes installable by everyone the listing is visible to.
4. **Reject**, **Quarantine** and **Revoke** ask for a reason (up to 1000 characters). Revoke is final.

Separation of duties: you cannot approve or publish a version you submitted (409 self_review; a superadmin may). A version that needs manual review shows **Review summary** instead of Approve; see Review detail. Each action is audited.

## Review detail

Page: /admin/marketplace/review/[id]

The Review detail page (Marketplace group, opened from Review Queue) shows one submission in full: the summary the server built from the stored package, high-risk items, the automated checks and the acknowledgement step. Permission to open: `marketplace.read`; approving needs `marketplace.review`.

To approve a version that needs manual review:

1. Read every section of the summary and the High-risk items notice.
2. Tick **I reviewed this summary**.
3. Click **Approve this version**. The page sends the summary hash; the server refuses if the package changed (409 summary_ack_required).

A summary too large to show cannot be approved ("summary_truncated"). A manual-review version can never be approved or published by its own submitter or publisher, whatever their role (403 separation_of_duties). **Raw manifest and events** opens the Version detail.

## Version detail

Page: /admin/marketplace/versions/[id]

The Version detail page (Marketplace group, opened from Catalog or Submissions) shows one version: Manifest (type, summary, license, package size and hash, dependencies, review state), Requested permissions (sensitive ones highlighted), Security scan, Verification and Release events. Permission to open: `marketplace.read`.

Buttons follow the Review Queue rules (**Claim**, **Approve**, **Reject**, **Publish**, **Deprecate**, **Quarantine**, **Revoke**, **Rescan**). Rescan re-runs the validators on the stored package and needs `marketplace.write`.

Verification: **Run verification** (needs `marketplace.review`; submitted, in review or approved versions) records Pass, Partly (incomplete) or Failed per stage. To approve a Partly version, type a sentence of 20 to 500 characters saying why you accept the skipped checks; it is stored in the audit log (`marketplace.approve_incomplete`). A failed or missing verification blocks approval and publishing.

## Installations

Page: /admin/marketplace/installations

The Installations page (Marketplace group) shows what is installed where, as the apps reported it. Permission needed: `marketplace.read`.

1. Filter by **User id** (usr_...), **Listing id** (publisher/name) and **State** (requested, permission review, installed, configured, enabled, disabled, update available, failed, uninstalled).
2. Read Listing, Version, State, Enabled, Scan, User, Device, Scope, Last error, Updated. Click a user id to open that person's Marketplace tab.
3. Use **Next** for more.

The API returns user ids only, never emails. Counts exist only for devices that report.

## Usage Analytics

Page: /admin/marketplace/analytics

The Usage Analytics page (Marketplace group) shows install and rating figures from install records and reviews the apps report. Nothing is estimated. Permission needed: `marketplace.read`.

1. Filter with **Type**, **Publisher**, **From** and **To** dates.
2. Read tiles: Installs, Active installs, Failed installs (failure rate), On the latest version, Average rating, Security events (quarantines and revocations).
3. The By type table shows Published, Installs, Failed, Failure rate, Active, Awaiting config, Uninstalled, Quarantined, Revoked. Install failure reasons are device-reported text with hosts, urls, emails, paths and ids removed.

Coverage and gaps shows devices reporting out of known (global, not filtered) and what is not collected.

## Ratings & Reviews

Page: /admin/marketplace/reviews

The Ratings & Reviews page (Marketplace group) lists reviews newest first. Permission to read: `marketplace.read`. Deleting needs `marketplace.moderate` (superadmin); others see no Delete button.

1. Optionally filter by **Listing id**.
2. Read Listing, Stars, Review text, User, When.
3. To remove one click **Delete**, then **Delete review**. It is permanent and the listing's rating is recalculated.

The audit entry (`marketplace.delete_review`) keeps a hash and the length of the text, never the text.

## Publishers

Page: /admin/marketplace/publishers

The Publishers page (Marketplace group) shows who may publish and each publisher's trust (community, verified, official), which appears on all of its listings. Permission to read: `marketplace.read`. Creating or changing needs a superadmin; others see "Only a superadmin can create or verify publishers."

1. Open **Create or update a publisher**.
2. Enter **Id** (lowercase letters, digits, dashes), **Display name** (1-120 characters), **Owner user id (new publishers)** (optional) and **Trust**.
3. Click **Save publisher**.

On a row, **Verify** sets trust to verified and **Remove verification** returns it to community. Changing trust updates every non-private listing of that publisher. New publishers start unverified. Audited as `marketplace.create_publisher` / `update_publisher`.

## Agents & Bundles

Page: /admin/marketplace/collections

The Agents & Bundles page (Marketplace group) lists every agent and every bundle with its latest version. Permission needed: `marketplace.read`. Curated collections do not exist yet; the page only reads the catalog.

Read Name, Publisher, Visibility, State, Version, Updated. Click a version number to see its components, permissions and members on the Version detail page. Pinning a bundle to a team is done in the app, and shown on Team Assignments.

## Team Assignments

Page: /admin/marketplace/team-assignments

The Team Assignments page (Marketplace group) shows what each team has pinned, read-only. Team owners and admins change assignments from the app; this page never changes anything. Permission needed: `marketplace.read`.

1. Filter by **Team id** or **Listing** (publisher/slug), or click a team id to filter by it.
2. Read Listing, Type, Team, Mode, Pinned to (version and hash), Status.

A red notice appears when a pinned version was revoked or quarantined: members cannot install it, and an installed copy is disabled at its next sync. The page shows the 200 most recent assignments at most.

## Install Policy

Page: /admin/marketplace/policies

The Install Policy page (Marketplace group) sets the organization-wide rules every install is checked against. Teams can add stricter rules; a deny anywhere wins. Permission needed: `marketplace.policy` (superadmin). Without it you cannot even read the policy.

1. Choose **Mode**: open (allowed unless a rule denies) or allowlist (denied unless a rule allows).
2. Choose **Minimum publisher trust**: no minimum, private, community, verified or official.
3. Tick **Require a clean security scan** if wanted.
4. In **Rules** write one rule per line: `allow` or `deny`, then `listing`, `publisher` or `type`, then the value. Example: `deny type hook`, `allow publisher acme`, `deny listing acme/old-agent`. At most 500 rules; repeats are refused.
5. Click **Save policy**.

If no policy was saved yet, installs are unrestricted. A saved policy reaches each desktop at its next sync. Audited as `marketplace.org_policy_set`, and reading it as `marketplace.view_org_policy`.

## Versions & Releases

Page: /admin/marketplace/releases

The Versions & Releases page (Marketplace group) lists listings, most recently changed first. Permission needed: `marketplace.read`. The API has no cross-listing release-event feed yet, so this page links each listing to its version, where the full release history (claimed, approved, published, deprecated, quarantined, revoked, with who and why) is shown.

1. Filter by **Search**, **Type** or **Latest state**.
2. Read Listing, Latest version, State, Changed.
3. Click a version to open its Version detail page. Use **Next** for more.

## Security Reports

Page: /admin/marketplace/security

The Security Reports page (Marketplace group) gathers reports people filed against listings and the versions that were pulled. Permission to read: `marketplace.read`. Changing a report needs `marketplace.moderate` (superadmin).

Sections:

- **Quarantined and revoked**: listings whose latest version was pulled.
- **Failed or incomplete verification**: versions submitted, approved or published whose verification failed or is incomplete, with the checks that stopped it.
- **Suspicious install bursts**: listings with a burst of installs from brand-new accounts in the last 24 hours. Report only; nothing is done automatically.
- **Reports**: filter by **State** (open, triaged, actioned, dismissed); each shows Listing, Reason, Details, State, Filed.

Handle a report:

1. On an open report click **Triage** (you looked at it; it stays open).
2. Click **Actioned** when action was taken, which closes it, or **Dismiss**.

Audited as `marketplace.resolve_report`.

## Advanced Types

Page: /admin/marketplace/advanced

The Advanced Types page (Marketplace group) covers every type except template and skill (hook, bridge, connector, routine, memory, workflow, surface, agent, bundle), which run something or reach outside the app. Permission to read: `marketplace.read`. Halting needs `marketplace.moderate` (superadmin).

It lists Quarantined, Revoked, and "Live at the executable tier" versions, with Live installs and Open reports for each, and a **Halt a type** table.

Halt a type (emergency stop):

1. Click **Halt <type>** on that type's row.
2. Type the type name in the confirmation box.
3. Write a **Reason** of 3 to 1000 characters.
4. Click **Halt <type>**.

Every published or deprecated version of that type is quarantined at once. Devices stop using them at their next status check. New submissions are not blocked. The reason goes to the release history and the audit log (`marketplace.halt_type`).

## Type Policy

Page: /admin/marketplace/type-policy

The Type Policy page (Marketplace group) shows how strictly each listing type is reviewed. The built-in floor can be raised, never lowered. Permission needed: `marketplace.policy` (superadmin).

Columns: Type, Floor, Now (marked "raised" when changed), Supported ("not yet" means the type is not supported), and a Raise form.

1. On the type's row choose a risk tier (data, declarative, executable), tick or clear **manual review**, and choose the minimum publisher trust.
2. Type a **Reason (required)** of 3 to 1000 characters.
3. Click **Save**.

Refused: a risk tier or trust below the floor, or switching off manual review where the floor requires it. Audited as `marketplace.set_type_policy`, with the before and after values.

## Marketplace Settings

Page: /admin/marketplace/settings

The Marketplace Settings page (Marketplace group) is read-only and shows your effective marketplace configuration. Permission needed: `marketplace.read`. Nothing here can be changed from the console.

Rows: Your role; Your marketplace permissions (read lists, write submits and deprecates, review claims, approves, rejects and publishes, moderate quarantines, revokes and deletes reviews); Roles source (set on the API service as `AO_MARKETPLACE_ROLES`, a comma list of `adminName:role`; without it every admin is read-only); Skill security scanner and OfficeCLI render check, both "Not reported by the API". When the scanner is down, skill uploads answer 503 scanner_unavailable; when the render check is unavailable, a template check is skipped and the version stays "not verified".
