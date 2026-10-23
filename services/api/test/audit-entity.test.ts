import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveEntity } from '../src/api/audit-entity.ts';

test('a user target always wins', () => {
  assert.deepEqual(deriveEntity('settle_payment', 'usr_1', { order: 'ord_9' }), { type: 'user', id: 'usr_1' });
});

test('payments, tickets, coupons, flags and plans are named by their action', () => {
  assert.deepEqual(deriveEntity('refund_payment', null, { order: 'ord_9', reason: 'x' }), { type: 'payment', id: 'ord_9' });
  assert.deepEqual(deriveEntity('reply_ticket', null, { id: 't1' }), { type: 'ticket', id: 't1' });
  assert.deepEqual(deriveEntity('disable_coupon', null, { code: 'SAVE10' }), { type: 'coupon', id: 'SAVE10' });
  assert.deepEqual(deriveEntity('save_flag', null, { key: 'beta', enabled: true }), { type: 'flag', id: 'beta' });
  assert.deepEqual(deriveEntity('update_plan', null, { id: 'pro', price: 5 }), { type: 'plan', id: 'pro' });
  assert.deepEqual(deriveEntity('approve_access', null, { request: 'req_3' }), { type: 'access_request', id: 'req_3' });
  assert.deepEqual(deriveEntity('invite_admin', null, { email: 'a@b.co' }), { type: 'admin_invite', id: 'a@b.co' });
});

test('growth and marketplace rows are named by the key they already write', () => {
  assert.deepEqual(deriveEntity('set_campaign_status', null, { campaign: 'c1', status: 'live' }), { type: 'campaign', id: 'c1' });
  assert.deepEqual(deriveEntity('stage_release', null, { release: 'r1' }), { type: 'release', id: 'r1' });
  assert.deepEqual(deriveEntity('marketplace.approve_incomplete', null, { listingId: 'l1', versionId: 'v1' }), { type: 'marketplace_version', id: 'v1' });
  assert.deepEqual(deriveEntity('marketplace.verify_claim', null, { jobId: 'j1', versionId: 'v2' }), { type: 'marketplace_version', id: 'v2' });
  assert.deepEqual(deriveEntity('marketplace.resolve_report', null, { reportId: 'rp1', listingId: 'l1' }), { type: 'marketplace_report', id: 'rp1' });
});

test('an action with no subject has no entity', () => {
  assert.equal(deriveEntity('view_overview', null), null);
  assert.equal(deriveEntity('denied', null, { need: 'x', path: '/admin/x' }), null);
  assert.equal(deriveEntity('marketplace.list_catalog', null, { q: 'a', type: 'skill' }), null);
  assert.equal(deriveEntity('create_announcement', null, { title: 'Hi' }), null);
});

test('values are trimmed, numbers become text, and blanks are ignored', () => {
  assert.deepEqual(deriveEntity('reply_ticket', null, { id: '  t1  ' }), { type: 'ticket', id: 't1' });
  assert.deepEqual(deriveEntity('reply_ticket', null, { id: 42 }), { type: 'ticket', id: '42' });
  assert.equal(deriveEntity('reply_ticket', null, { id: '   ' }), null);
  assert.equal(deriveEntity('reply_ticket', null, { id: { nested: 1 } }), null);
});
