// Pure helpers behind the advanced-type pages (Plan 3 Task 12). `node --import tsx --test test/marketplace-advanced.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADVANCED_TYPES, burstRows, hasPermission, CATALOG_FILTERS, LISTING_TYPES, ackState, approvalRequest, haltRequest, isSha256, listQuery, policyChange, riskPreview, tierTone, typeRows } from '../src/lib/marketplace.ts';

const H = 'a'.repeat(64);
const REVIEWER = ['marketplace.read', 'marketplace.review'];

test('the console knows the same 11 types as the API; advanced excludes template and skill', () => {
  assert.deepEqual([...LISTING_TYPES].sort(), ['agent', 'bridge', 'bundle', 'connector', 'hook', 'memory', 'routine', 'surface', 'template', 'skill', 'workflow'].sort());
  assert.ok(!ADVANCED_TYPES.includes('template' as never) && !ADVANCED_TYPES.includes('skill' as never)); assert.equal(ADVANCED_TYPES.length, 9);
});

test('catalog filters accept the new type, risk tier and manual-review values and drop invented ones', () => {
  assert.equal(listQuery({ type: 'hook', riskTier: 'executable', manualReview: 'true' }, CATALOG_FILTERS), '?type=hook&riskTier=executable&manualReview=true');
  assert.equal(listQuery({ type: 'extension', riskTier: 'extreme', manualReview: 'maybe' }, CATALOG_FILTERS), '');
});

test('ackState: offered only to a reviewer, for a submitted manual-review version with a readable summary and a real hash', () => {
  const base = { state: 'submitted', manualReview: true, summarySha256: H, summary: { truncated: false } };
  assert.deepEqual(ackState(base, REVIEWER), { offer: true, required: true });
  assert.equal(ackState({ ...base, state: 'in_review' }, REVIEWER).offer, true);
  assert.equal(ackState(base, ['marketplace.read']).offer, false);                                   // analyst
  for (const state of ['approved', 'published', 'rejected', 'quarantined', 'revoked']) assert.equal(ackState({ ...base, state }, REVIEWER).offer, false, state);
  assert.equal(ackState({ ...base, summary: { truncated: true } }, REVIEWER).offer, false);           // cannot approve what cannot be read
  assert.match(ackState({ ...base, summary: { truncated: true } }, REVIEWER).reason!, /larger than can be shown/);
  for (const bad of [undefined, '', 'zz', 'A'.repeat(64), H.slice(1), H + 'a']) assert.equal(ackState({ ...base, summarySha256: bad as never }, REVIEWER).offer, false, String(bad));
  assert.equal(ackState({ ...base, manualReview: false }, REVIEWER).offer, false);
  assert.equal(ackState(null, REVIEWER).offer, false);
});

test('approvalRequest: the box must be ticked and the hash well formed; the hash is lower-cased, nothing else is passed through', () => {
  assert.deepEqual(approvalRequest({ reviewed: 'on', ack: H }), { ok: true, body: { ack_summary_sha256: H } });
  assert.deepEqual(approvalRequest({ reviewed: 'true', ack: ` ${H.toUpperCase()} ` }), { ok: true, body: { ack_summary_sha256: H } });
  for (const f of [{}, { ack: H }, { reviewed: '', ack: H }, { reviewed: 'off', ack: H }, { reviewed: 'on' }, { reviewed: 'on', ack: 'nope' }, { reviewed: 'on', ack: H + '0' }]) assert.equal(approvalRequest(f).ok, false, JSON.stringify(f));
  assert.ok(isSha256(H) && !isSha256(null) && !isSha256(5));
});

test('haltRequest: a known type, the type typed back, and a reason of 3..1000 characters', () => {
  assert.deepEqual(haltRequest({ type: 'hook', confirm: 'hook', reason: 'CVE-1' }), { ok: true, type: 'hook', reason: 'CVE-1' });
  for (const f of [{ type: 'nope', confirm: 'nope', reason: 'abc' }, { type: 'hook', confirm: 'Hook', reason: 'abc' }, { type: 'hook', confirm: '', reason: 'abc' }, { type: 'hook', confirm: 'hook', reason: 'ab' }, { type: 'hook', confirm: 'hook', reason: 'x'.repeat(1001) }, { type: '', confirm: '', reason: 'abc' }]) assert.equal(haltRequest(f).ok, false, JSON.stringify(f));
});

