import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { CloudError } from './errors.ts';
export interface AccountIdentity {issuer: string; subject: string}
export type AccountVerifier = (token: string) => Promise<AccountIdentity>;
export interface ManagedAuthConfig {issuer?: string; audience?: string; jwksUrl?: string}
/** Generic managed-provider configuration, including providers such as Supabase. No provisioning. */
export function createAccountVerifier(config: ManagedAuthConfig, key?: JWTVerifyGetKey): AccountVerifier {
  let keys: JWTVerifyGetKey | undefined;
  if (config.issuer && config.audience && config.jwksUrl) {
    try {
      const url = new URL(config.jwksUrl);
      if (url.protocol === 'https:') keys = key ?? createRemoteJWKSet(url);
    } catch { /* Missing/invalid configuration fails closed at request time. */ }
  }
  return async token => {
    if (!keys) throw new CloudError(503, 'AUTH_NOT_CONFIGURED', 'Managed account authentication is not configured');
    try {
      const {payload} = await jwtVerify(token, keys, {issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['sub', 'exp', 'iat']});
      if (!payload.sub || payload.is_anonymous === true || payload.role === 'anon' || payload.role === 'service_role' || payload.sub.length > 512) throw new Error('Invalid account');
      return {issuer: payload.iss!, subject: payload.sub};
    } catch {
      throw new CloudError(401, 'UNAUTHORIZED', 'A valid non-anonymous account token is required');
    }
  };
}
export function bearer(header: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  if (!match) throw new CloudError(401, 'UNAUTHORIZED', 'Bearer authentication is required');
  return match[1]!;
}
