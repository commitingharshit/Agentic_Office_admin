// Runs against a live database migrated by db/migrate.ts:
//   AO_TEST_PG=postgres://…@127.0.0.1:55432/agentic_office  (owner URL; role
//   passwords via AO_APP_PASSWORD / AO_READONLY_PASSWORD / AO_ADMIN_PASSWORD)
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
// u.username = role; u.password = pw; return u.toString(); };
const conns: pg.Client[] = [];
async function connect(url: string) { const c = new pg.Client({ connectionString: url }); await c.connect(); conns.push(c); return c; }
const tag = Date.now().toString(36);
const A = `usr_a_${tag}`, B = `usr_b_${tag}`;
let owner: pg.Client;

before(async () => {
  if (skip) return;
  owner = await connect(ownerUrl!);
  await owner.query(`INSERT INTO users(id, email) VALUES ($1,'a@example.test'),($2,'b@example.test')`, [A, B]);
  await owner.query(`INSERT INTO sessions(id, user_id) VALUES ($1,$2),($3,$4)`, [`ses_a_${tag}`, A, `ses_b_${tag}`, B]);
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [[A, B]]);
  await Promise.all(conns.map((c) => c.end()));
});

async function asUser<T>(client: pg.Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
  try { return await fn(); } finally { await client.query('ROLLBACK'); }
}

test('row-level security: the app role only sees its own rows', { skip }, async () => {
  const app = await connect(as('ao_app', process.env.AO_APP_PASSWORD));
  const rows = await asUser(app, A, () => app.query('SELECT id FROM sessions'));
  assert.deepEqual(rows.rows.map((r: { id: string }) => r.id), [`ses_a_${tag}`]);
  const none = await app.query('SELECT count(*)::int AS n FROM sessions');   // no user set → nothing
  assert.equal(none.rows[0].n, 0);
  await assert.rejects(asUser(app, A, () => app.query(`INSERT INTO sessions(id, user_id) VALUES ('x_${tag}', $1)`, [B])), /row-level security/);
});

test('session events: event_id is idempotent and sequences are unique per session', { skip }, async () => {
  const app = await connect(as('ao_app', process.env.AO_APP_PASSWORD));
  const ins = `INSERT INTO session_events(event_id,user_id,session_id,sequence,type,created_at)
               VALUES ($1,$2,$3,$4,'tool.call',now()) ON CONFLICT (event_id) DO NOTHING`;
  await asUser(app, A, async () => {
    const first = await app.query(ins, [`evt_1_${tag}`, A, `ses_a_${tag}`, 1]);
    const retry = await app.query(ins, [`evt_1_${tag}`, A, `ses_a_${tag}`, 1]);
    assert.equal(first.rowCount, 1);
    assert.equal(retry.rowCount, 0);
    await assert.rejects(app.query(ins, [`evt_2_${tag}`, A, `ses_a_${tag}`, 1]), /duplicate key/);
  });
});

test('read-only role: sees every user, cannot write, cannot read event payloads', { skip }, async () => {
  const ro = await connect(as('ao_readonly', process.env.AO_READONLY_PASSWORD));
  const n = await ro.query('SELECT count(*)::int AS n FROM admin_user_overview WHERE id = ANY($1)', [[A, B]]);
  assert.equal(n.rows[0].n, 2);
  await assert.rejects(ro.query(`UPDATE users SET status='disabled' WHERE id=$1`, [A]), /read-only|permission denied/);
  await assert.rejects(ro.query('SELECT payload FROM session_events LIMIT 1'), /permission denied/);
  const ok = await ro.query('SELECT count(*) FROM session_events');
  assert.ok(ok.rows.length === 1);
  const signups = await ro.query('SELECT day, signups FROM admin_signups_daily');
  assert.ok(signups.rows.length >= 1);
});

test('admin role: acts across users, but the audit log is append-only', { skip }, async () => {
  const adm = await connect(as('ao_admin', process.env.AO_ADMIN_PASSWORD));
  await adm.query(`UPDATE users SET status='disabled' WHERE id=$1`, [B]);
  const audit = await adm.query(`INSERT INTO admin_audit(admin_user_id, action, target_user_id) VALUES ('usr_admin','disable',$1) RETURNING id`, [B]);
  await assert.rejects(adm.query('DELETE FROM admin_audit WHERE id=$1', [audit.rows[0].id]), /permission denied/);
  await assert.rejects(adm.query(`UPDATE admin_audit SET action='x' WHERE id=$1`, [audit.rows[0].id]), /permission denied/);
  await owner.query('DELETE FROM admin_audit WHERE id=$1', [audit.rows[0].id]);
});
