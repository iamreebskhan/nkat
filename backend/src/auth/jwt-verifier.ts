/**
 * JWT verifier — RS256 (and ES256) using Node's built-in `crypto`. No
 * external library. The verifier:
 *
 *   1. Splits the compact JWT into header + payload + signature.
 *   2. Validates `header.alg` against the allow-list.
 *   3. RSA / ECDSA verify against the public key (PEM string).
 *   4. Validates standard claims: `iss`, `aud`, `exp`, `nbf`.
 *   5. Returns the parsed claims OR throws JwtVerifyError with a code.
 *
 * Why our own (not jsonwebtoken / jose):
 *   - Pure stdlib. The IAM / SSO providers we'll use ship JWKS endpoints
 *     that we'll fetch separately; the verify step itself is ~80 lines.
 *   - Same opaque-error pattern as the rest of the auth surface — a
 *     probing attacker learns nothing about WHICH check failed.
 *
 * Algorithms supported:
 *   - RS256 — RSA-SHA256, the SSO default.
 *   - ES256 — ECDSA P-256 SHA-256, used by some IdPs (Auth0 EdDSA option).
 *
 * What we DON'T support:
 *   - HS256 — symmetric keys at the API layer are a security smell.
 *   - none — never. Trivially-spoofable; explicitly rejected.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  /** Custom claims preserved for downstream extraction. */
  [k: string]: unknown;
}

export interface JwtVerifyArgs {
  token: string;
  /**
   * Either:
   *  - a PEM string (a single static key — env-configured); or
   *  - a `KeyObject` already loaded (from JWKS); or
   *  - a `keyResolver(kid)` that returns the key for the token's kid
   *    (typical JWKS path — caller closes over a `JwksClient`).
   */
  publicKeyPem?: string;
  publicKey?: KeyObject;
  /**
   * Resolves a key by `kid`. Returns the key + the JWK's declared `alg`
   * (when the IdP shipped one). When `alg` is present, the verifier
   * cross-checks it against the JWT header's alg to stop
   * algorithm-confusion attacks (key intended for ES256, attacker forges
   * an HS256 token using the public key as a shared secret).
   */
  keyResolver?: (kid: string) => Promise<{ key: KeyObject; alg: string | undefined }>;
  expectedIssuer?: string;
  expectedAudience?: string;
  /** Override clock for tests; defaults to Date.now(). */
  nowMs?: number;
  /** Allowable clock skew in seconds for exp/nbf. Default 30. */
  clockSkewSec?: number;
}

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);

export class JwtVerifyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JwtVerifyError';
  }
}

