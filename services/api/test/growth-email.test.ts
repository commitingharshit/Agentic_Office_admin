// Campaign email through the real admin API and the public routes on Postgres, with a fake Resend: who receives it, what every
// message carries, that a send resumes, that nothing goes out without a working unsubscribe, and Resend's signed webhooks.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminHandler, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import type { Mail } from '../src/api/mailer.ts';
import { render, unsubscribeToken, unsubscribeUrl, verifySvix } from '../src/growth/email.ts';
import { growthPublicHandler } from '../src/growth/public.ts';

const ownerUrl = process.env.AO_TEST_PG;
const skip = !ownerUrl && 'AO_TEST_PG not set';
const as = (role: string, pw: string | undefined) => { const u = new URL(ownerUrl!); u.username = role; u.password = pw ?? ''; return u.toString(); };
const tag = Date.now().toString(36);
const TOKEN = `growth-mail-${tag}-0123456789abcdef`;
const UNSUB = Buffer.from('u'.repeat(40));
const HOOK = Buffer.from('resend-webhook-secret-bytes');
let api: Server, base: string, owner: pg.Client, ro: pg.Pool, adm: pg.Pool, deps: AdminDeps;
const sent: Mail[] = [];
const people: Record<string, string> = {};
let campaign = '';

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  ro = new pg.Pool({ connectionString: as('ao_readonly', process.env.AO_READONLY_PASSWORD) });
  adm = new pg.Pool({ connectionString: as('ao_admin', process.env.AO_ADMIN_PASSWORD) });
  let n = 0;
  deps = { ro, admin: adm, tokens: parseTokens(`console:${TOKEN}`), mailer: async (m) => { sent.push(m); return { id: `re_${tag}_${++n}` }; },
    email: { publicUrl: 'https://ao.example.test', unsubscribeKey: UNSUB, webhookSecret: HOOK } };
  const admin = adminHandler(deps);
  const pub = growthPublicHandler({ admin: adm, email: deps.email! });
  api = createServer(async (req, res) => { if (!(await pub(req, res))) await admin(req, res); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  for (const [k, optIn] of [['yes', true], ['no', false], ['unsub', true], ['other', true]] as const) {
    const id = `usr_gm${k}${tag}`;
    people[k] = id;
    await owner.query(`INSERT INTO users(id, email, display_name, status) VALUES ($1, $2, $3, 'active')`, [id, `${id}@example.test`, k === 'yes' ? 'Ada <script>' : k]);
    await owner.query(`INSERT INTO user_promo_prefs(user_id, email_marketing, unsubscribed_at) VALUES ($1, $2, $3)`, [id, optIn, k === 'unsub' ? new Date() : null]);
  }
  campaign = `c_mail_${tag}`;
  await owner.query(`INSERT INTO campaigns(id, name, status) VALUES ($1, $2, 'live')`, [campaign, `mail ${tag}`]);
  await owner.query(`INSERT INTO campaign_targets(campaign_id, user_ids) VALUES ($1, $2)`, [campaign, [people.yes, people.no, people.unsub]]);
});
after(async () => {
  if (skip) return;
  await owner.query('DELETE FROM campaigns WHERE id = $1', [campaign]);
  await owner.query(`DELETE FROM email_templates WHERE name LIKE $1`, [`%${tag}`]);
  await owner.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(people)]);
  api.close();
  await Promise.all([ro.end(), adm.end(), owner.end()]);
});

