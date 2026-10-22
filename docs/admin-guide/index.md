---
title: Admin console guide
---

# Admin console guide

This guide describes the Agentic Office admin console: where each feature is and how to use it. Every statement comes from the console and API code. The console lives at the `/admin` address of the control-plane service.

## What the admin console is

The admin console is a private web application for people who run Agentic Office. It shows account, billing, marketplace, growth and platform information, and lets an administrator change some of it (credits, plans, coupons, accounts, flags, campaigns, marketplace versions).

It never shows what people write or create: documents, prompts, file names and memories stay encrypted on their devices. See the Privacy page of this guide.

The console only answers on the host names listed in the server setting `ADMIN_HOSTS` (loopback only when unset). Any other host name gets a "Not found" page, even for an administrator. Every change goes through the admin API, which checks the role again and writes the audit log.

## Signing in

1. Open the console address and choose **Sign in**.
2. When the server uses Keycloak (`KEYCLOAK_ISSUER` is set), you are sent to Keycloak to sign in. The console session lasts 8 hours.
3. If your account is not an administrator you see "That page is for administrators." and, if you were signed in, a **Request admin access** button with an optional reason. A superadmin decides it on the Access requests page.
4. If an administrator already added your email, the invite is claimed at your first sign-in with that verified email.
5. Disabled accounts see "This account is disabled. Contact the administrator."

**Two-factor banner.** A yellow banner "Two-factor sign-in is not enforced for administrators" appears on every page when two-step sign-in is not required: with Keycloak, when `KEYCLOAK_ADMIN_OTP` is not `enforced`; without Keycloak, when `ADMIN_REQUIRE_MFA` is `false`. The banner is a reminder only. To set up your own authenticator app, follow the steps on the System Settings page.

## The layout

Left sidebar: the pages you may open, in six groups (Workspace, Business, Marketplace, Growth, Intelligence, System). A group or page you cannot open is not listed. **Collapse** shrinks the sidebar to icons; the choice is remembered in your browser.

Top bar, left to right: breadcrumbs, **Search users** box, **Help** button, **⌘K** button, a health dot (Healthy, Down or unknown: whether the admin API answers), the bell, and your name menu with your role and **Sign out**.

- **Search users.** Type an email, name or id and press Enter: opens the Users page filtered by that text. Press `/` anywhere (outside a text field) to jump into this box.
- **Command palette.** Press Ctrl+K (Windows, Linux) or Cmd+K (Mac), or click **⌘K**. Type to filter the pages you may open, or choose "Find a user" to search. Arrow keys move, Enter opens.
- **Help button.** Opens the help assistant, which answers how-do-I questions from this guide, with links to the pages it names. It is off ("not switched on for this server yet") until the platform owner adds a provider key. Vote Yes or No on each answer.
- **Bell.** The number is how many items need attention (red when one needs action). Click it to see them; "All notifications" opens the Notifications page.

## Pages in the Workspace group

| Page | What it is for | Permission (roles that hold it) |
|---|---|---|
| Overview (/admin) | Health of the platform: sign-ups, activity, compute, backups | overview.read (all roles) |
| Users (/admin/users) | Find an account, open its detail, export the list | users.read (all roles) |
| Sessions (/admin/sessions) | Synced work sessions: ids, counts, times | sessions.read (superadmin, engineer, support, analyst) |
| Agent Runs (/admin/runs) | Agent runs that people chose to share | runs.read (superadmin, engineer, support, analyst) |

## Pages in the Business group

| Page | What it is for | Permission (roles) |
|---|---|---|
| Billing & Plans (/admin/billing) | Plans, prices, subscriptions | plans.read (superadmin, support, finance, analyst) |
| Payments (/admin/payments) | Orders; check the bank, settle, reject, refund | payments.read (superadmin, engineer, support, finance) |
| Compute & Credits (/admin/compute) | Managed model usage; add credits by hand | usage.read (superadmin, engineer, finance, analyst) |
| Coupons (/admin/coupons) | Create and switch coupons | coupons.read (superadmin, support, finance, analyst) |
| Communications (/admin/communications) | In-app announcements and their email | comms.read (superadmin, support) |

## Pages in the Marketplace group

Marketplace permissions are not read from the role table. They come from the marketplace API's own role list (server setting `AO_MARKETPLACE_ROLES`); an administrator not listed there is read-only. See the Roles page.

| Page | What it is for | Permission |
|---|---|---|
| Overview (/admin/marketplace) | Counts and next submissions | marketplace.read |
| Catalog | Every listing with its latest version | marketplace.read |
| Publish New | Upload a package ZIP | marketplace.write |
| Submissions | Versions waiting for a decision | marketplace.read |
| Review Queue | Claim, approve, reject, publish | marketplace.review |
| Installations | What is installed where | marketplace.read |
| Usage Analytics | Install and rating figures | marketplace.read |
| Ratings & Reviews | Read and delete reviews | marketplace.read |
| Publishers | Who may publish, and their trust | marketplace.read |
| Agents & Bundles | Agent and bundle listings | marketplace.read |
| Team Assignments | What teams pinned (read-only) | marketplace.read |
| Install Policy | Organization install rules | marketplace.policy |
| Versions & Releases | Listings by last change | marketplace.read |
| Security Reports | Reports, pulled versions, bursts | marketplace.read |
| Advanced Types | Risky types and the per-type halt | marketplace.read |
| Type Policy | Review strictness per type | marketplace.policy |
| Settings | Your marketplace permissions (read-only) | marketplace.read |

## Pages in the Growth, Intelligence and System groups

| Page | What it is for | Permission (roles) |
|---|---|---|
| Growth overview (/admin/growth) | Funnel and guardrails of in-app campaigns | growth.read (all roles) |
| Campaigns (/admin/growth/campaigns) | Create and run campaigns | growth.read (all roles); changes need growth.write or growth.publish (superadmin) |
| Campaign email (/admin/growth/email) | Email templates for campaigns | growth.read (all roles); saving needs growth.write (superadmin) |
| Releases (/admin/growth/releases) | Releases and staged rollout | growth.read (all roles); changes need releases.write (superadmin, engineer) |
| Product Analytics (/admin/analytics) | What people do with the agent | analytics.read (superadmin, engineer, finance, analyst) |
| Reliability (/admin/reliability) | Success rate and failures of runs | runs.read (superadmin, engineer, support, analyst) |
| Support (/admin/support) | Tickets from the app | support.read (superadmin, engineer, support) |
| Feature Flags (/admin/flags) | Switch behaviour for everyone or a share | flags.read (superadmin, engineer, support, analyst) |
| Infrastructure (/admin/infrastructure) | Database, backups, sync health | infra.read (superadmin, engineer, analyst) |
| Notifications (/admin/notifications) | What needs a person now | overview.read (all roles) |
| Security & Audit (/admin/audit) | Every admin action | audit.read (superadmin, engineer, support, finance) |
| Access requests (/admin/access) | Approve people asking to be admins | roles.read (superadmin, engineer); deciding needs roles.write (superadmin) |
| Settings (/admin/settings) | Administrators, roles, integrations, two-step help | roles.read (superadmin, engineer); changes need roles.write (superadmin) |

No page in the nav is a "soon" placeholder: every item in the navigation list is built.
