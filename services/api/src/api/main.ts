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
import { createServer } from 'node:http';
import pg from 'pg';
import { adminHandler, parseTokens } from './admin.ts';
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
const admin = adminHandler(deps);

const bind = env.AO_API_BIND ?? '127.0.0.1';
const port = Number(env.AO_API_PORT ?? 8787);
const allowCors = cors(parseOrigins(env.AO_CORS_ORIGINS));
const server = createServer(async (req, res) => {
  if (allowCors(req, res)) return;
  if (sync && (await sync(req, res))) return;
  if (!sync && req.url?.startsWith('/v1/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign-in is not configured on this server yet (CLERK_PUBLISHABLE_KEY).' })); return; }
  await admin(req, res);
});
// Growth guardrails: a live promotion people dismiss too often is paused automatically (src/growth/admin.ts).
setInterval(() => { sweepGuardrails(deps).then((p) => p.length && console.log(`guardrails paused ${p.join(', ')}`)).catch((e) => console.error('guardrail sweep failed:', e.message)); }, 10 * 60_000).unref();
server.listen(port, bind, () => console.log(`admin API on http://${bind}:${port} (${deps.tokens.size} admin token(s), blobs ${deps.s3 ? 'on' : 'off'}, sign-in ${[clerk && 'Clerk', idVerifier && 'ours'].filter(Boolean).join('+') || 'tokens only'}, sync ${sync ? 'on' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => Promise.all([deps.ro.end(), deps.admin.end(), app?.end()]).then(() => process.exit(0))));
