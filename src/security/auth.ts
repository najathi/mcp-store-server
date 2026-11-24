import { createHash, timingSafeEqual } from 'node:crypto';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ApiTokenConfig, Scope } from '../config.js';
import { SCOPES } from '../config.js';

/** The authenticated caller of a tool. */
export interface Principal {
  name: string;
  scopes: Scope[];
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Verifies static bearer API tokens from configuration.
 *
 * It implements the SDK's `OAuthTokenVerifier` interface, so the HTTP transport uses the
 * SDK's own `requireBearerAuth` middleware. Moving to OAuth 2.1 means swapping this class
 * for a verifier that validates JWTs or calls a token-introspection endpoint; the tools
 * and scope checks stay the same.
 */
export class StaticTokenVerifier implements OAuthTokenVerifier {
  private readonly entries: { name: string; digest: Buffer; scopes: Scope[] }[];

  constructor(tokens: ApiTokenConfig[]) {
    this.entries = tokens.map((t) => ({ name: t.name, digest: sha256(t.token), scopes: t.scopes }));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const digest = sha256(token);
    // Compare against every entry in constant time so timing does not reveal a near match.
    let match: (typeof this.entries)[number] | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, digest)) match = entry;
    }
    if (!match) throw new InvalidTokenError('Invalid or unknown API token');

    return {
      token,
      clientId: match.name,
      scopes: [...match.scopes],
      // Static tokens do not expire; the SDK middleware still requires an expiry.
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
}

/** Turns the SDK's per-request AuthInfo into a Principal, ignoring unknown scopes. */
export function principalFromAuthInfo(auth: AuthInfo): Principal {
  const scopes = auth.scopes.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return { name: auth.clientId, scopes };
}
