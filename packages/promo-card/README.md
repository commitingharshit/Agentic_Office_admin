# promo-card

The declarative content of an Agentic Office promotion (heading, text, image, metric, checklist, badge, up to two buttons from a fixed
list of actions) and its validator, `validateCard`. One source: `src/card.ts`. `scripts/dev/sync-promo-card.mjs` copies it, byte for
byte under a generated header, to the three places that cannot import `packages/` (the accounts-sync container, the desktop fork, the
admin console); `verify-repo-invariants.sh` fails if a copy drifts.

The server validates a card before it can be published and the app validates it again before drawing it, so a card that fails either is
never shown. A card holds no HTML, script, style or URL the app fetches on its own; media is named by role and attached by the server.

- Test: `cd packages/promo-card && node --test test/*.test.ts` (includes a seeded fuzz over 4,000 mutated cards).
- Used by: `services/accounts-sync/src/growth/`, `services/control-plane` (Creative Studio preview), the desktop's
  `contrib/agenticOffice/{common,browser/growth}`.
