// Clerk session tokens, verified with no Clerk SDK: RS256 against the instance's JWKS, which is
// found from the publishable key (pk_test_/pk_live_ + base64("<frontend-api-host>$")). Only the
// publishable key is needed to verify; the secret key is used elsewhere for admin actions.
//
// Claims we rely on (Clerk dashboard → Sessions → Customize session token):
//   { "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}",
//     "role": "{{user.public_metadata.role}}" }
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export class AuthError extends Error {}

export interface ClerkClaims {
  sub: string;           // Clerk user id
  sid?: string;          // session id
  iss: string;
  azp?: string;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  name?: string;
  role?: string;
  [k: string]: unknown;
}

export function frontendApiFromPublishableKey(pk: string): string {
  const m = /^pk_(test|live)_(.+)$/.exec(pk.trim());
  if (!m) throw new Error('CLERK_PUBLISHABLE_KEY must look like pk_test_… or pk_live_…');
  const host = Buffer.from(m[2], 'base64').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('CLERK_PUBLISHABLE_KEY does not decode to a host');
  return `https://${host}`;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export interface ClerkVerifierOptions {
  /** https://<frontend-api> (the token issuer). */
  issuer: string;
  /** Origins allowed in `azp` (the app's own origins). Empty = do not check azp. */
  authorizedParties?: string[];
  /** Override the JWKS URL (tests). */
  jwksUrl?: string;
  clockSkewS?: number;
}

export class ClerkVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | undefined;
  private readonly opts: ClerkVerifierOptions;

  constructor(opts: ClerkVerifierOptions) { this.opts = opts; }

  static fromPublishableKey(pk: string, authorizedParties: string[] = []) {
    return new ClerkVerifier({ issuer: frontendApiFromPublishableKey(pk), authorizedParties });
  }

  private async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < 10 * 60_000 && this.keys.size) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const r = await fetch(this.opts.jwksUrl ?? `${this.opts.issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new AuthError(`could not fetch the sign-in keys (${r.status})`);
      const { keys } = (await r.json()) as { keys: Array<{ kid: string; kty: string; n: string; e: string }> };
      const next = new Map<string, KeyObject>();
      for (const k of keys ?? []) if (k.kty === 'RSA' && k.kid) next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
      this.keys = next;
      this.fetchedAt = Date.now();
    })().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async verify(token: string): Promise<ClerkClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('not a session token');
    let header: { alg?: string; kid?: string }, claims: ClerkClaims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw new AuthError('not a session token'); }
    if (header.alg !== 'RS256' || !header.kid) throw new AuthError('unsupported token');
    await this.refresh();
    let key = this.keys.get(header.kid);
    if (!key) { await this.refresh(true); key = this.keys.get(header.kid); }   // key rotation
    if (!key) throw new AuthError('token signed by an unknown key');
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new AuthError('bad token signature');
    const now = Math.floor(Date.now() / 1000), skew = this.opts.clockSkewS ?? 5;
    if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new AuthError('session expired');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new AuthError('session not yet valid');
    if (claims.iss !== this.opts.issuer) throw new AuthError('token from another sign-in service');
    const azp = this.opts.authorizedParties ?? [];
    if (azp.length && claims.azp && !azp.includes(claims.azp)) throw new AuthError('token issued to another app');
    if (!claims.sub) throw new AuthError('token has no user');
    return claims;
  }
}
