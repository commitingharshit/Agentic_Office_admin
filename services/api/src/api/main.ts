// The server API process: the sync API (/v1/*, devices) and the admin API (/admin/*).
// Tailnet-only until the public endpoint (TLS) exists:
//   AO_API_BIND (default 127.0.0.1), AO_API_PORT (8787)
//   PG_HOST / PG_PORT / PG_DATABASE + AO_READONLY_PASSWORD + AO_ADMIN_PASSWORD
//   AO_ADMIN_TOKENS=name:token[,name:token]   (until Clerk admin sign-in is wired)
//   MINIO_ENDPOINT + MINIO_ROOT_USER + MINIO_ROOT_PASSWORD   (backup status, blob deletion)
//   CLERK_SECRET_KEY   (optional: force sign-out revokes Clerk sessions)
//   CLERK_PUBLISHABLE_KEY + AO_APP_PASSWORD   (the sync API /v1/*, and Clerk sign-in for admins)
//   CLERK_AUTHORIZED_PARTIES=origin[,origin]   (optional azp allow-list)
import { accessSync, constants as fsConstants } from 'node:fs';
import { createServer } from 'node:http';
import pg from 'pg';
import { adminHandler, authenticate as adminAuthenticate, parseTokens } from './admin.ts';
import { ClerkVerifier } from '../auth/clerk.ts';
import { S3 } from './s3.ts';
import { marketplaceHandler } from './marketplace.ts';
import { marketplaceTeamsHandler } from './marketplace-teams.ts';
import { createAgentBridge, createAgentRuntime } from '../marketplace/agents.ts';
import { parseRoleMap } from '../marketplace/permissions.ts';
import { marketplaceAdminHandler } from './marketplace-admin.ts';
import { syncHandler } from './sync.ts';
import { s3ArtifactStore } from '../marketplace/artifacts.ts';
import { registerValidator } from '../marketplace/validate/index.ts';
import { createSkillValidator } from '../marketplace/validate/skill.ts';
import { createSkillsGuardScanner } from '../marketplace/validate/skillsGuard.ts';
import { createRoutineValidator } from '../marketplace/validate/routine.ts';
import { createTemplateValidator } from '../marketplace/validate/template.ts';
import { skillScannerSelfCheck } from '../marketplace/selfcheck.ts';
import { validateArtifact } from '../marketplace/validate/index.ts';
import { officecliRenderer } from '../marketplace/validate/officecli.ts';

const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2); } return v; };
const pool = (user: string, password: string) => new pg.Pool({
  host: env.PG_HOST ?? '127.0.0.1', port: Number(env.PG_PORT ?? 5432), database: env.PG_DATABASE ?? 'agentic_office',
  user, password, max: 5, idleTimeoutMillis: 30_000, application_name: `ao-admin-api:${user}`,
});

const parties = (env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// AO_TEST_CLERK_ISSUER + AO_TEST_CLERK_JWKS_URL: a fake Clerk for integration tests only; refused unless on loopback.
const testClerk = env.AO_TEST_CLERK_ISSUER && env.AO_TEST_CLERK_JWKS_URL && /^http:\/\/127\.0\.0\.1[:/]/.test(env.AO_TEST_CLERK_JWKS_URL)
  ? new ClerkVerifier({ issuer: env.AO_TEST_CLERK_ISSUER, jwksUrl: env.AO_TEST_CLERK_JWKS_URL, authorizedParties: parties }) : undefined;
const clerk = testClerk ?? (env.CLERK_PUBLISHABLE_KEY ? ClerkVerifier.fromPublishableKey(env.CLERK_PUBLISHABLE_KEY, parties) : undefined);
const s3 = env.MINIO_ENDPOINT ? new S3({ endpoint: env.MINIO_ENDPOINT, accessKey: need('MINIO_ROOT_USER'), secretKey: need('MINIO_ROOT_PASSWORD') }) : undefined;
const deps = {
  ro: pool('ao_readonly', need('AO_READONLY_PASSWORD')),
  admin: pool('ao_admin', need('AO_ADMIN_PASSWORD')),
  tokens: parseTokens(env.AO_ADMIN_TOKENS),
  s3,
  clerkSecret: env.CLERK_SECRET_KEY || undefined,
  verifyClerk: clerk ? (t: string) => clerk.verify(t) : undefined,
};
if (!deps.tokens.size && !clerk) { console.error('Set AO_ADMIN_TOKENS or CLERK_PUBLISHABLE_KEY: admins need a way to sign in'); process.exit(2); }
const app = clerk && env.AO_APP_PASSWORD ? pool('ao_app', env.AO_APP_PASSWORD) : undefined;
const sync = app && clerk ? syncHandler({ app, verify: (t) => clerk.verify(t), s3, publishableKey: env.CLERK_PUBLISHABLE_KEY,
  clerkIdentities: env.CLERK_SECRET_KEY ? async (sub) => {
    const r = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(sub)}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const u = (await r.json()) as { image_url?: string; has_image?: boolean; external_accounts?: Array<{ provider?: string; email_address?: string; image_url?: string; avatar_url?: string; verification?: { status?: string } }> };
    return (u.external_accounts ?? []).filter((x) => x.provider && x.verification?.status !== 'unverified')
      .map((x) => ({ provider: x.provider!, email: x.email_address ?? null, image: x.image_url || x.avatar_url || (u.has_image ? u.image_url : null) || null }));
  } : undefined }) : undefined;