export async function verifyJwt(args: JwtVerifyArgs): Promise<JwtClaims> {
  if (typeof args.token !== 'string') throw new JwtVerifyError('MALFORMED', 'token not a string');
  const parts = args.token.split('.');
  if (parts.length !== 3) throw new JwtVerifyError('MALFORMED', 'expected three segments');

  const [hB64, pB64, sigB64] = parts;
  const header = parseB64Json(hB64, 'header');
  const payload = parseB64Json(pB64, 'payload') as JwtClaims;

  const alg = (header as { alg?: string }).alg;
  if (typeof alg !== 'string' || !ALLOWED_ALGS.has(alg)) {
    throw new JwtVerifyError('ALG_NOT_ALLOWED', `disallowed alg: ${alg}`);
  }
  const kid = (header as { kid?: string }).kid;

  let pub: KeyObject;
  if (args.publicKey) {
    pub = args.publicKey;
  } else if (args.keyResolver) {
    if (!kid) {
      throw new JwtVerifyError('NO_KID', 'JWKS path requires header.kid');
    }
    let resolved: { key: KeyObject; alg: string | undefined };
    try {
      resolved = await args.keyResolver(kid);
    } catch (e) {
      throw new JwtVerifyError(
        'KEY_INVALID',
        `kid ${kid} not resolvable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Cross-check declared alg on the JWK against header.alg. If the
    // JWK declares one, it MUST match. Defends against an attacker
    // who steals an RSA key and forges a token claiming ES256 (or
    // vice versa). When the IdP doesn't declare alg, we fall through
    // — best-effort but the algorithm allow-list above still applies.
    if (resolved.alg && resolved.alg !== alg) {
      throw new JwtVerifyError(
        'ALG_KEY_MISMATCH',
        `JWT alg=${alg} but JWK alg=${resolved.alg} for kid=${kid}`,
      );
    }
    pub = resolved.key;
  } else if (args.publicKeyPem) {
    try {
      pub = createPublicKey(args.publicKeyPem);
    } catch (e) {
      throw new JwtVerifyError(
        'KEY_INVALID',
        `public key not parseable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else {
    throw new JwtVerifyError('KEY_INVALID', 'no key source supplied');
  }

  // Reconstruct what was signed.
  const signed = `${hB64}.${pB64}`;

  // Algorithm-specific verify path.
  if (alg === 'RS256') {
    const v = createVerify('RSA-SHA256');
    v.update(signed, 'utf8');
    const ok = v.verify(pub, sigB64, 'base64url');
    if (!ok) throw new JwtVerifyError('BAD_SIGNATURE', 'RS256 signature did not verify');
  } else if (alg === 'ES256') {
    // ECDSA signatures from JWT are concatenated R || S (raw); Node's
    // verify expects DER. Convert.
    const v = createVerify('SHA256');
    v.update(signed, 'utf8');
    const derSig = es256RawToDer(Buffer.from(sigB64, 'base64url'));
    const ok = v.verify({ key: pub, dsaEncoding: 'der' }, derSig);
    if (!ok) throw new JwtVerifyError('BAD_SIGNATURE', 'ES256 signature did not verify');
  }

  // Claim validation.
  const skew = args.clockSkewSec ?? 30;
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);

  if (typeof payload.exp === 'number' && payload.exp + skew < nowSec) {
    throw new JwtVerifyError('EXPIRED', 'exp passed');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - skew > nowSec) {
    throw new JwtVerifyError('NOT_YET_VALID', 'nbf in the future');
  }

  if (args.expectedIssuer && payload.iss !== args.expectedIssuer) {
    throw new JwtVerifyError(
      'ISSUER_MISMATCH',
      `iss=${payload.iss}, expected ${args.expectedIssuer}`,
    );
  }
  if (args.expectedAudience) {
    const aud = payload.aud;
    const matches =
      aud === args.expectedAudience || (Array.isArray(aud) && aud.includes(args.expectedAudience));
    if (!matches) {
      throw new JwtVerifyError(
        'AUDIENCE_MISMATCH',
        `aud=${JSON.stringify(aud)}, expected ${args.expectedAudience}`,
      );
    }
  }

  return payload;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function parseB64Json(b64url: string, scope: string): unknown {
  let json: string;
  try {
    json = Buffer.from(b64url, 'base64url').toString('utf8');
  } catch {
    throw new JwtVerifyError('MALFORMED', `${scope} not base64url`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new JwtVerifyError('MALFORMED', `${scope} not JSON`);
  }
}

/**
 * Convert a 64-byte JWS-style raw ECDSA signature (R||S, P-256) into the
 * ASN.1 DER form Node's crypto expects.
 */
function es256RawToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) {
    throw new JwtVerifyError(
      'BAD_SIGNATURE',
      `ES256 signature must be 64 bytes; got ${raw.length}`,
    );
  }
  const r = raw.subarray(0, 32);
  const s = raw.subarray(32);
  const rDer = encodeIntDer(r);
  const sDer = encodeIntDer(s);
  const seqLen = rDer.length + sDer.length;
  return Buffer.concat([Buffer.from([0x30, seqLen]), rDer, sDer]);
}

function encodeIntDer(buf: Buffer): Buffer {
  // Strip leading zeroes (but keep at least one byte).
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let value = buf.subarray(i);
  // If high bit set, prepend 0x00 to keep INTEGER positive.
  if ((value[0] & 0x80) !== 0) value = Buffer.concat([Buffer.from([0x00]), value]);
  return Buffer.concat([Buffer.from([0x02, value.length]), value]);
}
