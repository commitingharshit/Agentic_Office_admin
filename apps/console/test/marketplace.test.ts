// Pure helpers behind the Marketplace pages. No database, no server: `node --import tsx --test test/marketplace.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS, CATALOG_FILTERS, allowedActions, canRescan, isSensitiveCapability, listQuery, packValidation, ratingText, summarizeValidation, unpackValidation, withParams } from '../src/lib/marketplace.ts';

const ALL = ['marketplace.read', 'marketplace.write', 'marketplace.review', 'marketplace.moderate'];
const ENGINEER = ['marketplace.read', 'marketplace.write', 'marketplace.review'];

test('allowedActions follows the API state machine', () => {
  assert.deepEqual(allowedActions('submitted', ALL), ['claim', 'approve', 'reject', 'revoke']);
  assert.deepEqual(allowedActions('in_review', ALL), ['approve', 'reject', 'revoke']);
  assert.deepEqual(allowedActions('approved', ALL), ['reject', 'publish', 'quarantine', 'revoke']);
  assert.deepEqual(allowedActions('published', ALL), ['deprecate', 'quarantine', 'revoke']);
  assert.deepEqual(allowedActions('deprecated', ALL), ['quarantine', 'revoke']);
  assert.deepEqual(allowedActions('quarantined', ALL), ['revoke']);
  for (const s of ['draft', 'validating', 'testing', 'revoked', 'rejected']) assert.deepEqual(allowedActions(s, ALL).filter((a) => a !== 'revoke'), [], s);
  assert.deepEqual(allowedActions('revoked', ALL), []);
  assert.ok(!allowedActions('rejected', ALL).includes('approve'));
});
test('allowedActions needs the permission as well as the state', () => {
  assert.deepEqual(allowedActions('published', ENGINEER), ['deprecate']);        // no moderate: no quarantine/revoke
  assert.deepEqual(allowedActions('submitted', ['marketplace.read']), []);       // analyst: nothing
  assert.deepEqual(allowedActions('submitted', []), []);
  assert.deepEqual(allowedActions('published', ['marketplace.moderate']), ['quarantine', 'revoke']);
  assert.equal(ACTIONS.length, 7);
});
test('canRescan only in review states and with write', () => {
  assert.ok(canRescan('submitted', ENGINEER)); assert.ok(canRescan('approved', ENGINEER));
  assert.ok(!canRescan('published', ENGINEER)); assert.ok(!canRescan('submitted', ['marketplace.read']));
});
test('summarizeValidation never reports success without verified:true', () => {
  const ok = summarizeValidation({ ok: true, verified: true, checks: [{ name: 'manifest', ok: true }, { name: 'scan', ok: true, required: true }] });
  assert.equal(ok.outcome, 'verified'); assert.equal(ok.passed, 2);
  const unv = summarizeValidation({ ok: true, verified: false, checks: [{ name: 'manifest', ok: true }, { name: 'skill-scan', ok: true, skipped: true, required: true }] });
  assert.equal(unv.outcome, 'unverified'); assert.equal(unv.skipped, 1); assert.equal(unv.passed, 1); assert.match(unv.headline, /Not verified/);
  const bad = summarizeValidation({ ok: false, verified: false, checks: [{ name: 'manifest', ok: false, detail: 'bad' }, { name: 'x', ok: true }] });
  assert.equal(bad.outcome, 'failed'); assert.equal(bad.failed, 1);
  assert.equal(summarizeValidation({ ok: true, verified: true, checks: [{ name: 'a', ok: false }] }).outcome, 'failed');   // a failed check wins over a claimed ok
  assert.equal(summarizeValidation(null).outcome, 'failed'); assert.equal(summarizeValidation({ ok: true, checks: [] }).outcome, 'unverified');
});
test('listQuery keeps only known, valid, non-empty filters', () => {
  assert.equal(listQuery({}, CATALOG_FILTERS), '');
  assert.equal(listQuery({ q: ' memo ', type: 'template', state: 'published' }, CATALOG_FILTERS), '?q=memo&type=template&state=published');
  assert.equal(listQuery({ type: 'bogus', visibility: 'secret', state: 'nope', evil: 'x' }, CATALOG_FILTERS), '');
  assert.equal(listQuery({ q: 'a&b=c' }, CATALOG_FILTERS), '?q=a%26b%3Dc');
  assert.equal(listQuery({ q: 'x'.repeat(500) }, CATALOG_FILTERS).length, '?q='.length + 200);
});
test('withParams swaps the cursor and drops flash messages', () => {
  assert.equal(withParams('/b', { type: 'skill', page: 'p1', msg: 'hi' }, { page: 'p2' }), '/b?type=skill&page=p2');
  assert.equal(withParams('/b', { page: 'p1' }, { page: undefined }), '/b');
});
test('validation survives the redirect round trip, bounded', () => {
  const v = { ok: true, verified: false, checks: [{ name: 'scan', ok: true, skipped: true, required: true, detail: 'd'.repeat(1000) }] };
  const back = unpackValidation(packValidation(v));
  assert.equal(back?.verified, false); assert.equal(back?.checks[0].skipped, true); assert.equal(back?.checks[0].detail?.length, 240);
  assert.equal(unpackValidation('not-base64-json'), null); assert.equal(unpackValidation(undefined), null);
});
test('small formatters are honest', () => {
  assert.equal(ratingText(null, 0), 'No ratings'); assert.equal(ratingText(4.25, 3), '4.3 (3)'); assert.equal(ratingText(0, 0), 'No ratings');
  assert.ok(isSensitiveCapability('exec.script')); assert.ok(isSensitiveCapability('fs.workspace.write')); assert.ok(!isSensitiveCapability('fs.workspace.read'));
});