test('policyChange: only at or above the floor; manual review cannot be switched off when the floor demands it', () => {
  const floor = { riskTier: 'declarative', manualReview: true, minPublisherTrust: 'community' };
  assert.deepEqual(policyChange(floor, { riskTier: 'executable', manualReview: 'on', minPublisherTrust: 'verified', reason: 'tightening' }), { ok: true, body: { riskTier: 'executable', manualReview: true, minPublisherTrust: 'verified', reason: 'tightening' } });
  for (const f of [{ riskTier: 'data', manualReview: 'on', minPublisherTrust: 'community' }, { riskTier: 'declarative', manualReview: '', minPublisherTrust: 'community' }, { riskTier: 'declarative', manualReview: 'on', minPublisherTrust: 'private' },
    { riskTier: 'declarative', manualReview: 'on', minPublisherTrust: 'community', reason: 'x' }, { riskTier: 'wild', manualReview: 'on', minPublisherTrust: 'community', reason: 'okay' }, { manualReview: 'on', reason: 'okay' }])
    assert.equal(policyChange(floor, { reason: 'because', ...f }).ok, false, JSON.stringify(f));
  assert.equal(policyChange({ riskTier: 'data', manualReview: false, minPublisherTrust: 'community' }, { riskTier: 'data', manualReview: '', minPublisherTrust: 'community', reason: 'relax' }).ok, true);
});

test('riskPreview and tierTone', () => {
  assert.deepEqual(riskPreview(['a', 'b', 'c', 'd', 'e'], 3), { shown: ['a', 'b', 'c'], more: 2 }); assert.deepEqual(riskPreview(undefined), { shown: [], more: 0 }); assert.deepEqual(riskPreview([1, 'x'] as never), { shown: ['x'], more: 0 });
  assert.equal(tierTone('executable'), 'failed'); assert.equal(tierTone('data'), 'active'); assert.equal(tierTone(null), '');
});

test('typeRows: keeps zero rows, coerces numbers, drops malformed rows and never invents data', () => {
  assert.deepEqual(typeRows(null), []); assert.deepEqual(typeRows({ byType: 'x' }), []);
  const r = typeRows({ byType: [{ type: 'hook', installs: 3, failedInstalls: 2, failureRate: 0.4, failedReasons: [{ reason: 'boom <url>', count: 2 }, { nope: 1 }] }, null, { installs: 9 }, { type: 'skill' }] });
  assert.equal(r.length, 2); assert.equal(r[0].installs, 3); assert.equal(r[0].failureRate, 0.4); assert.deepEqual(r[0].failedReasons, [{ reason: 'boom <url>', count: 2 }]);
  assert.equal(r[1].installs, 0); assert.equal(r[1].failureRate, null); assert.equal(r[1].awaitingConfigurationRate, null);
});

test('burstRows: drops malformed rows, coerces numbers, keeps ids as plain text', () => {
  assert.deepEqual(burstRows(null), []); assert.deepEqual(burstRows({ bursts: 'x' }), []);
  const r = burstRows({ bursts: [{ listingId: 'acme/<b>x</b>', installs: '7', accounts: 6, firstAt: '2026-10-21T00:00:00Z', lastAt: 5 }, null, { installs: 2 }] });
  assert.equal(r.length, 1); assert.deepEqual(r[0], { listingId: 'acme/<b>x</b>', installs: 7, accounts: 6, firstAt: '2026-10-21T00:00:00Z', lastAt: null });
});

test('hasPermission is false for anything but a list that contains the name', () => {
  assert.equal(hasPermission(['marketplace.moderate'], 'marketplace.moderate'), true);
  for (const p of [undefined, null, [], ['marketplace.read']] as const) assert.equal(hasPermission(p as never, 'marketplace.moderate'), false);
});
