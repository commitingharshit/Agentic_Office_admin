// decide(): which promotion a person sees on a placement. Pure, so every rule is tested without a database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, KILL_SWITCH, mediaLink, signMedia, verifyMedia, versionAtLeast, type Candidate, type Context, type Exposure } from '../src/growth/engine.ts';

const now = new Date('2026-10-21T12:00:00Z');
const hour = 3600_000;
const card = { v: 1, layout: 'stack', blocks: [{ type: 'heading', text: 'Try the LBO toolkit' }], actions: [{ label: 'Open', action: { command: 'open_plans' } }] };
function cand(id: string, over: { campaign?: Partial<Candidate['campaign']>; target?: Candidate['target']; creative?: Partial<Candidate['creative']> } = {}): Candidate {
  return {
    campaign: { id, status: 'live', tier: 'promo', priority: 0, starts_at: new Date(now.getTime() - 24 * hour), ends_at: null, holdout_pct: 0, flag_key: null,
      max_impressions: 3, per_seconds: 86400, min_gap_seconds: 3600, ...over.campaign },
    target: over.target ?? null,
    creative: { id: `cr_${id}`, placement_id: 'chat_empty', kind: 'card', contract_version: 1, headline: '', body: '', cta_label: null, cta_action: null, card, ...over.creative },
  };
}
const ctx = (over: Partial<Context> = {}): Context => ({ userId: 'u1', plan: 'free', adFree: false, inApp: true, flags: [], contract: 1, platform: 'darwin', locale: 'en-GB', appVersion: '1.4.0', signedUpAt: new Date('2026-01-01'), ...over });
const none = new Map<string, Exposure>();
const shown = (r: ReturnType<typeof decide>) => (r.kind === 'show' ? r.candidate.campaign.id : r.kind);

test('a live, targeted, valid card is shown; its card comes back validated with the promo disclosure', () => {
  const r = decide(ctx(), [cand('a')], none, now);
  assert.equal(r.kind, 'show');
  assert.equal(r.kind === 'show' && r.card?.disclosure, 'Featured');
});

test('ad-free, the person\'s own opt-out and the kill switch remove promotions, never release notes or task notices', () => {
  const list = [cand('promo'), cand('rel', { campaign: { tier: 'release' } })];
  assert.equal(shown(decide(ctx({ adFree: true }), list, none, now)), 'rel');
  assert.equal(shown(decide(ctx({ inApp: false }), list, none, now)), 'rel');
  const kill = { key: KILL_SWITCH, enabled: true, rollout_pct: 100, plan_ids: null };
  assert.equal(shown(decide(ctx({ flags: [kill] }), [cand('promo')], none, now)), 'none');
  assert.equal(shown(decide(ctx({ flags: [{ ...kill, plan_ids: ['pro'] }] }), [cand('promo')], none, now)), 'promo', 'a kill switch for another plan does not apply');
});

test('precedence: task > release > promo, then priority, then newest start, then id', () => {
  const a = cand('a', { campaign: { priority: 50 } }), b = cand('b', { campaign: { tier: 'release' } }), t = cand('t', { campaign: { tier: 'task', priority: -100 } });
  assert.equal(shown(decide(ctx(), [a, b, t], none, now)), 't');
  assert.equal(shown(decide(ctx(), [a, b], none, now)), 'b');
  assert.equal(shown(decide(ctx(), [cand('x', { campaign: { priority: 1 } }), cand('y', { campaign: { priority: 2 } })], none, now)), 'y');
  const older = cand('old', { campaign: { starts_at: new Date(now.getTime() - 48 * hour) } }), newer = cand('new');
  assert.equal(shown(decide(ctx(), [older, newer], none, now)), 'new');
  assert.equal(shown(decide(ctx(), [cand('b2'), cand('a2')], none, now)), 'a2');
});

test('schedule and status', () => {
  assert.equal(shown(decide(ctx(), [cand('a', { campaign: { status: 'paused' } })], none, now)), 'none');
  assert.equal(shown(decide(ctx(), [cand('a', { campaign: { starts_at: new Date(now.getTime() + hour) } })], none, now)), 'none');
  assert.equal(shown(decide(ctx(), [cand('a', { campaign: { ends_at: now } })], none, now)), 'none');
  assert.equal(shown(decide(ctx(), [cand('a', { campaign: { status: 'scheduled' } })], none, now)), 'a');
});

