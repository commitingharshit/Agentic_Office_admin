// The console authenticates to the marketplace admin API with ONE service token and names the signed-in admin in `x-ao-acting-admin`.
// The permission check, the separation-of-duties rules and admin_audit must be about THAT PERSON, not the token. Found by the real
// console end-to-end run (scripts/e2e/marketplace-admin): every console admin used to get the service token's role, so an analyst could
// approve and every action was recorded under the token's name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type pg from 'pg';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import type { AdminRole } from '../src/marketplace/permissions.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const PPTX = new Uint8Array(readFileSync(new URL('./fixtures/marketplace/board-update.pptx', import.meta.url)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const tok = (c: string) => c.repeat(30);
const TOKENS: Record<string, [string, AdminRole]> = { console: [tok('c'), 'superadmin'], lowly: [tok('l'), 'analyst'] };
const PEOPLE: Record<string, AdminRole | null> = { usr_ana: 'analyst', usr_eng: 'engineer', usr_eng2: 'engineer', usr_root: 'superadmin', usr_gone: null };
const tokens = parseTokens(Object.entries(TOKENS).map(([k, [t]]) => `${k}:${t}`).join(','));
function templateZip(id: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'template.pptx': PPTX, 'previews/1.png': PNG };
  const manifest = { schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: 'Deck', summary: 'A deck.', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { format: 'pptx', file: 'template.pptx', previews: ['previews/1.png'] } };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}

describe('marketplace admin API acts for the person the console names', { skip }, () => {
  let h: MarketplacePg, admin: pg.Client, api: Server, bare: Server, base = '', bareBase = '';
  const call = async (path: string, o: { token?: string; acting?: string; method?: string; body?: unknown; zip?: Uint8Array; origin?: string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${TOKENS[o.token ?? 'console'][0]}` };
    if (o.acting) headers['x-ao-acting-admin'] = o.acting;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; } else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch((o.origin ?? base) + path, { method: o.method ?? (o.zip ? 'POST' : 'GET'), headers, body } as RequestInit);
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  };
  before(async () => {
    h = await startMarketplacePg(); admin = h.admin;
    const deps = { tokens } as unknown as AdminDeps;
    const roleOf = (id: string) => TOKENS[id]?.[1] ?? 'analyst';
    const mk = (extra: Record<string, unknown>) => { const hd = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, deps), roleOf, store: memoryArtifactStore(), ...extra }); return createServer(async (req, res) => { if (!(await hd(req, res))) res.writeHead(404).end(); }); };
    api = mk({ actingRole: (id: string) => PEOPLE[id] ?? null }); bare = mk({});
    await Promise.all([api, bare].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`; bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
    await h.owner.query(`INSERT INTO users(id) VALUES ('usr_pub')  ON CONFLICT DO NOTHING; INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ('acme','Acme','usr_pub',true)`);
  });
  after(async () => { api?.close(); bare?.close(); if (h) await h.stop(); });

  test('/me reports the acting person\'s role, not the token\'s', async () => {
    assert.deepEqual((await call('/admin/marketplace/me')).json.role, 'superadmin');
    assert.equal((await call('/admin/marketplace/me', { acting: 'usr_ana' })).json.role, 'analyst');
    assert.deepEqual((await call('/admin/marketplace/me', { acting: 'usr_eng' })).json.permissions, ['marketplace.read', 'marketplace.write', 'marketplace.review']);
  });

  test('an analyst acting through a superadmin token is refused every write and changes nothing', async () => {
    const n = async () => (await admin.query('SELECT (SELECT count(*) FROM marketplace_versions)::int v, (SELECT count(*) FROM admin_audit)::int a')).rows[0];
    const before_ = await n();
    assert.equal((await call('/admin/marketplace/submissions?publisher=acme&visibility=public', { acting: 'usr_ana', zip: templateZip('acme/x1') })).status, 403);
    assert.equal((await call('/admin/marketplace/type-policy/skill', { acting: 'usr_ana', method: 'PUT', body: { reason: 'nope' } })).status, 403);
    assert.equal((await call('/admin/marketplace/types/skill/halt', { acting: 'usr_ana', method: 'POST', body: { reason: 'nope' } })).status, 403);
    assert.deepEqual(await n(), before_);
  });

  test('separation of duties and the audit trail are per person', async () => {
    const s = await call('/admin/marketplace/submissions?publisher=acme&visibility=public', { acting: 'usr_eng', zip: templateZip('acme/x2') });
    assert.equal(s.status, 201);
    const vid = s.json.versionId;
    const self = await call(`/admin/marketplace/versions/${vid}/approve`, { acting: 'usr_eng', method: 'POST', body: {} });
    assert.equal(self.status, 409); assert.equal(self.json.code, 'self_review');
    assert.equal((await call(`/admin/marketplace/versions/${vid}/approve`, { acting: 'usr_eng2', method: 'POST', body: {} })).status, 200);
    const rows = (await admin.query(`SELECT action, admin_user_id FROM admin_audit WHERE detail->>'versionId' = $1 ORDER BY id`, [vid])).rows;
    assert.deepEqual(rows, [{ action: 'marketplace.submit', admin_user_id: 'usr_eng' }, { action: 'marketplace.approve', admin_user_id: 'usr_eng2' }]);
  });

  test('the header is refused for what is not an active admin, for a malformed id, for a non-superadmin token, and where unsupported', async () => {
    assert.equal((await call('/admin/marketplace/me', { acting: 'usr_gone' })).status, 403);
    assert.equal((await call('/admin/marketplace/me', { acting: 'usr_nobody' })).status, 403);
    assert.equal((await call('/admin/marketplace/me', { acting: 'root; drop' })).status, 400);
    assert.equal((await call('/admin/marketplace/me', { token: 'lowly', acting: 'usr_root' })).status, 403, 'an analyst token cannot become a superadmin');
    assert.equal((await call('/admin/marketplace/me', { acting: 'usr_root', origin: bareBase })).status, 400);
  });
});
