// Plan 4 Task 14 (server half): what the admin console's verification views read. Real Postgres, real roles.
//   * catalog rows carry the latest verification verdict of the latest version (for the "Verification" column);
//   * GET versions/:id/evidence?sha=... streams one evidence blob to a reviewer, only when a verification row of THAT version references it;
//   * GET security/verification lists versions whose current verification failed or is incomplete.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { authenticate, parseTokens, type AdminDeps } from '../src/api/admin.ts';
import { marketplaceAdminHandler } from '../src/api/marketplace-admin.ts';
import { MANIFEST_NAME, memoryArtifactStore, sha256Hex } from '../src/marketplace/artifacts.ts';
import type { AdminRole } from '../src/marketplace/permissions.ts';
import { getPipeline, registerPipeline, unregisterPipelineForTest } from '../src/marketplace/verify/registry.ts';
import { skip, startMarketplacePg, type MarketplacePg } from './helpers/marketplace-pg.ts';

const PPTX = new Uint8Array(readFileSync(new URL('./fixtures/marketplace/board-update.pptx', import.meta.url)));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TOK: Record<string, [string, AdminRole]> = { root: ['r'.repeat(30), 'superadmin'], eng: ['e'.repeat(30), 'engineer'], ana: ['a'.repeat(30), 'analyst'] };
const tokens = parseTokens(Object.entries(TOK).map(([k, [t]]) => `${k}:${t}`).join(','));

