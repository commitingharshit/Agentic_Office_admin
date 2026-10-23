import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crumbLabel, ENTITY_LABEL, entityHref, trailHref } from '../src/lib/entities.ts';

test('a thing with its own page links to it, encoded', () => {
  assert.equal(entityHref('user', 'usr_abc'), '/admin/users/usr_abc');
  assert.equal(entityHref('payment', 'a/b c'), '/admin/payments/a%2Fb%20c');
  assert.equal(entityHref('marketplace_version', 'v1'), '/admin/marketplace/versions/v1');
  assert.equal(entityHref('campaign', 'c1'), '/admin/growth/campaigns/c1');
});

test('a thing without its own page links to the list it lives in, never nowhere', () => {
  for (const t of ['release', 'coupon', 'flag', 'plan', 'announcement', 'access_request', 'admin_invite', 'marketplace_report', 'email_template', 'creative']) {
    assert.match(entityHref(t, 'x') ?? '', /^\/admin\//, t);
  }
});

test('an unknown or missing kind has no link', () => {
  assert.equal(entityHref('nope', 'x'), null);
  assert.equal(entityHref(null, 'x'), null);
  assert.equal(entityHref('user', null), null);
});

test('every kind the API writes has a label and a link', () => {
  for (const t of Object.keys(ENTITY_LABEL)) assert.ok(entityHref(t, 'x'), t);
});

test('the audit trail link carries both type and id', () => {
  assert.equal(trailHref('payment', 'o 1'), '/admin/audit?targetType=payment&targetId=o%201');
});

test('breadcrumbs name the kind of page an id belongs to', () => {
  assert.equal(crumbLabel('users', 'usr_8f3a2b1c9d4e5f6a'), 'User usr_8f3a2b1c9d…');
  assert.equal(crumbLabel('payments', 'short'), 'Payment short');
  assert.equal(crumbLabel('campaigns', 'abcdefghijklmnopqrst'), 'Campaign abcdefghijklmn…');
  assert.equal(crumbLabel('unknown', 'abcdefghijklmnopqrst'), 'abcdefghijklmn…');
  assert.equal(crumbLabel(undefined, 'abc'), 'abc');
});
