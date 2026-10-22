// Service status: how readings become up / degraded / down, what the public endpoint may say, and that a stale or missing reading is never "up".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { dbTarget, httpTarget, nextState, publicStatus, statusHandler, sweep, targetsFromEnv, SLOW_MS, STALE_MS, type Target } from '../src/status/probe.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

describe('nextState', () => {
  test('a success is up, a slow success degraded', () => {
    assert.equal(nextState(undefined, { ok: true, latencyMs: 20 }), 'up');
    assert.equal(nextState('down', { ok: true, latencyMs: 20 }), 'up');
    assert.equal(nextState('up', { ok: true, latencyMs: SLOW_MS + 1 }), 'degraded');
  });
  test('one failure is degraded; down needs a second in a row', () => {
    assert.equal(nextState('up', { ok: false, latencyMs: 5000 }), 'degraded');
    assert.equal(nextState(undefined, { ok: false, latencyMs: 5000 }), 'degraded');
    assert.equal(nextState('degraded', { ok: false, latencyMs: 5000 }), 'down');
    assert.equal(nextState('down', { ok: false, latencyMs: 5000 }), 'down');
  });
});

describe('targets', () => {
  test('http target: 2xx passes, other codes and refused connections fail, redirects are not followed', async () => {
    const srv = createServer((q, r) => { r.writeHead(q.url === '/ok' ? 200 : q.url === '/redir' ? 302 : 503, { location: '/ok' }); r.end(); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      await httpTarget({ id: 'a', label: 'A', url: `${base}/ok` }).check();
      await assert.rejects(httpTarget({ id: 'a', label: 'A', url: `${base}/bad` }).check(), /503/);
      await assert.rejects(httpTarget({ id: 'a', label: 'A', url: `${base}/redir` }).check(), /302/);
      await httpTarget({ id: 'a', label: 'A', url: `${base}/redir`, expect: [302] }).check();
    } finally { srv.close(); }
    await assert.rejects(httpTarget({ id: 'a', label: 'A', url: 'http://127.0.0.1:1/', timeoutMs: 500 }).check());
  });
  test('bad ids and non-http urls are refused; bad env entries are skipped with a warning', () => {
    assert.throws(() => httpTarget({ id: 'Bad Id', label: 'x', url: 'http://x' }), /bad service id/);
    assert.throws(() => httpTarget({ id: 'a', label: 'x', url: 'file:///etc/passwd' }), /http/);
    const warnings: string[] = [];
    const t = targetsFromEnv(JSON.stringify([{ id: 'ok', label: 'OK', url: 'http://x/y' }, { id: 'no-url', label: 'x' }, { id: 'ftp', label: 'x', url: 'ftp://x' }]), (m) => warnings.push(m));
    assert.deepEqual(t.map((x) => x.id), ['ok']);
    assert.equal(warnings.length, 2);
    assert.deepEqual(targetsFromEnv('nope', (m) => warnings.push(m)), []);
    assert.deepEqual(targetsFromEnv(undefined), []);
  });
});

describe('sweep and the public status (real Postgres)', { skip }, () => {
  let h: MarketplacePg;
  let admin: ReturnType<MarketplacePg['pool']>, ro: ReturnType<MarketplacePg['pool']>;
  let up = true, slow = false;
  const flaky: Target = { id: 'signin', label: 'Sign-in', sort: 1, check: async () => { if (!up) throw new Error('down'); if (slow) await new Promise((r) => setTimeout(r, 30)); } };
  before(async () => {
    h = await startMarketplacePg();
    await h.owner.query(readFileSync(new URL('../../../database/migrations/0031_status.sql', import.meta.url), 'utf8'));
    admin = h.pool('ao_admin'); ro = h.pool('ao_readonly');
  });
  after(async () => { await h?.stop(); });

  test('first sweep records up; the public view lists it with coarse fields only', async () => {
    await sweep(admin, [flaky, dbTarget(admin, { sort: 2 })]);
    const s = await publicStatus(ro);
    assert.equal(s.overall, 'up');
    assert.deepEqual(s.services.map((x) => [x.id, x.state]), [['signin', 'up'], ['database', 'up']]);
    assert.deepEqual(Object.keys(s.services[0]!).sort(), ['checkedAt', 'days', 'id', 'label', 'since', 'state', 'uptime90d']);
    assert.equal(s.services[0]!.days.length, 90);
    assert.equal(s.services[0]!.days[89], 100);
  });
  test('failures: degraded first, down on the second, up again on success; since moves only when the state changes', async () => {
    const since = async () => (await h.owner.query(`SELECT state, since FROM service_status WHERE service='signin'`)).rows[0] as { state: string; since: Date };
    const a = await since();
    up = false;
    await sweep(admin, [flaky]); const b = await since(); assert.equal(b.state, 'degraded');
    await sweep(admin, [flaky]); const c = await since(); assert.equal(c.state, 'down');
    await sweep(admin, [flaky]); const d = await since(); assert.equal(d.state, 'down'); assert.deepEqual(d.since, c.since);
    assert.ok(c.since > a.since);
    assert.equal((await publicStatus(ro)).overall, 'down');
    up = true;
    await sweep(admin, [flaky]); assert.equal((await since()).state, 'up');
  });
  test('one broken target does not stop the others from being recorded', async () => {
    const boom: Target = { id: 'boom', label: 'Boom', check: async () => { throw new Error('x'); } };
    await sweep(admin, [boom, dbTarget(admin)]);
    const rows = (await h.owner.query(`SELECT service, state FROM service_status WHERE service IN ('boom','database') ORDER BY service`)).rows;
    assert.deepEqual(rows, [{ service: 'boom', state: 'degraded' }, { service: 'database', state: 'up' }]);
  });
  test('a reading older than the stale limit is shown as down, never up', async () => {
    const s = await publicStatus(ro, () => Date.now() + STALE_MS + 60_000);
    assert.ok(s.services.every((x) => x.state === 'down'));
    assert.equal(s.overall, 'down');
  });
  test('history older than 90 days is pruned, and an empty table is not "all up"', async () => {
    await h.owner.query(`INSERT INTO status_checks(service, state, checked_at) VALUES ('signin','up', now() - interval '91 days')`);
    await sweep(admin, [flaky]);
    assert.equal((await h.owner.query(`SELECT count(*)::int AS n FROM status_checks WHERE checked_at < now() - interval '90 days'`)).rows[0].n, 0);
    await h.owner.query('DELETE FROM service_status');
    assert.equal((await publicStatus(ro)).overall, 'down');
  });
  test('the read-only role cannot write status, the app role cannot either', async () => {
    await assert.rejects(ro.query(`INSERT INTO service_status(service,label,state) VALUES ('x','x','up')`), /permission denied/);
    await assert.rejects(h.app.query(`UPDATE service_status SET state='up'`), /permission denied/);
  });
  test('GET /v1/status: 200 JSON cacheable; POST 405; other paths not handled; a database failure is 503 with no detail', async () => {
    await sweep(admin, [flaky]);
    const handler = statusHandler(ro);
    const srv = createServer(async (q, r) => { if (!(await handler(q, r))) { r.writeHead(404); r.end(); } });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      const r = await fetch(`${base}/v1/status`);
      assert.equal(r.status, 200); assert.match(r.headers.get('cache-control')!, /max-age=15/);
      assert.equal((await r.json() as any).services[0].id, 'signin');
      assert.equal((await fetch(`${base}/v1/status`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${base}/v1/status/extra`)).status, 404);
    } finally { srv.close(); }
    const broken = statusHandler({ query: async () => { throw new Error('secret connection string'); } } as any);
    const srv2 = createServer(async (q, r) => { await broken(q, r); });
    await new Promise<void>((ok) => srv2.listen(0, '127.0.0.1', ok));
    try {
      const r = await fetch(`http://127.0.0.1:${(srv2.address() as any).port}/v1/status`);
      assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('secret'));
    } finally { srv2.close(); }
  });
});

test('the prober has working default probes when none are configured', async () => {
  const { DEFAULT_PROBES } = await import('../src/status/probe.ts');
  const t = targetsFromEnv(DEFAULT_PROBES);
  assert.deepEqual(t.map((x) => x.id), ['gateway', 'keycloak']);
});