function templateZip(id: string): Uint8Array {
  const files: Record<string, Uint8Array> = { 'template.pptx': PPTX, 'previews/1.png': PNG };
  const manifest = { schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: 'Deck', summary: 'A deck.', license: 'MIT', compat: { app: '^1.0.0' }, dependencies: [], permissions: [],
    files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })), payload: { format: 'pptx', file: 'template.pptx', previews: ['previews/1.png'] } };
  return zipSync({ [MANIFEST_NAME]: strToU8(JSON.stringify(manifest)), ...files });
}
const stage = (o: Record<string, unknown> = {}) => ({ id: 'manifest', title: 'Manifest', required: true, status: 'pass', evidence: [], durationMs: 5, ...o });
const result = (sha: string, o: Record<string, unknown> = {}) => ({ type: 'template', pipeline: 'template-basic', pipelineVersion: 1, subjectSha256: sha, verdict: 'pass', stages: [stage()], env: {},
  startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:00:01.000Z', ...o });

describe('admin verification views (real Postgres)', { skip }, () => {
  let h: MarketplacePg, api: Server, base = '', registered = false;
  const store = memoryArtifactStore();
  const call = async (path: string, o: { as?: string; body?: unknown; zip?: Uint8Array } = {}) => {
    const headers: Record<string, string> = {};
    if (o.as) headers.authorization = `Bearer ${TOK[o.as][0]}`;
    let body: any;
    if (o.zip) { headers['content-type'] = 'application/zip'; body = o.zip; } else if (o.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.body); }
    const r = await fetch(base + path, { method: o.zip || body !== undefined ? 'POST' : 'GET', headers, body } as RequestInit);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let json: any; try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* binary */ }
    return { status: r.status, json, bytes, headers: r.headers };
  };
  const mk = async (id: string) => { const zip = templateZip(id), r = await call('/admin/marketplace/submissions', { as: 'root', zip }); assert.equal(r.status, 201, JSON.stringify(r.json)); return { vid: r.json.versionId as string, sha: sha256Hex(zip) }; };
  const record = (vid: string, body: unknown) => call(`/admin/marketplace/versions/${vid}/verification`, { as: 'eng', body });

  before(async () => {
    h = await startMarketplacePg();
    const deps = { tokens } as unknown as AdminDeps;
    const handler = marketplaceAdminHandler({ admin: h.pool('ao_admin'), authenticate: (req) => authenticate(req, deps), roleOf: (id) => TOK[id][1], store });
    api = createServer(async (req, res) => { if (!(await handler(req, res))) res.writeHead(404).end(); });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    if (!getPipeline('template')) { registerPipeline({ type: 'template', name: 'template-basic', version: 1, stages: [{ id: 'manifest', title: 'Manifest', required: true, timeoutMs: 1000, run: async () => ({ status: 'pass', evidence: [] }) }] }); registered = true; }
  });
  after(async () => { if (registered) unregisterPipelineForTest('template'); api?.close(); if (h) await h.stop(); });

  test('catalog rows carry the verification verdict of the latest version: none, pass, incomplete, fail', async () => {
    const none = await mk('acme/vnone'), pass = await mk('acme/vpass'), inc = await mk('acme/vinc'), bad = await mk('acme/vbad');
    await record(pass.vid, result(pass.sha));
    await record(inc.vid, result(inc.sha, { verdict: 'incomplete', stages: [stage(), stage({ id: 'render', title: 'Render', status: 'skipped', reason: 'tool-missing:officecli' })] }));
    await record(bad.vid, result(bad.sha, { verdict: 'fail', stages: [stage({ status: 'fail', reason: 'bad' })] }));
    const r = await call('/admin/marketplace/catalog?type=template', { as: 'ana' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const by = (id: string) => r.json.items.find((i: any) => i.id === id);
    assert.equal(by('acme/vnone').verification, null);
    assert.equal(by('acme/vpass').verification, 'pass');
    assert.equal(by('acme/vinc').verification, 'incomplete');
    assert.equal(by('acme/vbad').verification, 'fail');
    assert.ok(none.vid);
    assert.ok(!JSON.stringify(r.json).match(/score|confidence/i));
  });

  test('evidence: a reviewer reads a blob referenced by that version only; others are a uniform 404; headers neutralise it', async () => {
    const { vid, sha } = await mk('acme/vev');
    const other = await mk('acme/vev2');
    const blob = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]); const bsha = sha256Hex(blob);
    await store.put(bsha, blob);
    const r = await record(vid, result(sha, { stages: [stage({ evidence: [{ kind: 'image', label: 'page 1', blob: { sha256: bsha, mime: 'image/png', size: blob.length } }] })] }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ok = await call(`/admin/marketplace/versions/${vid}/evidence?sha=${bsha}`, { as: 'ana' });
    assert.equal(ok.status, 200);
    assert.deepEqual([...ok.bytes], [...blob]);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.match(ok.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    // the same sha under another version, an unreferenced sha, and a malformed one all look identical
    for (const p of [`/admin/marketplace/versions/${other.vid}/evidence?sha=${bsha}`, `/admin/marketplace/versions/${vid}/evidence?sha=${'0'.repeat(64)}`, `/admin/marketplace/versions/${vid}/evidence?sha=../etc/passwd`, `/admin/marketplace/versions/${vid}/evidence`]) {
      const x = await call(p, { as: 'ana' }); assert.equal(x.status, 404, p);
    }
    assert.equal((await call(`/admin/marketplace/versions/${vid}/evidence?sha=${bsha}`)).status, 401);
  });

  test('security/verification lists versions whose current verification is failed or incomplete, with the stage ids and reasons', async () => {
    const r = await call('/admin/marketplace/security/verification', { as: 'ana' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const verdicts = Object.fromEntries(r.json.items.map((i: any) => [i.listingId, i.verdict]));
    assert.equal(verdicts['acme/vinc'], 'incomplete'); assert.equal(verdicts['acme/vbad'], 'fail');
    assert.equal(verdicts['acme/vpass'], undefined); assert.equal(verdicts['acme/vnone'], undefined);
    const inc = r.json.items.find((i: any) => i.listingId === 'acme/vinc');
    assert.deepEqual(inc.problemStages.map((s: any) => [s.id, s.status, s.reason]), [['render', 'skipped', 'tool-missing:officecli']]);
  });
});
