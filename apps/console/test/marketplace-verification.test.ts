// Verification views (Plan 4 Task 14): pure helpers. `node --import tsx --test test/marketplace-verification.test.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// ── verification views (Plan 4 Task 14)
import { evidencePath, incompleteAck, verificationRows, verificationWord } from '../src/lib/marketplace.ts';

test('verificationWord uses words, never a score or a colour alone', () => {
  assert.equal(verificationWord('pass'), 'Pass');
  assert.equal(verificationWord('incomplete'), 'Partly');
  assert.equal(verificationWord('fail'), 'Failed');
  assert.equal(verificationWord(null), 'None');
  assert.equal(verificationWord(undefined), 'None');
  assert.equal(verificationWord('great'), 'None');   // an unknown value is never shown as a pass
});

test('incompleteAck needs a real sentence, trimmed, at most 500 characters', () => {
  assert.deepEqual(incompleteAck('  '), { ok: false, error: 'Type a sentence saying why you accept the skipped checks (at least 20 characters).' });
  assert.equal(incompleteAck('ok').ok, false);
  assert.deepEqual(incompleteAck('  The visual checks need Chromium; I looked at the previews by hand.  '), { ok: true, text: 'The visual checks need Chromium; I looked at the previews by hand.' });
  assert.equal(incompleteAck('x'.repeat(501)).ok, false);
});

test('evidencePath only ever points at the console proxy with a 64-hex sha', () => {
  const sha = 'a'.repeat(64);
  assert.equal(evidencePath('ver_1', sha), `/admin/marketplace/evidence/ver_1?sha=${sha}`);
  assert.equal(evidencePath('ver_1', 'https://evil.example/x.png'), null);
  assert.equal(evidencePath('../x', sha), null);
  assert.equal(evidencePath('ver_1', sha.toUpperCase()), null);
});

test('verificationRows keeps text as text, labels each stage in words, and flags skipped required checks', () => {
  const rows = verificationRows({ verdict: 'incomplete', stages: [
    { id: 'a', title: '<b>Manifest</b>', required: true, status: 'pass', evidence: [] },
    { id: 'b', title: 'Render', required: true, status: 'skipped', reason: 'tool-missing:officecli', evidence: [{ kind: 'text', label: 'x', detail: '<img src=x onerror=alert(1)>' }] },
    { id: 'c', title: 'Opt', required: false, status: 'skipped', reason: 'n/a', evidence: [] },
    { id: 'd', title: 'Bad', required: true, status: 'fail', reason: 'nope', evidence: [] }] });
  assert.deepEqual(rows.map((r) => r.word), ['Pass', 'Skipped', 'Skipped', 'Fail']);
  assert.equal(rows[0].title, '<b>Manifest</b>');
  assert.deepEqual(rows.map((r) => r.blocking), [false, true, false, true]);
  assert.equal(rows[1].evidence[0].detail, '<img src=x onerror=alert(1)>');
  assert.deepEqual(verificationRows(null), []);
  assert.deepEqual(verificationRows({ verdict: 'pass', stages: 'x' as any }), []);
});
