// Through the real HTTP API of the local growth stack (tests/tools/growth-stack.sh up): the seeded promotions reach a normal person on every
// placement, never an ad-free or opted-out person, events are counted once, and a dismissal ends it. Exit 1 on the first failure.
const base = process.argv[2] || 'http://127.0.0.1:18787';
const tok = { free: 'aod_seed_free_dev_token', adfree: 'aod_seed_adfree_dev_token', optout: 'aod_seed_optout_dev_token' };
let failed = 0;
const check = (name, ok, detail = '') => { console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail); if (!ok) failed++; };
const call = async (path, who, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json' } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const elig = (who, placement) => call(`/v1/promotions/eligible?placement=${placement}&contract=1&platform=darwin&locale=en-GB&app_version=1.96.0`, who);

for (const p of ['chat_empty', 'inbox', 'bottom_strip']) {
  const r = await elig('free', p);
  check(`a normal person gets a promotion on ${p}`, r.status === 200 && r.body.item?.card?.blocks?.length > 0 && r.body.item.disclosure, JSON.stringify(r.body).slice(0, 200));
}
for (const who of ['adfree', 'optout']) {
  const rs = await Promise.all(['chat_empty', 'inbox', 'bottom_strip'].map((p) => elig(who, p)));
  check(`${who} sees nothing on any placement`, rs.every((r) => r.status === 200 && r.body.item === null), JSON.stringify(rs.map((r) => r.body.item)).slice(0, 200));
}
check('a bad token is refused', (await fetch(`${base}/v1/promotions/eligible?placement=chat_empty`, { headers: { authorization: 'Bearer aod_nope' } })).status === 401);
const item = (await elig('free', 'chat_empty')).body.item;
const ev = (type, id) => ({ event_id: id, type, placement: 'chat_empty', campaign_id: item.campaign_id, creative_id: item.creative_id });
const id1 = `smoke${Date.now().toString(36)}a`, id2 = `smoke${Date.now().toString(36)}b`;
const a = await call('/v1/promotions/events', 'free', { method: 'POST', body: JSON.stringify({ events: [ev('impression', id1), ev('impression', id1)] }) });
check('an event sent twice is counted once', a.status === 200 && a.body.accepted === 1 && a.body.duplicate === 1, JSON.stringify(a.body));
const foreign = await call('/v1/promotions/events', 'free', { method: 'POST', body: JSON.stringify({ events: [{ ...ev('click', `smoke${Date.now().toString(36)}c`), placement: 'inbox' }] }) });
check('an event for a creative that is not on that placement is refused', foreign.status === 400, JSON.stringify(foreign.body));
await call('/v1/promotions/events', 'free', { method: 'POST', body: JSON.stringify({ events: [ev('dismiss', id2)] }) });
check('after a dismissal that promotion never comes back to that person', (await elig('free', 'chat_empty')).body.item === null);
check('the other placements are unaffected', (await elig('free', 'inbox')).body.item !== null);
const prefs = await call('/v1/promotions/prefs', 'free', { method: 'PUT', body: JSON.stringify({ in_app: false, email_marketing: false }) });
check('switching promotions off in the app is stored', prefs.status === 200);
check('and then nothing is shown on any placement', (await elig('free', 'inbox')).body.item === null);
await call('/v1/promotions/prefs', 'free', { method: 'PUT', body: JSON.stringify({ in_app: true, email_marketing: false }) });
console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASSED'); process.exit(failed ? 1 : 0);
