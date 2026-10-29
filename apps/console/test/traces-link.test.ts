// The "Traces" sidebar link: present only when AO_TRACES_URL names the Langfuse instance, and only for admins who can read runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleNav } from '../src/components/admin/nav.ts';

const traces = (nav: ReturnType<typeof visibleNav>) => nav.flatMap((g) => g.items).find((i) => i.label === 'Traces');

test('the Traces link opens the configured Langfuse, in the Intelligence group, for runs.read', () => {
  const nav = visibleNav(['runs.read', 'analytics.read'], 'http://100.95.14.113:3000');
  const item = traces(nav);
  assert.equal(item?.href, 'http://100.95.14.113:3000');
  assert.equal(item?.external, true);
  assert.ok(nav.find((g) => g.label === 'Intelligence')?.items.includes(item!));
});

test('no Traces link without a URL or without runs.read', () => {
  assert.equal(traces(visibleNav(['runs.read'], '')), undefined);
  assert.equal(traces(visibleNav(['analytics.read'], 'http://100.95.14.113:3000')), undefined);
});
