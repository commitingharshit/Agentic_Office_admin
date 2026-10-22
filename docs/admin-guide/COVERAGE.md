---
title: Coverage of the admin guide
---

# Coverage of the admin guide

Maintainers' index: every navigation item in `apps/console/src/components/admin/nav.ts` and the guide file and section that covers it. This is not an end-user page.

## Navigation items

| Group | Menu label | Page | Permission | Guide file | Section |
|---|---|---|---|---|---|
| Workspace | Overview | /admin | overview.read | workspace.md | Overview |
| Workspace | Users | /admin/users | users.read | workspace.md | Users |
| Workspace | Sessions | /admin/sessions | sessions.read | workspace.md | Sessions |
| Workspace | Agent Runs | /admin/runs | runs.read | workspace.md | Agent Runs |
| Business | Billing & Plans | /admin/billing | plans.read | business.md | Billing & Plans |
| Business | Payments | /admin/payments | payments.read | business.md | Payments |
| Business | Compute & Credits | /admin/compute | usage.read | business.md | Compute & Credits |
| Business | Coupons | /admin/coupons | coupons.read | business.md | Coupons |
| Business | Communications | /admin/communications | comms.read | business.md | Communications |
| Marketplace | Overview | /admin/marketplace | marketplace.read | marketplace.md | Marketplace Overview |
| Marketplace | Catalog | /admin/marketplace/catalog | marketplace.read | marketplace.md | Catalog |
| Marketplace | Publish New | /admin/marketplace/publish | marketplace.write | marketplace.md | Publish New |
| Marketplace | Submissions | /admin/marketplace/submissions | marketplace.read | marketplace.md | Submissions |
| Marketplace | Review Queue | /admin/marketplace/review | marketplace.review | marketplace.md | Review Queue |
| Marketplace | Installations | /admin/marketplace/installations | marketplace.read | marketplace.md | Installations |
| Marketplace | Usage Analytics | /admin/marketplace/analytics | marketplace.read | marketplace.md | Usage Analytics |
| Marketplace | Ratings & Reviews | /admin/marketplace/reviews | marketplace.read | marketplace.md | Ratings & Reviews |
| Marketplace | Publishers | /admin/marketplace/publishers | marketplace.read | marketplace.md | Publishers |
| Marketplace | Agents & Bundles | /admin/marketplace/collections | marketplace.read | marketplace.md | Agents & Bundles |
| Marketplace | Team Assignments | /admin/marketplace/team-assignments | marketplace.read | marketplace.md | Team Assignments |
| Marketplace | Install Policy | /admin/marketplace/policies | marketplace.policy | marketplace.md | Install Policy |
| Marketplace | Versions & Releases | /admin/marketplace/releases | marketplace.read | marketplace.md | Versions & Releases |
| Marketplace | Security Reports | /admin/marketplace/security | marketplace.read | marketplace.md | Security Reports |
| Marketplace | Advanced Types | /admin/marketplace/advanced | marketplace.read | marketplace.md | Advanced Types |
| Marketplace | Type Policy | /admin/marketplace/type-policy | marketplace.policy | marketplace.md | Type Policy |
| Marketplace | Settings | /admin/marketplace/settings | marketplace.read | marketplace.md | Marketplace Settings |
| Growth | Growth overview | /admin/growth | growth.read | growth.md | Growth overview |
| Growth | Campaigns | /admin/growth/campaigns | growth.read | growth.md | Campaigns |
| Growth | Campaign email | /admin/growth/email | growth.read | growth.md | Campaign email |
| Growth | Releases | /admin/growth/releases | growth.read | growth.md | Releases |
| Intelligence | Product Analytics | /admin/analytics | analytics.read | intelligence.md | Product Analytics |
| Intelligence | Reliability | /admin/reliability | runs.read | intelligence.md | Reliability |
| Intelligence | Support | /admin/support | support.read | intelligence.md | Support |
| System | Feature Flags | /admin/flags | flags.read | system.md | Feature Flags |
| System | Infrastructure | /admin/infrastructure | infra.read | system.md | Infrastructure |
| System | Notifications | /admin/notifications | overview.read | system.md | Notifications |
| System | Security & Audit | /admin/audit | audit.read | system.md | Security & Audit |
| System | Access requests | /admin/access | roles.read | system.md | Access requests |
| System | Settings | /admin/settings | roles.read | system.md | Settings |

Items found: 39. None is marked `soon` in nav.ts, so no page is documented as a placeholder.

## Pages reached from the navigation (not menu items)

| Page | Guide file | Section |
|---|---|---|
| /admin/users/[id] | workspace.md | User detail; User detail: Authentication & Devices; User detail: usage, sessions, runs, marketplace and audit tabs |
| /admin/sessions/[id] | workspace.md | Session detail |
| /admin/runs/[id] | workspace.md | Run detail |
| /admin/payments/[id] | business.md | Payment detail |
| /admin/growth/campaigns/[id] | growth.md | Campaign detail |
| /admin/support/[id] | intelligence.md | Ticket detail |
| /admin/marketplace/review/[id] | marketplace.md | Review detail |
| /admin/marketplace/versions/[id] | marketplace.md | Version detail |
| /admin/export/users (Export CSV button) | workspace.md | Users |
| /admin/login, /admin/callback, /admin/logout | index.md | Signing in; The layout (Sign out) |
| /admin/help/ask, /admin/help/feedback (Help button) | index.md; privacy.md | The layout; The help assistant |
| /admin/marketplace/evidence/[id] (verification evidence images) | marketplace.md | Version detail (Verification) |

## Other guide files

- index.md: what the console is, sign-in, layout, tables of every nav item with its permission.
- roles.md: the five roles, the marketplace permission source, how to change a role.
- troubleshooting.md: sign-in, 403, disabled account, coupon, payment, marketplace 503, campaign email, two-factor banner, empty pages.
- privacy.md: what admins can never see, what they can see, what is logged, the help assistant.

## Not documented, and why

- No navigation page was left undocumented.
- Capabilities that exist in the admin API but have no console page or button, and so are only mentioned in roles.md: per-person metadata export (`users.export`), account deletion (`users.delete`, confirmed by typing the person's email), the read-only SQL endpoint (`sql.read`), and `settings.read`.
- The Support & Communications tab of User detail is a placeholder in the code; it is described as one.