const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await r.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body };
};
const post = (path: string, data: unknown) => call(path, { method: 'POST', body: JSON.stringify(data) });
const TEMPLATE = { name: `Toolkit ${tag}`, subject: 'Hello {{name}}', html: '<p>Hi {{name}}</p><a href="{{unsubscribe_url}}">Unsubscribe</a>', text: 'Hi {{name}}\nUnsubscribe: {{unsubscribe_url}}' };
function signed(body: string, ts = Math.floor(Date.now() / 1000), id = `msg_${Math.random().toString(36).slice(2)}`, secret = HOOK) {
  const sig = createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` };
}

test('render escapes the name in HTML and keeps the subject on one line', () => {
  const r = render({ subject: 'Hi {{name}}\nBcc: x', html: '<b>{{name}}</b>', text: '{{name}}' }, { name: '<img src=x onerror=1>', unsubscribe_url: 'https://u' });
  assert.equal(r.html, '<b>&lt;img src=x onerror=1&gt;</b>');
  assert.equal(r.subject.includes('\n'), false);
  assert.equal(unsubscribeUrl({ publicUrl: 'https://p', unsubscribeKey: UNSUB }, 'usr_a').startsWith('https://p/v1/unsubscribe?u=usr_a&t='), true);
});

test('a template must carry the unsubscribe link and no script', { skip }, async () => {
  assert.equal((await post('/admin/growth/templates', { ...TEMPLATE, text: 'no link' })).status, 400);
  assert.equal((await post('/admin/growth/templates', { ...TEMPLATE, html: TEMPLATE.html + '<script>x</script>' })).status, 400);
  assert.equal((await post('/admin/growth/templates', TEMPLATE)).status, 200);
});

test('only opted-in, not unsubscribed, targeted people receive it; every message has List-Unsubscribe; a re-run sends nothing twice', { skip }, async () => {
  const t = (await call('/admin/growth/templates')).body.templates.find((x: { name: string }) => x.name === TEMPLATE.name);
  const r = await post(`/admin/growth/campaigns/${campaign}/email`, { template_id: t.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.sent, r.body.failed, r.body.remaining], [1, 0, false]);
  assert.deepEqual(sent.map((m) => m.to), [`${people.yes}@example.test`]);
  const m = sent[0];
  assert.match(m.headers!['List-Unsubscribe'], /^<https:\/\/ao\.example\.test\/v1\/unsubscribe\?u=usr_/);
  assert.equal(m.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(m.html!.includes('Ada &lt;script&gt;'));
  assert.equal((await post(`/admin/growth/campaigns/${campaign}/email`, { template_id: t.id })).body.sent, 0);
  assert.equal(sent.length, 1);
});

test('nothing is sent without a working unsubscribe link', { skip }, async () => {
  const saved = deps.email; deps.email = { ...saved, publicUrl: undefined };
  try {
    const t = (await call('/admin/growth/templates')).body.templates.find((x: { name: string }) => x.name === TEMPLATE.name);
    const r = await post(`/admin/growth/campaigns/${campaign}/email`, { template_id: t.id });
    assert.equal(r.status, 409); assert.match(r.body.error, /unsubscribe/);
  } finally { deps.email = saved; }
});

test('Resend webhooks: signed ones update delivery (never downgrading), replays and forgeries are refused, a complaint unsubscribes', { skip }, async () => {
  const providerId = (await owner.query(`SELECT provider_id FROM email_deliveries WHERE user_id = $1`, [people.yes])).rows[0].provider_id;
  const hook = (type: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) => {
    const body = JSON.stringify({ type, data: { email_id: providerId, ...extra } });
    return fetch(`${base}/v1/webhooks/resend`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(headers ?? signed(body)) } });
  };
  assert.equal((await hook('email.clicked')).status, 200);
  assert.equal((await hook('email.delivered')).status, 200);
  assert.equal((await owner.query(`SELECT status FROM email_deliveries WHERE provider_id = $1`, [providerId])).rows[0].status, 'clicked', 'a later "delivered" does not undo "clicked"');
  const body = JSON.stringify({ type: 'email.opened', data: { email_id: providerId } });
  const h = signed(body);
  assert.equal((await fetch(`${base}/v1/webhooks/resend`, { method: 'POST', body, headers: h })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/v1/webhooks/resend`, { method: 'POST', body, headers: h })).json(), { duplicate: true });
  assert.equal((await hook('email.bounced', {}, signed(body, undefined, undefined, Buffer.from('wrong')))).status, 401);
  assert.equal((await hook('email.bounced', {}, signed(JSON.stringify({ type: 'email.bounced', data: { email_id: providerId } }), Math.floor(Date.now() / 1000) - 600))).status, 400);
  assert.equal((await hook('email.complained')).status, 200);
  const prefs = (await owner.query(`SELECT email_marketing, unsubscribed_at FROM user_promo_prefs WHERE user_id = $1`, [people.yes])).rows[0];
  assert.equal(prefs.email_marketing, false); assert.ok(prefs.unsubscribed_at);
  assert.throws(() => verifySvix(HOOK, {}, 'x'), /Missing/);
});

test('the unsubscribe link: a page that asks, a POST (and mail clients\' one-click) that does it, and forged links refused', { skip }, async () => {
  const u = people.other, t = unsubscribeToken(UNSUB, u);
  await owner.query(`UPDATE user_promo_prefs SET email_marketing = true, unsubscribed_at = NULL WHERE user_id = $1`, [u]);
  const page = await fetch(`${base}/v1/unsubscribe?u=${u}&t=${t}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /<form method="post"/);
  assert.equal((await owner.query(`SELECT email_marketing FROM user_promo_prefs WHERE user_id = $1`, [u])).rows[0].email_marketing, true, 'opening the page changes nothing');
  const done = await fetch(`${base}/v1/unsubscribe?u=${u}&t=${t}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(done.status, 200); assert.match(await done.text(), /You are unsubscribed/);
  assert.equal((await owner.query(`SELECT email_marketing FROM user_promo_prefs WHERE user_id = $1`, [u])).rows[0].email_marketing, false);
  assert.equal((await fetch(`${base}/v1/unsubscribe?u=${u}&t=forged`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}/v1/unsubscribe?u=${people.no}&t=${t}`, { method: 'POST' })).status, 400, 'a token is bound to one person');
});
