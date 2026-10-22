// A service that is down or unconfirmed shows up in the admin's attention list, only to roles that can open Infrastructure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attention } from '../src/api/attention.ts';

const deps = (rows: Array<{ label: string; state: string; stale: boolean }>) => ({
  ro: { query: async (sql: string) => (/FROM service_status/.test(sql) ? { rows } : { rows: [{ n: 0, age: 0 }] }) },
}) as any;

test('down and stale services are an action item naming them; degraded is a warning', async () => {
  const r = await attention(deps([{ label: 'Sign-in', state: 'down', stale: false }, { label: 'Package verifier', state: 'up', stale: true }, { label: 'Database', state: 'degraded', stale: false }, { label: 'API', state: 'up', stale: false }]), 'engineer');
  const down = r.items.find((i) => i.id === 'services-down')!, deg = r.items.find((i) => i.id === 'services-degraded')!;
  assert.equal(down.level, 'action'); assert.equal(down.count, 2); assert.match(down.title, /Sign-in, Package verifier/);
  assert.equal(deg.level, 'warn'); assert.match(deg.title, /Database/);
  assert.equal(r.items[0]!.id, 'services-down', 'actions sort first');
});
test('all up: nothing; a role without infra.read never sees service names', async () => {
  assert.ok(!(await attention(deps([{ label: 'API', state: 'up', stale: false }]), 'engineer')).items.some((i) => /services-/.test(i.id)));
  assert.ok(!(await attention(deps([{ label: 'Secret service', state: 'down', stale: false }]), 'finance')).items.some((i) => /services-/.test(i.id)));
});
test('before the status migration exists the list still loads', async () => {
  const d = { ro: { query: async (sql: string) => { if (/service_status/.test(sql)) throw new Error('relation does not exist'); return { rows: [{ n: 0, age: 0 }] }; } } } as any;
  assert.deepEqual((await attention(d, 'engineer')).items.filter((i) => /services-/.test(i.id)), []);
});
