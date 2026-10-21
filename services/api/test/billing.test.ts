// Credits, coupons and reservations against a live database migrated by db/migrate.ts:
//   AO_TEST_PG=postgres://…@127.0.0.1:55432/agentic_office  (owner URL; role passwords via
//   AO_APP_PASSWORD / AO_ADMIN_PASSWORD). The money rules live in SQL, so these tests call the SQL.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const uid = (n: string) => `usr_${n}_${tag}`;
const created: string[] = [];
const coupons: string[] = [];
let owner: pg.Client;
let app: pg.Pool;
let admin: pg.Client;

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  app = new pg.Pool({ connectionString: as('ao_app', process.env.AO_APP_PASSWORD), max: 24 });
  admin = new pg.Client({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) }); await admin.connect();
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM coupon_redemptions WHERE coupon_code = ANY($1)', [coupons]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await owner.query('DELETE FROM coupons WHERE code = ANY($1)', [coupons]);
  await Promise.all([owner.end(), app.end(), admin.end()]);
});

async function newUser(n: string): Promise<string> {
  const id = uid(n);
  await owner.query(`INSERT INTO users(id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
  created.push(id);
  return id;
}
async function newCoupon(code: string, o: Record<string, unknown> = {}): Promise<string> {
  const c = `${code}-${tag}`.toUpperCase();
  const f = { amount: 100, pool: 'promo', max_redemptions: null, active: true, starts_at: null, expires_at: null, grant_valid_days: null, plan_id: null, ...o };
  await owner.query(`INSERT INTO coupons(code, amount, pool, max_redemptions, active, starts_at, expires_at, grant_valid_days, plan_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c, f.amount, f.pool, f.max_redemptions, f.active, f.starts_at, f.expires_at, f.grant_valid_days, f.plan_id]);
  coupons.push(c);
  return c;
}
/** One request as `user`: its own transaction with app.user_id set, committed (so concurrency is real). */
async function call<T = Record<string, unknown>>(user: string | null, sql: string, args: unknown[] = []): Promise<T[]> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    if (user) await c.query(`SELECT set_config('app.user_id', $1, true)`, [user]);
    const r = await c.query(sql, args);
    await c.query('COMMIT');
    return r.rows as T[];
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const bal = async (u: string) => { const r = (await call<{ promo: string; paid: string; reserved: string }>(u, 'SELECT * FROM ao_credit_balance()'))[0]; return { promo: Number(r.promo), paid: Number(r.paid), reserved: Number(r.reserved) }; };
const redeem = (u: string, code: string) => call(u, 'SELECT * FROM ao_redeem_coupon($1)', [code]);
const reserve = async (u: string, amount: number, req: string) => Number((await call<{ ao_credit_reserve: string }>(u, 'SELECT ao_credit_reserve($1,$2)', [amount, req]))[0].ao_credit_reserve);
const settle = async (u: string, rid: number, cost: number) => Number((await call<{ ao_credit_settle: string }>(u, `SELECT ao_credit_settle($1,$2,'test-model',10,20)`, [rid, cost]))[0].ao_credit_settle);
const grant = (u: string, amount: number, pool = 'paid') => owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason) VALUES ($1,'grant',$2,$3,'test')`, [u, pool, amount]);

test('a new user has no credits, and the free plan', { skip }, async () => {
  const u = await newUser('new');
  assert.deepEqual(await bal(u), { promo: 0, paid: 0, reserved: 0 });
});

test('redeeming a coupon grants promotional credits once per user', { skip }, async () => {
  const u = await newUser('r1'), code = await newCoupon('WELCOME', { amount: 500 });
  const r = (await redeem(u, code))[0] as { amount: string; pool: string };
  assert.equal(Number(r.amount), 500); assert.equal(r.pool, 'promo');
  assert.deepEqual(await bal(u), { promo: 500, paid: 0, reserved: 0 });
  await assert.rejects(redeem(u, code), /coupon_already_redeemed/);
  await assert.rejects(redeem(u, code.toLowerCase()), /coupon_already_redeemed/);   // codes are case-insensitive
  assert.equal((await bal(u)).promo, 500);
  assert.equal(Number((await owner.query('SELECT redeemed_count FROM coupons WHERE code=$1', [code])).rows[0].redeemed_count), 1);
});

test('an unknown, inactive, not-yet-valid or expired coupon is refused the same way', { skip }, async () => {
  const u = await newUser('r2');
  const inactive = await newCoupon('OFFCODE', { active: false });
  const future = await newCoupon('FUTURE', { starts_at: new Date(Date.now() + 3600_000) });
  const past = await newCoupon('PASTDUE', { expires_at: new Date(Date.now() - 3600_000) });
  for (const c of ['NOSUCHCODE', inactive, future, past, '', '   ']) await assert.rejects(redeem(u, c), /coupon_invalid/);
  assert.deepEqual(await bal(u), { promo: 0, paid: 0, reserved: 0 });
});

test('a limited coupon cannot be over-redeemed, even by many users at the same instant', { skip }, async () => {
  const code = await newCoupon('LIMITED', { amount: 40, max_redemptions: 3 });
  const users = await Promise.all(Array.from({ length: 12 }, (_, i) => newUser(`lim${i}`)));
  const results = await Promise.allSettled(users.map((u) => redeem(u, code)));
  const won = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(won, 3);
  for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /coupon_exhausted/);
  assert.equal(Number((await owner.query('SELECT redeemed_count FROM coupons WHERE code=$1', [code])).rows[0].redeemed_count), 3);
  const total = (await owner.query(`SELECT coalesce(sum(amount),0)::int AS n FROM credit_ledger WHERE coupon_code = $1`, [code])).rows[0].n;
  assert.equal(total, 120);   // exactly three grants of 40
});

test('one user redeeming the same coupon in parallel is credited once', { skip }, async () => {
  const u = await newUser('par'), code = await newCoupon('PARALLEL', { amount: 70 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => redeem(u, code)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await bal(u)).promo, 70);
});

test('a plan coupon moves the user to that plan', { skip }, async () => {
  const u = await newUser('plan'), code = await newCoupon('BETAPLAN', { amount: 10, plan_id: 'beta' });
  await redeem(u, code);
  const rows = await call<{ plan_id: string }>(u, 'SELECT plan_id FROM subscriptions');
  assert.deepEqual(rows.map((r) => r.plan_id), ['beta']);
});

test('reserve takes promotional credits first, settle charges the real cost and returns the rest', { skip }, async () => {
  const u = await newUser('flow');
  await grant(u, 100, 'promo'); await grant(u, 50, 'paid');
  const rid = await reserve(u, 120, 'req-1');
  assert.deepEqual(await bal(u), { promo: 0, paid: 30, reserved: 120 });
  const usage = await settle(u, rid, 70);
  assert.ok(usage > 0);
  assert.deepEqual(await bal(u), { promo: 30, paid: 50, reserved: 0 });   // 70 came out of promo
  const ev = (await call<{ cost: string; tokens_in: string; model: string }>(u, 'SELECT cost, tokens_in, model FROM usage_events'))[0];
  assert.equal(Number(ev.cost), 70); assert.equal(Number(ev.tokens_in), 10); assert.equal(ev.model, 'test-model');
});

test('the same request id holds credits once, and settling twice charges once', { skip }, async () => {
  const u = await newUser('idem');
  await grant(u, 100);
  const a = await reserve(u, 40, 'same'), b = await reserve(u, 40, 'same');
  assert.equal(a, b);
  assert.deepEqual(await bal(u), { promo: 0, paid: 60, reserved: 40 });
  const e1 = await settle(u, a, 25), e2 = await settle(u, a, 25);
  assert.equal(e1, e2);
  assert.deepEqual(await bal(u), { promo: 0, paid: 75, reserved: 0 });
});

test('a settle can never charge more than was reserved', { skip }, async () => {
  const u = await newUser('clamp');
  await grant(u, 100);
  const rid = await reserve(u, 30, 'c1');
  await settle(u, rid, 9_999);
  assert.equal((await bal(u)).paid, 70);
});

test('credits are refused when the balance cannot cover the hold, and nothing goes negative', { skip }, async () => {
  const u = await newUser('poor');
  await assert.rejects(reserve(u, 1, 'p0'), /insufficient_credits/);
  await grant(u, 50);
  await assert.rejects(reserve(u, 51, 'p1'), /insufficient_credits/);
  await assert.rejects(reserve(u, 0, 'p2'), /bad_amount/);
  await assert.rejects(reserve(u, -5, 'p3'), /bad_amount/);
  assert.deepEqual(await bal(u), { promo: 0, paid: 50, reserved: 0 });
});

test('simultaneous reservations cannot spend the same credits twice', { skip }, async () => {
  const u = await newUser('race');
  await grant(u, 100);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserve(u, 30, `race-${i}`)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);    // 3 × 30 ≤ 100 < 4 × 30
  for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /insufficient_credits/);
  const b = await bal(u);
  assert.equal(b.paid, 10); assert.equal(b.reserved, 90);
  const neg = (await owner.query(`SELECT sum(amount)::int AS n FROM credit_ledger WHERE user_id=$1`, [u])).rows[0].n;
  assert.ok(neg >= 0);
});

test('releasing a hold gives everything back and closes it', { skip }, async () => {
  const u = await newUser('rel');
  await grant(u, 100, 'promo'); await grant(u, 100, 'paid');
  const rid = await reserve(u, 150, 'rel-1');
  await call(u, 'SELECT ao_credit_release($1)', [rid]);
  assert.deepEqual(await bal(u), { promo: 100, paid: 100, reserved: 0 });
  await call(u, 'SELECT ao_credit_release($1)', [rid]);   // again: no effect
  assert.deepEqual(await bal(u), { promo: 100, paid: 100, reserved: 0 });
  await assert.rejects(settle(u, rid, 10), /reservation_closed/);
});

test('a reservation nobody settled is released once it times out', { skip }, async () => {
  const u = await newUser('ttl');
  await grant(u, 100);
  const rid = await reserve(u, 60, 'ttl-1');
  assert.equal((await bal(u)).reserved, 60);
  await owner.query(`UPDATE credit_reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [rid]);
  assert.deepEqual(await bal(u), { promo: 0, paid: 100, reserved: 0 });
  await assert.rejects(settle(u, rid, 10), /reservation_closed/);
});

