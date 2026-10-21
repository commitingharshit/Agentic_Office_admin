// The install-policy test vectors shared with the desktop mirror (apps/desktop/src/vs/platform/marketplace/node/policyGate.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { evaluate } from '../src/marketplace/policy.ts';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/policy-vectors.json', import.meta.url), 'utf8')) as { cases: Array<{ name: string; policy: any; subject: any; expect: { allowed: boolean; reason?: string } }> };

describe('policy vectors', () => {
  test('there are vectors', () => assert.ok(vectors.cases.length >= 15));
  for (const c of vectors.cases) test(c.name, () => assert.deepEqual(evaluate(c.policy, c.subject), c.expect));
});