// Eager scanner self-check: until it passes, skill uploads (creator and admin) answer 503 scanner_unavailable instead of storing rejected versions.
const scanner = { ok: false };
const scannerOk = () => scanner.ok;
// Agents and bundles: the REAL compiler bridge (python3 -m agent.office.blueprint.cli) and the persona scanner, proven at startup by
// compiling and scanning a built-in agent. Until that passes (and while it fails), agent/bundle uploads answer 503 compiler_unavailable
// and GET /v1/marketplace/capabilities says they are unsupported; browse and install of everything else is unaffected.
const hermesPython = env.HERMES_PYTHON || 'python3';
const marketplaceStore = s3 ? s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace') : undefined;
const agents = createAgentRuntime({ bridge: createAgentBridge({ python: hermesPython, store: marketplaceStore }), scanner: (() => { try { return createSkillsGuardScanner({ python: hermesPython }); } catch { return undefined; } })() });
agents.register();
const agentsOk = () => agents.ok();
const marketplace = sync && app && s3 ? marketplaceHandler({ app, admin: deps.admin, authenticate: sync.authenticate, store: s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace'), scannerOk, agentsOk }) : undefined;
// Team assignments, install policy, install-time re-resolution and bundle plans (before `marketplace`, whose catch-all answers 404).
const marketplaceTeams = sync && app && marketplaceStore ? marketplaceTeamsHandler({ app, authenticate: sync.authenticate, store: marketplaceStore }) : undefined;
const admin = adminHandler(deps);
// Marketplace publishing runs the REAL scanner (skills guard) and, when OFFICECLI_BIN is set, the officecli render check.
// Without them the reports are unverified and the admin API refuses to approve (scan_required): never silently trusted.
try { registerValidator('skill', createSkillValidator({ scanner: createSkillsGuardScanner() })); } catch (e) { console.error('marketplace: skill scanner unavailable, skill submissions stay unverified:', (e as Error).message); }
// Routines: the prompt text goes through the same scanner; without it a routine report stays unverified and the admin API refuses to approve it.
try { registerValidator('routine', createRoutineValidator({ scanner: createSkillsGuardScanner() })); } catch (e) { console.error('marketplace: routine prompt scanner unavailable, routine submissions stay unverified:', (e as Error).message); }
if (env.OFFICECLI_BIN) {
  try { accessSync(env.OFFICECLI_BIN, fsConstants.X_OK); registerValidator('template', createTemplateValidator({ officecli: officecliRenderer() })); }
  catch { console.error(`marketplace: OFFICECLI_BIN=${env.OFFICECLI_BIN} is not an executable file; templates cannot reach 'verified' until it is fixed.`); }
} else console.warn('marketplace: OFFICECLI_BIN is not set; template submissions cannot reach the verified state (no render check).');
if (s3) void skillScannerSelfCheck(validateArtifact).then((r) => {
  scanner.ok = r.ok;
  if (r.ok) console.log('marketplace: skill scanner self-check passed');
  else console.error(`marketplace: SKILL SCANNER SELF-CHECK FAILED, skill uploads are disabled (503 scanner_unavailable). It needs python3 on PATH and a vendor/hermes-agent checkout above the server's src/ directory (deploy/docker-compose.yml mounts it at /srv/vendor/hermes-agent; deploy/Dockerfile.marketplace adds python3). ${r.detail ?? ''}`);
});
// Roles fail closed: an admin not listed in AO_MARKETPLACE_ROLES (adminName:role[,..]; Clerk admins by email or user id) is an analyst, so without it the API is read-only.
let marketplaceRoles: ReturnType<typeof parseRoleMap>;
try { marketplaceRoles = parseRoleMap(env.AO_MARKETPLACE_ROLES); } catch (e) { console.error((e as Error).message); process.exit(2); }
const marketplaceAdmin = s3 ? marketplaceAdminHandler({ admin: deps.admin, authenticate: (req) => adminAuthenticate(req, deps), roleOf: (id) => marketplaceRoles.get(id) ?? 'analyst', store: s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace'), scannerOk, agentsOk }) : undefined;
// Startup self-check of the agent compiler; a failure is retried every minute so a late-starting dependency recovers without a restart.
if (s3) {
  const check = () => void agents.selfCheck().then((r) => {
    if (r.ok) console.log('marketplace: agent compiler self-check passed (agents and bundles are supported)');
    else {
      console.error(`marketplace: AGENT COMPILER SELF-CHECK FAILED, agent and bundle uploads are disabled (503 compiler_unavailable). It needs python3 (HERMES_PYTHON) and the vendored vendor/hermes-agent checkout. ${r.detail ?? ''}`);
      setTimeout(check, 60_000).unref();
    }
  });
  check();
}

const bind = env.AO_API_BIND ?? '127.0.0.1';
const port = Number(env.AO_API_PORT ?? 8787);
const server = createServer(async (req, res) => {
  if (marketplaceTeams && (await marketplaceTeams(req, res))) return;
  if (marketplace && (await marketplace(req, res))) return;   // before sync, whose /v1 catch-all answers 404
  if (sync && (await sync(req, res))) return;
  if (!sync && req.url?.startsWith('/v1/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign-in is not configured on this server yet (CLERK_PUBLISHABLE_KEY).' })); return; }
  if (marketplaceAdmin && (await marketplaceAdmin(req, res))) return;
  await admin(req, res);
});
server.listen(port, bind, () => console.log(`admin API on http://${bind}:${port} (${deps.tokens.size} admin token(s), blobs ${deps.s3 ? 'on' : 'off'}, sign-in ${clerk ? 'Clerk' : 'tokens only'}, sync ${sync ? 'on' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => Promise.all([deps.ro.end(), deps.admin.end(), app?.end()]).then(() => process.exit(0))));
