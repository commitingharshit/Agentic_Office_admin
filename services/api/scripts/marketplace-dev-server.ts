// DEV ONLY. A real marketplace API on your machine, seeded with a few real packages, so the desktop Marketplace UI can be
// run and looked at against real data instead of mocks. Never deploy this: it accepts a fixed bearer token.
//
//   node scripts/marketplace-dev-server.ts [--port 8791] [--http] [--bulk 30] [--hostile] [--state <file>]
//   OFFICECLI_TIMEOUT_MS=120000 raises the render-check budget (30 s) on a loaded machine.
//
// What it does
//   1. starts embedded Postgres in a temp directory (the harness of test/helpers/marketplace-pg.ts: stub users/devices/
//      admin_audit, migration 0016, roles ao_app / ao_admin, so row-level security is the real one);
//   2. serves `marketplaceHandler` (src/api/marketplace.ts) on 127.0.0.1 with an in-memory artifact store. The only token
//      it accepts is the bearer `dev-token`, which is user `usr_dev` (device `dev-device`); no token means anonymous;
//   3. seeds, through the ao_admin connection, the packages below, built as real zips and run through the real
//      validators (templates: the officecli render check; skill: the Hermes Skills Guard scan) before they are inserted:
//        agentic-office/board-memo      template (docx) from templates/docx/board-memo.docx
//        agentic-office/board-update    template (pptx) from templates/pptx/board-update.pptx
//        dev-community/docx-outline     skill, from scripts/dev-seed/docx-outline/ (ships a python script: exec.script)
//        dev-community/memo-style       skill, from scripts/dev-seed/memo-style/ (SKILL.md + references only: no confirmation dialog)
//      previews are rendered with `officecli view <file> screenshot` (skipped, and said so, when officecli is missing),
//      plus a few reviews and favorites by fake users so the stats are not all zero. `--bulk N` adds N more template
//      listings (copies of board-memo under other ids) to exercise paging. `--hostile` adds dev-community/hostile-docs, a skill
//      whose SKILL.md is hostile markdown (inserted WITHOUT the publish validators on purpose: it checks the viewer, not the gate).
//
// It serves https with a throwaway self-signed certificate by default, because the workbench's content security policy only
// lets the renderer connect to https: start the test window with --ignore-certificate-errors. `--http` serves plain http.
// Seed data lives only in this directory and is never imported by src/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { HttpError } from '../src/api/sync.ts';
import { marketplaceHandler } from '../src/api/marketplace.ts';
import { memoryArtifactStore, putArtifact, sha256Hex, unpack } from '../src/marketplace/artifacts.ts';
import { officecliRenderer } from '../src/marketplace/validate/officecli.ts';
import { registerValidator, validateArtifact } from '../src/marketplace/validate/index.ts';
import { createSkillValidator } from '../src/marketplace/validate/skill.ts';
import { createSkillsGuardScanner } from '../src/marketplace/validate/skillsGuard.ts';
import { createTemplateValidator } from '../src/marketplace/validate/template.ts';
import type { ManifestV1, PermissionRequest } from '../src/marketplace/types.ts';
import { startMarketplacePg } from '../test/helpers/marketplace-pg.ts';

if (process.env.NODE_ENV === 'production') {
  console.error('marketplace-dev-server: refusing to start with NODE_ENV=production (this server accepts a fixed dev token).');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? 8791);
const BULK = Number(opt('--bulk') ?? 0);
const HTTP = args.includes('--http');
const STATE = opt('--state');
const HOSTILE = args.includes('--hostile');

/** DEV ONLY: the one bearer this server accepts. */
export const DEV_TOKEN = 'dev-token';
const DEV_USER = 'usr_dev';
const authenticate = async (req: { headers: { authorization?: string } }) => {
  const t = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (t !== DEV_TOKEN) throw new HttpError(401, 'Sign in again (the dev server accepts only the dev token).');
  return { uid: DEV_USER };
};