test('targeting: plan, excluded plan, platform, locale prefix, app version, signup window, listed people', () => {
  const t = (target: Partial<NonNullable<Candidate['target']>>) => ({ plan_ids: null, exclude_plan_ids: null, platforms: null, locales: null, min_app_version: null, signup_after: null, signup_before: null, user_ids: null, ...target });
  const ok = (target: Partial<NonNullable<Candidate['target']>>, c = ctx()) => decide(c, [cand('a', { target: t(target) })], none, now).kind === 'show';
  assert.equal(ok({ plan_ids: ['free'] }), true);
  assert.equal(ok({ plan_ids: ['pro'] }), false);
  assert.equal(ok({ exclude_plan_ids: ['free'] }), false);
  assert.equal(ok({ platforms: ['win32'] }), false);
  assert.equal(ok({ locales: ['en'] }), true);
  assert.equal(ok({ locales: ['de'] }), false);
  assert.equal(ok({ min_app_version: '1.4' }), true);
  assert.equal(ok({ min_app_version: '1.10' }), false);
  assert.equal(ok({ signup_after: new Date('2026-06-01') }), false);
  assert.equal(ok({ user_ids: ['u1'] }), true);
  assert.equal(ok({ user_ids: ['someone-else'] }), false);
  assert.equal(versionAtLeast('1.10.0', '1.9'), true);
  assert.equal(versionAtLeast(undefined, '1.0'), false);
});

test('frequency: dismissed never again; at most N per window; at least M seconds apart', () => {
  const ex = (e: Partial<Exposure>) => new Map([['a', { shown_at: [], dismissed_at: null, ...e }]]);
  assert.equal(shown(decide(ctx(), [cand('a')], ex({ dismissed_at: new Date(now.getTime() - 30 * 24 * hour) }), now)), 'none');
  const three = [5, 4, 3].map((h) => new Date(now.getTime() - h * hour));
  assert.equal(shown(decide(ctx(), [cand('a')], ex({ shown_at: three }), now)), 'none');
  assert.equal(shown(decide(ctx(), [cand('a')], ex({ shown_at: three.slice(0, 2) }), now)), 'a');
  assert.equal(shown(decide(ctx(), [cand('a')], ex({ shown_at: [new Date(now.getTime() - 10 * 60_000)] }), now)), 'none', 'too soon');
  const old = [30, 29, 28].map((h) => new Date(now.getTime() - h * hour));
  assert.equal(shown(decide(ctx(), [cand('a')], ex({ shown_at: old }), now)), 'a', 'impressions outside the window do not count');
});

test('a creative for a newer placement contract is never sent to an older app; an invalid card or action is skipped, not rendered', () => {
  assert.equal(shown(decide(ctx({ contract: 1 }), [cand('a', { creative: { contract_version: 2 } })], none, now)), 'none');
  assert.equal(shown(decide(ctx({ contract: 2 }), [cand('a', { creative: { contract_version: 2 } })], none, now)), 'a');
  assert.equal(shown(decide(ctx(), [cand('a', { creative: { card: { v: 1, layout: 'stack', blocks: [{ type: 'html', html: '<b>x</b>' }] } } }), cand('b')], none, now)), 'b');
  assert.equal(shown(decide(ctx(), [cand('a', { creative: { kind: 'image', card: null, cta_action: { command: 'run', arg: 'x' } } })], none, now)), 'none');
});

test('holdout: a stable slice of people sees nothing and is reported as held out, the same way every time', () => {
  const c = cand('h', { campaign: { holdout_pct: 50 } });
  const kinds = new Map<string, string>();
  let held = 0;
  for (let i = 0; i < 400; i++) {
    const k = decide(ctx({ userId: `user-${i}` }), [c], none, now).kind;
    kinds.set(`user-${i}`, k);
    held += k === 'holdout' ? 1 : 0;
  }
  assert.ok(held > 150 && held < 250, `about half held out (${held}/400)`);
  for (const [u, k] of kinds) assert.equal(decide(ctx({ userId: u }), [c], none, now).kind, k, 'stable per person');
});

test('a campaign behind a feature flag follows the flag', () => {
  const c = cand('f', { campaign: { flag_key: 'growth.toolkit' } });
  assert.equal(shown(decide(ctx(), [c], none, now)), 'none');
  assert.equal(shown(decide(ctx({ flags: [{ key: 'growth.toolkit', enabled: true, rollout_pct: 100, plan_ids: null }] }), [c], none, now)), 'f');
});

test('media links: signed, expiring within two hours, bound to one file', () => {
  const key = Buffer.alloc(32, 7);
  const link = new URL(mediaLink(key, 42, now.getTime()), 'http://x');
  const e = Number(link.searchParams.get('e')), s = link.searchParams.get('s')!;
  assert.equal(verifyMedia(key, 42, e, s, now.getTime()), true);
  assert.equal(verifyMedia(key, 43, e, s, now.getTime()), false, 'another file');
  assert.equal(verifyMedia(Buffer.alloc(32, 8), 42, e, s, now.getTime()), false, 'another key');
  assert.equal(verifyMedia(key, 42, e, s, now.getTime() + 3 * hour), false, 'expired');
  const far = Math.floor(now.getTime() / 1000) + 30 * 86400;
  assert.equal(verifyMedia(key, 42, far, signMedia(key, 42, far), now.getTime()), false, 'a link valid for a month is refused');
});
