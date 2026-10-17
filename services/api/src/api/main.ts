// The server API process: the sync API (/v1/*, devices) and the admin API (/admin/*).
// Tailnet-only until the public endpoint (TLS) exists:
//   AO_API_BIND (default 127.0.0.1), AO_API_PORT (8787)
//   PG_HOST / PG_PORT / PG_DATABASE + AO_READONLY_PASSWORD + AO_ADMIN_PASSWORD
//   AO_ADMIN_TOKENS=name:token[,name:token]   (until Clerk admin sign-in is wired)
//   MINIO_ENDPOINT + MINIO_ROOT_USER + MINIO_ROOT_PASSWORD   (backup status, blob deletion)
//   CLERK_SECRET_KEY   (optional: force sign-out revokes Clerk sessions)
//   CLERK_PUBLISHABLE_KEY + AO_APP_PASSWORD   (the sync API /v1/*, and Clerk sign-in for admins)
//   CLERK_AUTHORIZED_PARTIES=origin[,origin]   (optional azp allow-list)
import { createServer } from 'node:http';
import pg from 'pg';
import { adminHandler, parseTokens } from './admin.ts';
import { ClerkVerifier } from '../auth/clerk.ts';
import { S3 } from './s3.ts';
import { syncHandler } from './sync.ts';

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
const admin = adminHandler(deps);

const bind = env.AO_API_BIND ?? '127.0.0.1';
const port = Number(env.AO_API_PORT ?? 8787);
const server = createServer(async (req, res) => {
  if (sync && (await sync(req, res))) return;
  if (!sync && req.url?.startsWith('/v1/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Sign-in is not configured on this server yet (CLERK_PUBLISHABLE_KEY).' })); return; }
  await admin(req, res);
});
server.listen(port, bind, () => console.log(`admin API on http://${bind}:${port} (${deps.tokens.size} admin token(s), blobs ${deps.s3 ? 'on' : 'off'}, sign-in ${clerk ? 'Clerk' : 'tokens only'}, sync ${sync ? 'on' : 'off'})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => Promise.all([deps.ro.end(), deps.admin.end(), app?.end()]).then(() => process.exit(0))));