test('promotional credits lapse (what is left of them); paid credits never do', { skip }, async () => {
  const u = await newUser('exp');
  const g = (await owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, grant_expires_at, reason) VALUES ($1,'grant','promo',100, now() + interval '1 day', 'test') RETURNING id`, [u])).rows[0].id;
  await grant(u, 40, 'paid');
  const rid = await reserve(u, 30, 'exp-1'); await settle(u, rid, 30);            // 30 spent from promo
  assert.equal((await bal(u)).promo, 70);
  await owner.query(`UPDATE credit_ledger SET grant_expires_at = now() - interval '1 minute' WHERE id = $1`, [g]);
  assert.deepEqual(await bal(u), { promo: 0, paid: 40, reserved: 0 });
  assert.deepEqual(await bal(u), { promo: 0, paid: 40, reserved: 0 });             // expiring again changes nothing
  const rows = (await owner.query(`SELECT amount::int FROM credit_ledger WHERE user_id=$1 AND kind='expire'`, [u])).rows;
  assert.deepEqual(rows.map((r) => r.amount), [-70]);
});

test('a coupon with a validity period stamps its grant with an expiry', { skip }, async () => {
  const u = await newUser('cexp'), code = await newCoupon('SHORTLIVED', { amount: 25, grant_valid_days: 7 });
  await redeem(u, code);
  const r = (await owner.query(`SELECT grant_expires_at > now() + interval '6 days' AND grant_expires_at < now() + interval '8 days' AS ok FROM credit_ledger WHERE user_id=$1 AND kind='grant'`, [u])).rows[0];
  assert.equal(r.ok, true);
});

test('one user cannot touch another user\'s reservation, and unauthenticated calls do nothing', { skip }, async () => {
  const a = await newUser('iso_a'), b = await newUser('iso_b');
  await grant(a, 100);
  const rid = await reserve(a, 50, 'iso-1');
  await assert.rejects(settle(b, rid, 1), /reservation_not_found/);
  await assert.rejects(call(b, 'SELECT ao_credit_release($1)', [rid]), /reservation_not_found/);
  await assert.rejects(call(null, 'SELECT * FROM ao_credit_balance()'), /no_user/);
  await assert.rejects(call(null, 'SELECT * FROM ao_redeem_coupon($1)', ['ANYTHING']), /no_user/);
  assert.equal((await bal(a)).reserved, 50);
  assert.deepEqual(await bal(b), { promo: 0, paid: 0, reserved: 0 });
  const seen = await call(b, 'SELECT id FROM credit_ledger');
  assert.equal(seen.length, 0);
});

test('the app role can only move money through the functions', { skip }, async () => {
  const u = await newUser('perm');
  await assert.rejects(call(u, `INSERT INTO credit_ledger(user_id, kind, pool, amount) VALUES ($1,'grant','paid',1000000)`, [u]), /permission denied/);
  await assert.rejects(call(u, `UPDATE credit_ledger SET amount = 1 WHERE user_id = $1`, [u]), /permission denied/);
  await assert.rejects(call(u, `INSERT INTO coupons(code, amount) VALUES ('MYOWNCODE', 5)`), /permission denied/);
  await assert.rejects(call(u, 'SELECT * FROM coupons'), /permission denied/);
  await assert.rejects(call(u, `UPDATE coupons SET amount = 999999`), /permission denied/);
  await assert.rejects(call(u, `INSERT INTO usage_events(user_id, request_id, cost) VALUES ($1,'x',0)`, [u]), /permission denied/);
  await assert.rejects(call(u, `INSERT INTO subscriptions(user_id, plan_id) VALUES ($1,'beta')`, [u]), /permission denied/);
  assert.deepEqual(await bal(u), { promo: 0, paid: 0, reserved: 0 });
});

test('the ledger is append-only for the admin API too, and refuses impossible rows', { skip }, async () => {
  const u = await newUser('led');
  const g = await admin.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount, reason, created_by) VALUES ($1,'grant','paid',10,'support credit','admin') RETURNING id`, [u]);
  await assert.rejects(admin.query('UPDATE credit_ledger SET amount = 9999 WHERE id = $1', [g.rows[0].id]), /permission denied/);
  await assert.rejects(admin.query('DELETE FROM credit_ledger WHERE id = $1', [g.rows[0].id]), /permission denied/);
  await assert.rejects(owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount) VALUES ($1,'grant','paid',-5)`, [u]), /check constraint/);
  await assert.rejects(owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount) VALUES ($1,'settle','paid',5)`, [u]), /check constraint/);
  await assert.rejects(owner.query(`INSERT INTO credit_ledger(user_id, kind, pool, amount) VALUES ($1,'bonus','paid',5)`, [u]), /check constraint/);
  assert.equal((await bal(u)).paid, 10);
});

test('deleting a user removes their money rows', { skip }, async () => {
  const u = await newUser('del'), code = await newCoupon('DELETEME', { amount: 5 });
  await redeem(u, code);
  await owner.query('DELETE FROM users WHERE id = $1', [u]);
  for (const t of ['credit_ledger', 'credit_reservations', 'usage_events', 'coupon_redemptions', 'subscriptions'])
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [u])).rows[0].n, 0, t);
});

test('the admin credits view matches the ledger', { skip }, async () => {
  const u = await newUser('view');
  await grant(u, 30, 'promo'); await grant(u, 12, 'paid');
  const r = (await admin.query('SELECT promo::int, paid::int, plan_id FROM admin_user_credits WHERE user_id = $1', [u])).rows[0];
  assert.deepEqual(r, { promo: 30, paid: 12, plan_id: 'free' });
});
