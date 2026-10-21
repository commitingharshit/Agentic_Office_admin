// Sign-in for Agentic Office. Better Auth owns who a person is (Google, Microsoft, email); this app is
// also the OAuth 2.1 / OIDC provider the desktop app signs in through (system browser, authorization
// code + PKCE, loopback redirect). The desktop then swaps the ID token it receives for its own
// device token at accounts-sync (`POST /v1/auth/exchange`), so per-device revocation stays where it is.
//
// Only the user table is shared with accounts-sync (`users`, mapped below) so every existing usr_ id and
// the data under it survive; Better Auth's other tables are the auth_* tables from migration 0006
// and the oauth_* / jwks tables from migration 0009.
import { oauthProvider } from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt, twoFactor } from 'better-auth/plugins';
import pg from 'pg';
import { userId } from './ids';

export const DESKTOP_CLIENT_ID = 'agentic-office-desktop';

const env = process.env;
const must = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is not set`); return v; };

export function createAuth(opts: { pool?: pg.Pool; baseURL?: string; secret?: string } = {}) {
  const baseURL = opts.baseURL ?? must('AUTH_BASE_URL');
  const pool = opts.pool ?? new pg.Pool({ connectionString: must('AUTH_DATABASE_URL'), max: 10 });
  const social: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) social.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) social.microsoft = { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, tenantId: env.MICROSOFT_TENANT_ID ?? 'common' };

  return betterAuth({
    baseURL,
    secret: opts.secret ?? must('AUTH_SECRET'),
    database: pool,
    // The people table is accounts-sync's `users`: keep its names and its usr_<ulid> ids.
    user: {
      modelName: 'users',
      fields: { name: 'display_name', image: 'avatar_url', emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'user', input: false },
        status: { type: 'string', required: false, defaultValue: 'active', input: false },
      },
    },
    session: {
      modelName: 'auth_sessions',
      additionalFields: { adminMfaVerified: { type: 'boolean', required: false, defaultValue: false, input: false } },
      fields: { userId: 'user_id', expiresAt: 'expires_at', ipAddress: 'ip_address', userAgent: 'user_agent', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        userId: 'user_id', accountId: 'account_id', providerId: 'provider_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at',
      },
      // A person who signed in with Clerk before keeps their usr_ id: the first Google or Microsoft sign-in
      // with the same verified email links to the existing row instead of creating a second one.
      accountLinking: { enabled: true, trustedProviders: ['google', 'microsoft'] },
    },
    verification: { modelName: 'auth_verifications', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    emailAndPassword: { enabled: true, minPasswordLength: 10, maxPasswordLength: 128, requireEmailVerification: false },
    socialProviders: social,
    advanced: {
      // Rate limits (on by default in production) key on the real client address. Behind the tunnel that is the header the
      // tunnel sets and a client cannot forge; never trust a header the open internet can write.
      ipAddress: { ipAddressHeaders: [env.AUTH_IP_HEADER ?? 'cf-connecting-ip'] },
      database: { generateId: (o: { model: string }) => (o.model === 'user' || o.model === 'users' ? userId() : crypto.randomUUID()) },
    },
    // A disabled or deleted account gets no new browser session (the admin API also ends the ones it has).
    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            const r = await pool.query('SELECT status FROM users WHERE id = $1', [session.userId]);
            if (r.rows[0] && r.rows[0].status !== 'active') throw new APIError('FORBIDDEN', { message: 'This account is disabled. Contact the administrator.' });
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!['/two-factor/enable', '/two-factor/disable'].includes(ctx.path)) return;
        const session = await ctx.context.internalAdapter.findSession((await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)) || '');
        if (session) await pool.query('UPDATE auth_sessions SET "adminMfaVerified" = false WHERE user_id = $1', [session.user.id]);
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Only a successful TOTP verification can bless this specific session. Enrollment alone,
        // social sign-in and other existing sessions never confer administrator access.
        if (ctx.path !== '/two-factor/verify-totp') return;
        const result = ctx.context.returned as { token?: string } | undefined;
        if (typeof result?.token !== 'string') return;
        const token = ctx.context.newSession?.session.token ?? result.token;
        await pool.query('UPDATE auth_sessions SET "adminMfaVerified" = true WHERE token = $1', [token]);
      }),
    },
    // jwt() also exposes /token; the OAuth provider's /oauth2/token is the only token endpoint here.
    disabledPaths: ['/token'],
    plugins: [
      twoFactor({ issuer: 'Agentic Office' }),
      jwt({ jwt: { issuer: baseURL, audience: baseURL } }),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        // The desktop app is first-party: it is seeded by migration, never self-registered, and needs no consent screen.
        cachedTrustedClients: new Set([DESKTOP_CLIENT_ID]),
        allowDynamicClientRegistration: false,
        // The ID token carries the profile the granted scopes allow, so accounts-sync can keep its copy current.
        customIdTokenClaims: ({ user, scopes }: { user: Record<string, unknown>; scopes: Iterable<string> }) => {
          const granted = new Set(Array.from(scopes));
          return {
            ...(granted.has('email') ? { email: user.email, email_verified: user.emailVerified === true } : {}),
            ...(granted.has('profile') ? { name: user.name, picture: user.image ?? undefined } : {}),
          };
        },
        accessTokenExpiresIn: 15 * 60,
        idTokenExpiresIn: 10 * 60,
        refreshTokenExpiresIn: 30 * 24 * 3600,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