/** The validator's render check runs officecli with a minimal PATH, so hand it an absolute path. */
const OFFICECLI = process.env.OFFICECLI_BIN ?? (spawnSync('sh', ['-c', 'command -v officecli'], { encoding: 'utf8' }).stdout.trim() || 'officecli');
const enc = (s: string) => new TextEncoder().encode(s);
const log = (m: string) => console.log(`[dev-seed] ${m}`);

// ---------------------------------------------------------------- package building

interface Built { manifest: ManifestV1; bytes: Uint8Array; scan: 'clean' | 'pending' }

/** `validate: false` only for the --bulk copies, whose files are byte-identical to a template that was validated in full. */
async function build(manifest: Omit<ManifestV1, 'files'>, files: Record<string, Uint8Array>, validate = true): Promise<Built> {
  const full: ManifestV1 = { ...manifest, files: Object.entries(files).map(([path, b]) => ({ path, sha256: sha256Hex(b), size: b.length })) };
  const bytes = zipSync({ 'agentic.marketplace.json': enc(JSON.stringify(full, null, 2)), ...files });
  if (!validate) return { manifest: full, bytes, scan: 'clean' };
  const report = await validateArtifact(full.type, unpack(bytes));
  if (!report.ok) throw new Error(`seed package ${full.id} failed validation: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
  const skipped = report.checks.filter((c) => c.skipped).map((c) => c.name);
  if (skipped.length) log(`${full.id}: checks skipped (${skipped.join(', ')}); scan verdict stays 'pending'`);
  return { manifest: full, bytes, scan: report.verified ? 'clean' : 'pending' };
}

function renderPreview(file: string): Uint8Array | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'mkt-seed-prev-'));
  try {
    const out = join(dir, 'p.png');
    const r = spawnSync(OFFICECLI, ['view', file, 'screenshot', '--out', out, '--page', '1', '--screenshot-width', '900', '--screenshot-height', '700'], { timeout: 60_000, stdio: 'ignore' });
    if (r.status !== 0) return undefined;
    return new Uint8Array(readFileSync(out));
  } catch { return undefined; } finally { rmSync(dir, { recursive: true, force: true }); }
}

function templatePackage(id: string, title: string, summary: string, rel: string, format: 'docx' | 'pptx') {
  const src = join(repo, rel);
  const file = new Uint8Array(readFileSync(src));
  let png = renderPreview(src);
  if (!png) {
    // the template validator requires at least one preview: fall back to the thumbnail the repo already ships for this template
    const shipped = join(repo, 'templates', 'thumbnails', `${format}-${rel.split('/').pop()!.replace(/\.[^.]+$/, '')}.png`);
    try { png = new Uint8Array(readFileSync(shipped)); log(`${id}: officecli unavailable, using the shipped thumbnail ${relative(repo, shipped)}`); } catch { throw new Error(`${id}: officecli unavailable and no shipped thumbnail`); }
  }
  const name = `${id.split('/')[1]}.${format}`;
  const files: Record<string, Uint8Array> = { [name]: file, 'previews/page-1.png': png };
  return { files, payload: { format, file: name, previews: ['previews/page-1.png'] }, title, summary };
}

async function skillPackage(): Promise<Built> {
  const dir = join(here, 'dev-seed', 'docx-outline');
  const files: Record<string, Uint8Array> = {};
  for (const rel of ['SKILL.md', 'references/styles.md', 'scripts/outline.py']) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
  const permissions: PermissionRequest[] = [
    { capability: 'fs.workspace.read', scope: '**/*.docx', reason: 'Reads the Word files you ask it to outline.' },
    { capability: 'exec.script', scope: 'scripts/outline.py', reason: 'Runs the bundled Python script that reads the heading styles.' },
  ];
  return build({ schema: 'agentic.marketplace/1', id: 'dev-community/docx-outline', type: 'skill', version: '1.0.0', title: 'DOCX Outline', license: 'MIT',
    summary: 'Prints the heading outline of a Word document so its structure can be reviewed before editing.', compat: { app: '*' }, dependencies: [], permissions,
    payload: { name: 'docx-outline', entry: 'SKILL.md' } }, files);
}

async function memoStylePackage(): Promise<Built> {
  const dir = join(here, 'dev-seed', 'memo-style');
  const files: Record<string, Uint8Array> = {};
  for (const rel of ['SKILL.md', 'references/checklist.md']) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
  return build({ schema: 'agentic.marketplace/1', id: 'dev-community/memo-style', type: 'skill', version: '1.0.0', title: 'Memo Style', license: 'MIT',
    summary: 'House style for short decision memos: decision first, then summary, plan, risks and next steps.', compat: { app: '*' }, dependencies: [], permissions: [],
    payload: { name: 'memo-style', entry: 'SKILL.md' } }, files);
}

// ---------------------------------------------------------------- main

async function main() {
  registerValidator('template', createTemplateValidator({ officecli: officecliRenderer({ bin: OFFICECLI, ...(process.env.OFFICECLI_TIMEOUT_MS ? { timeoutMs: Number(process.env.OFFICECLI_TIMEOUT_MS) } : {}) }) }));
  try { registerValidator('skill', createSkillValidator({ scanner: createSkillsGuardScanner() })); } catch (e) { log(`skills scanner unavailable: ${(e as Error).message}`); }

  const h = await startMarketplacePg();
  const store = memoryArtifactStore();
  const admin = h.admin;
  const publishers = [['agentic-office', 'Agentic Office', 'usr_pub', true], ['dev-community', 'Dev Community', 'usr_pub2', false]] as const;

  await h.owner.query(`INSERT INTO users(id, email) VALUES ('usr_dev','dev@example.test'),('usr_pub','pub@example.test'),('usr_pub2','pub2@example.test'),
    ('usr_r1','r1@example.test'),('usr_r2','r2@example.test'),('usr_r3','r3@example.test'),('usr_r4','r4@example.test');
    INSERT INTO devices(id, user_id) VALUES ('dev-device','usr_dev')`);
  for (const [id, name, owner, verified] of publishers) await admin.query(`INSERT INTO marketplace_publishers(id, display_name, owner_user_id, verified) VALUES ($1,$2,$3,$4)`, [id, name, owner, verified]);

  const insert = async (b: Built, o: { trust: string; tags: string[] }) => {
    const { sha256, size } = await putArtifact(store, b.bytes);
    await admin.query(`INSERT INTO marketplace_artifacts(sha256, size, storage_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [sha256, size, `dev/${sha256}`]);
    const [pub] = b.manifest.id.split('/');
    await admin.query(`INSERT INTO marketplace_listings(id, type, publisher_id, owner_user_id, visibility, trust, title, summary, tags) VALUES ($1,$2,$3,$4,'public',$5,$6,$7,$8)`,
      [b.manifest.id, b.manifest.type, pub, publishers.find((p) => p[0] === pub)![2], o.trust, b.manifest.title, b.manifest.summary, o.tags]);
    await admin.query(`INSERT INTO marketplace_versions(id, listing_id, version, semver_major, semver_minor, semver_patch, state, manifest, sha256, size, compat, scan_verdict)
      VALUES ($1,$2,$3,1,0,0,'published',$4,$5,$6,$7,$8)`, [`ver_${b.manifest.id.replace('/', '_')}_1`, b.manifest.id, b.manifest.version, JSON.stringify(b.manifest), sha256, size, JSON.stringify(b.manifest.compat), b.scan]);
  };

  const memo = templatePackage('agentic-office/board-memo', 'Board Memo', 'A decision memo for the board: decision required, summary, plan, risks and next steps.', 'templates/docx/board-memo.docx', 'docx');
  const deck = templatePackage('agentic-office/board-update', 'Board Update Deck', 'A six-slide board update: results, plan, risks and the ask.', 'templates/pptx/board-update.pptx', 'pptx');
  const mk = (id: string, t: ReturnType<typeof templatePackage>) => build({ schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: t.title, summary: t.summary, license: 'MIT',
    compat: { app: '*' }, dependencies: [], permissions: [], payload: t.payload }, t.files);
  await insert(await mk('agentic-office/board-memo', memo), { trust: 'official', tags: ['board', 'memo', 'docx'] });
  await insert(await mk('agentic-office/board-update', deck), { trust: 'official', tags: ['board', 'deck', 'pptx'] });
  await insert(await skillPackage(), { trust: 'community', tags: ['docx', 'outline', 'review'] });
  await insert(await memoStylePackage(), { trust: 'community', tags: ['memo', 'writing'] });
  if (HOSTILE) {
    const md = new Uint8Array(readFileSync(join(here, 'dev-seed', 'hostile-docs', 'SKILL.md')));
    await insert(await build({ schema: 'agentic.marketplace/1', id: 'dev-community/hostile-docs', type: 'skill', version: '1.0.0', title: 'Hostile Docs (fixture)', license: 'MIT',
      summary: 'Dev fixture: documentation full of hostile markdown.', compat: { app: '*' }, dependencies: [], permissions: [], payload: { name: 'hostile-docs', entry: 'SKILL.md' } }, { 'SKILL.md': md }, false), { trust: 'community', tags: ['fixture'] });
  }
  for (let n = 1; n <= BULK; n++) {
    const id = `dev-community/memo-copy-${String(n).padStart(2, '0')}`;
    await insert(await build({ schema: 'agentic.marketplace/1', id, type: 'template', version: '1.0.0', title: `Memo copy ${n}`, summary: `Bulk seed ${n}: the board memo again, to exercise paging.`, license: 'MIT',
      compat: { app: '*' }, dependencies: [], permissions: [], payload: memo.payload }, memo.files, false), { trust: 'community', tags: ['bulk'] });
  }

  // a few reviews and favorites by fake users: stats are derived by the database from these rows, never typed in
  const rev = (listing: string, user: string, stars: number, body: string | null) => admin.query(`INSERT INTO marketplace_reviews(id, listing_id, user_id, stars, body) VALUES ($1,$2,$3,$4,$5)`, [`rev_${listing.replace('/', '_')}_${user}`, listing, user, stars, body]);
  await rev('agentic-office/board-memo', 'usr_r1', 5, 'Saved me an hour. The decision-required block up front is the right call.');
  await rev('agentic-office/board-memo', 'usr_r2', 4, null);
  await rev('agentic-office/board-memo', 'usr_r3', 4, 'Good structure; I swapped the risk table for our own.');
  await rev('dev-community/docx-outline', 'usr_r4', 3, 'Works, but only reads heading styles, as documented.');
  for (const [l, u] of [['agentic-office/board-memo', 'usr_r1'], ['agentic-office/board-memo', 'usr_r2'], ['agentic-office/board-update', 'usr_r1'], ['dev-community/docx-outline', 'usr_r3']]) {
    await admin.query(`INSERT INTO marketplace_favorites(listing_id, user_id) VALUES ($1,$2)`, [l, u]);
  }

  const app = h.pool('ao_app');
  const handler = marketplaceHandler({ app, admin: h.pool('ao_admin'), authenticate, store });
  const onReq = async (req: any, res: any) => { if (!(await handler(req, res))) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}'); } };
  let certDir: string | undefined;
  let server;
  if (HTTP) server = createHttpServer(onReq);
  else {
    certDir = mkdtempSync(join(tmpdir(), 'mkt-dev-cert-'));
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('openssl is needed for https; pass --http for plain http');
    server = createHttpsServer({ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) }, onReq);
  }
  await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));
  const url = `${HTTP ? 'http' : 'https'}://127.0.0.1:${PORT}`;
  console.log(`marketplace dev server: ${url}  (bearer: ${DEV_TOKEN} = ${DEV_USER}, device dev-device)`);
  if (STATE) { mkdirSync(dirname(resolve(STATE)), { recursive: true }); writeFileSync(STATE, JSON.stringify({ url, pid: process.pid, token: DEV_TOKEN, user: DEV_USER, device: 'dev-device', ...(certDir ? { ca: join(certDir, 'c.pem') } : {}) })); }
  log(`seeded: ${relative(repo, join(repo, 'templates'))}/… 2 templates, 2 skills${BULK ? `, ${BULK} bulk templates` : ''}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.close(); server.closeAllConnections?.();
    await h.stop().catch(() => {});
    if (certDir) rmSync(certDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
