// The server API process: the sync API (/v1/*, devices) and the admin API (/admin/*).
// Tailnet-only until the public endpoint (TLS) exists:
//   AO_API_BIND (default 127.0.0.1), AO_API_PORT (8787)
//   PG_HOST / PG_PORT / PG_DATABASE + AO_READONLY_PASSWORD + AO_ADMIN_PASSWORD
//   AO_ADMIN_TOKENS=name:token[,name:token]   (until Clerk admin sign-in is wired)
//   MINIO_ENDPOINT + MINIO_ROOT_USER + MINIO_ROOT_PASSWORD   (backup status, blob deletion)
//   CLERK_SECRET_KEY   (optional: force sign-out revokes Clerk sessions)
//   CLERK_PUBLISHABLE_KEY + AO_APP_PASSWORD   (the sync API /v1/*, and Clerk sign-in for admins)
//   CLERK_AUTHORIZED_PARTIES=origin[,origin]   (optional azp allow-list)
//   KEYCLOAK_API_SECRET (+ KEYCLOAK_ADMIN_URL, KEYCLOAK_API_CLIENT_ID)   (the admin console reads and updates Keycloak with the `ao-api` client)
//   KEYCLOAK_ISSUER (+ KEYCLOAK_JWKS_URL, KEYCLOAK_CLIENT_IDS)   (Keycloak: the identity service; when set, the app is sent there to sign in)
//   AUTH_ISSUER (public base URL of services/control-plane) [+ AUTH_AUDIENCE, AUTH_JWKS_URL] + AO_APP_PASSWORD   (our own sign-in: the sync API /v1/*)
//   AO_PRICING (JSON, credits per 1,000 tokens per model) + AO_UPSTREAM_URL + AO_UPSTREAM_KEY   (managed inference)
import { accessSync, constants as fsConstants } from 'node:fs';
import { createServer } from 'node:http';
import pg from 'pg';
import { adminHandler, authenticate as adminAuthenticate, parseTokens } from './admin.ts';
import { ClerkVerifier } from '../auth/clerk.ts';
import { JwksVerifier } from '../auth/jwks.ts';
import { httpStreamUpstream, httpUpstream, parsePricing } from './inference.ts';
import { S3 } from './s3.ts';
import { keycloakAdminFromEnv } from './keycloak-admin.ts';
import { PaymentsService } from './payments/service.ts';
import { youpiFromEnv } from './payments/youpi.ts';
import { mailerFromEnv } from './mailer.ts';
import { syncHandler } from './sync.ts';
import { cors, parseOrigins } from './cors.ts';
import { sweepGuardrails } from '../growth/admin.ts';
import { emailConfigFromEnv } from '../growth/email.ts';
import { growthPublicHandler } from '../growth/public.ts';
import { marketplaceHandler } from './marketplace.ts';
import { registerSkillPipeline } from '../marketplace/verify/stages/skill/index.ts';
import '../marketplace/verify/stages/template/index.ts'; // registers the template verification pipeline (Plan 4 Task 3)
import type { PipelineTools } from '../marketplace/verify/types.ts';
import { marketplaceTeamsHandler } from './marketplace-teams.ts';
import { createAgentBridge, createAgentRuntime } from '../marketplace/agents.ts';
import { parseRoleMap } from '../marketplace/permissions.ts';
import { marketplaceAdminHandler } from './marketplace-admin.ts';
import { s3ArtifactStore } from '../marketplace/artifacts.ts';
import { registerValidator } from '../marketplace/validate/index.ts';
import { createSkillValidator } from '../marketplace/validate/skill.ts';
import { createSkillsGuardScanner } from '../marketplace/validate/skillsGuard.ts';
import { createRoutineValidator } from '../marketplace/validate/routine.ts';
import { createTemplateValidator } from '../marketplace/validate/template.ts';
import { createDagPlanChecker, createWorkflowValidator } from '../marketplace/validate/workflow.ts';
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
// Payments: off unless AO_PAYMENTS names a provider and its settings exist. The provider is EXPERIMENTAL (see payments/youpi.ts). It runs as ao_billing,
// the role that can write payment records and nothing else; settling an order stays with the admin API.
const youpi = youpiFromEnv(env);
const payments = youpi && env.AO_BILLING_PASSWORD ? new PaymentsService({ pool: pool('ao_billing', env.AO_BILLING_PASSWORD), provider: youpi, returnUrl: env.AO_CHECKOUT_RETURN_URL || undefined }) : undefined;
if (env.AO_PAYMENTS && !payments) console.warn('AO_PAYMENTS is set but the provider settings or AO_BILLING_PASSWORD are missing: payments stay off.');
if (payments) setInterval(() => { void payments.expireStale().catch(() => undefined); }, 60_000).unref();
const deps = {
  payments,
  mailer: mailerFromEnv(env),
  keycloak: keycloakAdminFromEnv(env),
  ro: pool('ao_readonly', need('AO_READONLY_PASSWORD')),
  admin: pool('ao_admin', need('AO_ADMIN_PASSWORD')),
  tokens: parseTokens(env.AO_ADMIN_TOKENS),
  s3,
  clerkSecret: env.CLERK_SECRET_KEY || undefined,
  verifyClerk: clerk ? (t: string) => clerk.verify(t) : undefined,
  email: emailConfigFromEnv(env),
};
if (!deps.tokens.size && !clerk) { console.error('Set AO_ADMIN_TOKENS or CLERK_PUBLISHABLE_KEY: admins need a way to sign in'); process.exit(2); }
const pricing = parsePricing(env.AO_PRICING);
const upstream = env.AO_UPSTREAM_URL && env.AO_UPSTREAM_KEY ? httpUpstream(env.AO_UPSTREAM_URL, env.AO_UPSTREAM_KEY) : undefined;
const streamUpstream = env.AO_UPSTREAM_URL && env.AO_UPSTREAM_KEY ? httpStreamUpstream(env.AO_UPSTREAM_URL, env.AO_UPSTREAM_KEY) : undefined;
const authIssuer = env.AUTH_ISSUER?.replace(/\/+$/, '');
const authClient = env.AUTH_AUDIENCE ?? 'agentic-office-desktop';
const idVerifier = authIssuer ? new JwksVerifier({ issuer: authIssuer, audience: authClient, jwksUrl: env.AUTH_JWKS_URL ?? `${authIssuer}/api/auth/jwks` }) : undefined;
const oauth = authIssuer ? { issuer: authIssuer, authorization_endpoint: `${authIssuer}/api/auth/oauth2/authorize`, token_endpoint: `${authIssuer}/api/auth/oauth2/token`, client_id: authClient } : undefined;
// Keycloak (the identity service): KEYCLOAK_ISSUER is the realm URL exactly as it appears in tokens; KEYCLOAK_JWKS_URL is where this server fetches its keys (it may be an internal address).
const kcIssuer = env.KEYCLOAK_ISSUER?.replace(/\/+$/, '');
// The desktop app signs in as `agentic-office-desktop` and the admin console as `ao-admin-console`; tokens for either are accepted here.
const kcClients = (env.KEYCLOAK_CLIENT_IDS || 'agentic-office-desktop,ao-admin-console').split(',').map((x) => x.trim()).filter(Boolean);
const kcClient = kcClients[0];
const keycloak = kcIssuer ? { issuer: kcIssuer, verify: (() => { const v = new JwksVerifier({ issuer: kcIssuer, audience: kcClients, jwksUrl: env.KEYCLOAK_JWKS_URL || `${kcIssuer}/protocol/openid-connect/certs`, algs: ['RS256', 'ES256'] }); return (t: string) => v.verify(t); })() } : undefined;
const kcOauth = kcIssuer ? { issuer: kcIssuer, authorization_endpoint: `${kcIssuer}/protocol/openid-connect/auth`, token_endpoint: `${kcIssuer}/protocol/openid-connect/token`, client_id: kcClient } : undefined;
const app = (clerk || idVerifier || keycloak) && env.AO_APP_PASSWORD ? pool('ao_app', env.AO_APP_PASSWORD) : undefined;
const sync = app ? syncHandler({ app, verify: clerk ? (t) => clerk.verify(t) : undefined, verifyIdToken: idVerifier ? (t) => idVerifier.verify(t) : undefined, keycloak, keycloakAdmin: deps.keycloak, payments, oauth: kcOauth ?? oauth, s3, mediaKey: env.AO_MEDIA_SIGNING_KEY ? Buffer.from(env.AO_MEDIA_SIGNING_KEY) : undefined, pricing, upstream, streamUpstream, publishableKey: env.CLERK_PUBLISHABLE_KEY,
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
// Verification pipelines (Plan 4). The skill pipeline's scan stage and the creator's gated auto-publish use the same Skills Guard scanner.
registerSkillPipeline();
const verifyTools: PipelineTools = { scanner: createSkillsGuardScanner() };
// Agents and bundles: the REAL compiler bridge (python3 -m agent.office.blueprint.cli) and the persona scanner, proven at startup by
// compiling and scanning a built-in agent. Until that passes (and while it fails), agent/bundle uploads answer 503 compiler_unavailable
// and GET /v1/marketplace/capabilities says they are unsupported; browse and install of everything else is unaffected.
const hermesPython = env.HERMES_PYTHON || 'python3';
const marketplaceStore = s3 ? s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace') : undefined;
const agents = createAgentRuntime({ bridge: createAgentBridge({ python: hermesPython, store: marketplaceStore }), scanner: (() => { try { return createSkillsGuardScanner({ python: hermesPython }); } catch { return undefined; } })() });
agents.register();
const agentsOk = () => agents.ok();
// Team assignments, install policy, install-time re-resolution and bundle plans (before `marketplace`, whose catch-all answers 404).
const marketplaceTeams = sync && app && marketplaceStore ? marketplaceTeamsHandler({ app, authenticate: sync.authenticate, store: marketplaceStore }) : undefined;
const marketplace = sync && app && s3 ? marketplaceHandler({ app, admin: deps.admin, authenticate: sync.authenticate, store: s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace'), scannerOk, verifyTools, agentsOk, verifyMode: env.AO_VERIFY_MODE === 'queue' ? 'queue' : 'inline' }) : undefined;
const admin = adminHandler(deps);
// Marketplace publishing runs the REAL scanner (skills guard) and, when OFFICECLI_BIN is set, the officecli render check.
// Without them the reports are unverified and the admin API refuses to approve (scan_required): never silently trusted.
try { registerValidator('skill', createSkillValidator({ scanner: createSkillsGuardScanner() })); } catch (e) { console.error('marketplace: skill scanner unavailable, skill submissions stay unverified:', (e as Error).message); }
// Routines: the prompt text goes through the same scanner; without it a routine report stays unverified and the admin API refuses to approve it.
try { registerValidator('routine', createRoutineValidator({ scanner: createSkillsGuardScanner() })); } catch (e) { console.error('marketplace: routine prompt scanner unavailable, routine submissions stay unverified:', (e as Error).message); }
// Workflows: the plan is parsed and compiled by the DAG runtime's own code (validate-plan CLI) and agent text goes through the scanner; without either the report stays unverified.
try { registerValidator('workflow', createWorkflowValidator({ planChecker: createDagPlanChecker(), scanner: createSkillsGuardScanner() })); } catch (e) { console.error('marketplace: workflow checks unavailable, workflow submissions stay unverified:', (e as Error).message); }
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
const marketplaceAdmin = s3 ? marketplaceAdminHandler({ admin: deps.admin, authenticate: (req) => adminAuthenticate(req, deps), roleOf: (id) => marketplaceRoles.get(id) ?? 'analyst', store: s3ArtifactStore(s3, env.AO_MARKETPLACE_BUCKET ?? 'ao-marketplace'), scannerOk, verifyTools, agentsOk }) : undefined;
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
const allowCors = cors(parseOrigins(env.AO_CORS_ORIGINS));
const growthPublic = growthPublicHandler({ admin: deps.admin, email: deps.email });
const server = createServer(async (req, res) => {
  if (allowCors(req, res)) return;
  if (await growthPublic(req, res)) return;
  if (marketplaceTeams && (await marketplaceTeams(req, res))) return;
  if (marketplace && (await marketplace(req, res))) return;   // before sync, whose /v1 catch-all answers 404
  if (sync && (await sync(req, res))) return;
  if (!sync && req.url?.startsWith('/v1/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign-in is not configured on this server yet (CLERK_PUBLISHABLE_KEY).' })); return; }
  if (marketplaceAdmin && (await marketplaceAdmin(req, res))) return;
  await admin(req, res);
});
// Growth guardrails: a live promotion people dismiss too often is paused automatically (src/growth/admin.ts).
setInterval(() => { sweepGuardrails(deps).then((p) => p.length && console.log(`guardrails paused ${p.join(', ')}`)).catch((e) => console.error('guardrail sweep failed:', e.message)); }, 10 * 60_000).unref();
server.listen(port, bind, () => console.log(`admin API on http://${bind}:${port} (${deps.tokens.size} admin token(s), blobs ${deps.s3 ? 'on' : 'off'}, sign-in ${[clerk && 'Clerk', idVerifier && 'ours'].filter(Boolean).join('+') || 'tokens only'}, sync ${sync ? 'on' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => Promise.all([deps.ro.end(), deps.admin.end(), app?.end()]).then(() => process.exit(0))));
