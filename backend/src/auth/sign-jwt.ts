/**
 * RS256 JWT signer — pairs with the existing `verifyJwt` (jwt-verifier.ts).
 *
 * Used by `AuthController.ssoCallback` to mint a session token after
 * the OIDC code-exchange succeeds. Pure stdlib — no jsonwebtoken
 * dependency. Shape matches what the AuthGuard's jwt-mode expects
 * (iss, aud, sub, org_id, role, exp, iat).
 *
 * The private key is provided by the operator via env
 * `SESSION_SIGNING_PRIVATE_KEY` (PEM). The corresponding public key
 * goes into `JWT_PUBLIC_KEY` so AuthGuard can verify what we sign.
 *
 * In production both come from Secrets Manager. In dev the operator
 * generates a pair with:
 *   node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('rsa',{modulusLength:2048});console.log('PRIVATE:\\n'+privateKey.export({type:'pkcs8',format:'pem'}));console.log('PUBLIC:\\n'+publicKey.export({type:'spki',format:'pem'}))"
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export interface SessionClaims {
  sub: string;        // userId
  org_id: string;
  role: string;
  iss: string;
  aud: string;
  /** Lifetime in seconds. */
  ttlSec: number;
}

export class JwtSigningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'JwtSigningError';
  }
}

/**
 * Parse a PEM-encoded RSA private key. Throws JwtSigningError so the
 * caller can return a clean 503 instead of a stack trace.
 */
export function parsePrivateKey(pem: string): KeyObject {
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) {
    throw new JwtSigningError('NO_PRIVATE_KEY', 'SESSION_SIGNING_PRIVATE_KEY is missing or not a PEM');
  }
  try {
    return createPrivateKey({ key: pem, format: 'pem' });
  } catch (e) {
    throw new JwtSigningError(
      'BAD_PRIVATE_KEY',
      `cannot parse SESSION_SIGNING_PRIVATE_KEY: ${(e as Error).message}`,
    );
  }
}

/**
 * Sign a JWT (RS256). Returns the compact-serialized
 * `header.payload.signature` string ready for `Authorization: Bearer`.
 *
 * Pure: deterministic given (claims, key, nowSec).
 */
export function signJwt(args: {
  claims: SessionClaims;
  privateKey: KeyObject;
  /** Optional kid header, useful when JWKS rotates. */
  kid?: string;
  /** Override clock for tests. Defaults to current second. */
  nowSec?: number;
}): string {
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
  if (args.kid) header.kid = args.kid;
  const payload = {
    iss: args.claims.iss,
    aud: args.claims.aud,
    sub: args.claims.sub,
    org_id: args.claims.org_id,
    role: args.claims.role,
    iat: now,
    exp: now + args.claims.ttlSec,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(args.privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
