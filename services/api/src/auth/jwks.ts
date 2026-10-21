// ID tokens from our own sign-in service (services/control-plane, Better Auth), verified with no SDK:
// the issuer's JWKS, EdDSA (Better Auth's default), RS256 or ES256. The service is the only issuer we trust,
// and a token must be addressed to the desktop app's client id.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { AuthError } from './clerk.ts';

export interface IdClaims {
  sub: string;                // our users.id (usr_<ulid>)
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [k: string]: unknown;
}

export interface JwksVerifierOptions {
  issuer: string;
  /** The client id a token must be addressed to. */
  audience: string | string[];
  jwksUrl: string;
  clockSkewS?: number;
  /** Algorithms accepted; never `none`, never HMAC. */
  algs?: Array<'EdDSA' | 'RS256' | 'ES256'>;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export class JwksVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastForced = 0;
  private inflight: Promise<void> | undefined;
  private readonly opts: JwksVerifierOptions;

  constructor(opts: JwksVerifierOptions) { this.opts = opts; }

  private async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.fetchedAt < 10 * 60_000 && this.keys.size) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const r = await fetch(this.opts.jwksUrl, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new AuthError(`could not fetch the sign-in keys (${r.status})`);
      const { keys } = (await r.json()) as { keys?: Array<Record<string, unknown> & { kid?: string; kty?: string }> };
      const next = new Map<string, KeyObject>();
      for (const k of keys ?? []) {
        if (!k.kid || !['OKP', 'RSA', 'EC'].includes(String(k.kty))) continue;
        try { next.set(k.kid, createPublicKey({ key: k as never, format: 'jwk' })); } catch { /* a key we cannot read is just not usable */ }
      }
      this.keys = next;
      this.fetchedAt = Date.now();
    })().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async verify(token: string): Promise<IdClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('not a sign-in token');
    let header: { alg?: string; kid?: string }, claims: IdClaims;
    try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { throw new AuthError('not a sign-in token'); }
    const allowed = this.opts.algs ?? ['EdDSA', 'RS256', 'ES256'];
    if (!header.alg || !(allowed as string[]).includes(header.alg) || !header.kid) throw new AuthError('unsupported token');
    await this.refresh();
    let key = this.keys.get(header.kid);
    if (!key && Date.now() - this.lastForced > 30_000) {      // a rotated key; but a flood of junk kids must not become a flood of fetches
      this.lastForced = Date.now();
      await this.refresh(true);
      key = this.keys.get(header.kid);
    }
    if (!key) throw new AuthError('token signed by an unknown key');
    // The key's own type must fit the algorithm: an RSA key can never "verify" an EdDSA token.
    const kt = key.asymmetricKeyType;
    const fits = (header.alg === 'EdDSA' && kt === 'ed25519') || (header.alg === 'RS256' && kt === 'rsa') || (header.alg === 'ES256' && kt === 'ec');
    if (!fits) throw new AuthError('unsupported token');
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = Buffer.from(parts[2], 'base64url');
    const ok = header.alg === 'EdDSA' ? cryptoVerify(null, data, key, sig)
      : header.alg === 'RS256' ? cryptoVerify('sha256', data, key, sig)
      : cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new AuthError('bad token signature');
    const now = Math.floor(Date.now() / 1000), skew = this.opts.clockSkewS ?? 5;
    if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new AuthError('session expired');
    if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new AuthError('session not yet valid');
    if (claims.iss !== this.opts.issuer) throw new AuthError('token from another sign-in service');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const want = Array.isArray(this.opts.audience) ? this.opts.audience : [this.opts.audience];
    if (!want.some((a) => aud.includes(a))) throw new AuthError('token issued to another app');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('token has no user');
    return claims;
  }
}
