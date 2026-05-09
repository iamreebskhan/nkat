/**
 * Pure invite-token primitives. Pure because the security analysis lives
 * here — every operation is unit-testable without DB or network.
 *
 *   generateToken()         → { raw, prefix, hash }
 *   parseToken(raw)         → { prefix, hash }   (used at redeem time)
 *   constantTimeEqual(a, b) → boolean             (timingSafeEqual wrapper)
 *
 * Token shape:
 *   - 32 bytes of cryptographic randomness (256 bits).
 *   - Rendered base64url (43 chars, no padding) for URL embedding.
 *   - Storage: 64-char hex SHA-256 hash + 12-char raw-prefix index
 *     (the prefix is non-secret on its own — we still constant-time
 *     compare the hash to authenticate).
 *
 * Why both prefix + hash:
 *   - We need a fast index hit at redeem time (millions of invites
 *     in flight is plausible at scale).
 *   - We need defense against timing attacks against the hash.
 *   - Storing only the hash means O(table-scan) at lookup — bad.
 *   - Storing the raw token means stolen DB → free auth — VERY bad.
 *   - 12 base64url chars = ~72 bits of entropy → effectively unique
 *     across any reasonable concurrent invite set.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const RAW_TOKEN_BYTES = 32;
export const PREFIX_CHARS = 12;

export interface GeneratedToken {
  raw: string; // base64url, ~43 chars, NEVER stored
  prefix: string; // first PREFIX_CHARS of raw — stored for index
  hash: string; // 64 hex chars of sha256(raw) — stored for compare
}

/**
 * Cryptographically random invite token. The `raw` value is the only
 * secret in the system; it MUST be transmitted out-of-band exactly once
 * (in the magic-link URL) and never persisted server-side.
 */
export function generateToken(): GeneratedToken {
  const buf = randomBytes(RAW_TOKEN_BYTES);
  const raw = buf.toString('base64url');
  return {
    raw,
    prefix: raw.slice(0, PREFIX_CHARS),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
}

/**
 * Parse a redemption-time raw token into the lookup prefix + the hash
 * we'll compare against the DB row. Returns null on malformed input
 * (too short, wrong charset, etc) — caller MUST treat null as "invalid"
 * indistinguishably from "no row found" to avoid leaking which kind of
 * failure occurred to a probing attacker.
 */
export function parseToken(raw: string): { prefix: string; hash: string } | null {
  if (typeof raw !== 'string' || raw.length < PREFIX_CHARS) return null;
  // base64url charset: A-Z, a-z, 0-9, -, _
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return {
    prefix: raw.slice(0, PREFIX_CHARS),
    hash: createHash('sha256').update(raw).digest('hex'),
  };
}

/** Constant-time string compare. Returns false on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Default invite TTL — 7 days from issue. Past this, the redeem path
 * returns the same opaque "invalid token" error to avoid leaking expiry
 * vs revocation vs nonexistence.
 */
export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

/** Returns expiresAt = now + ttlMs (default 7 days). */
export function expiryFromNow(nowMs: number = Date.now(), ttlMs: number = DEFAULT_TTL_MS): Date {
  return new Date(nowMs + ttlMs);
}
