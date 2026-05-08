/**
 * Unsubscribe-link signer / verifier — pure HMAC-SHA256, compact format.
 *
 *   Token = base64url(payloadJson) + "." + base64url(hmac(secret, payload))
 *
 * Why not real JWT:
 *   - We need ONE claim shape (`{ email, scope, exp }`) and one
 *     algorithm (HMAC-SHA256). Carrying a `header` JSON is dead weight.
 *   - Pure functions: 50 lines, zero dependencies, deterministic.
 *
 * Token lifetime: 90 days. Long enough that an email opened in a
 * customer's archive months later still works; short enough that a
 * leaked old token can't be used indefinitely.
 *
 * Replay safety: there's no nonce — a leaked token CAN be replayed.
 * That's the threat model trade-off for one-click unsubscribe: the
 * worst-case action is suppressing an address (which the customer can
 * un-suppress via admin support). No PHI, no money, no auth bypass.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TTL_MS = 90 * 24 * 3600 * 1000;

export interface UnsubscribePayload {
  /** Lower-cased recipient email address. */
  email: string;
  /** What this token authorizes. Today only `manual_optout`. */
  scope: 'manual_optout';
  /** Unix seconds expiry. */
  exp: number;
}

export function signUnsubscribeToken(args: {
  payload: Omit<UnsubscribePayload, 'exp'> & { exp?: number };
  secret: string;
  nowMs?: number;
  ttlMs?: number;
}): string {
  const now = args.nowMs ?? Date.now();
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS;
  const exp = args.payload.exp ?? Math.floor((now + ttl) / 1000);
  const full: UnsubscribePayload = {
    email: args.payload.email.toLowerCase(),
    scope: args.payload.scope,
    exp,
  };
  const json = JSON.stringify(full);
  const payloadB64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = hmacB64(args.secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; payload: UnsubscribePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_scope' };

export function verifyUnsubscribeToken(args: {
  token: string;
  secret: string;
  nowMs?: number;
  expectScope?: UnsubscribePayload['scope'];
}): VerifyResult {
  if (typeof args.token !== 'string') return { ok: false, reason: 'malformed' };
  const dot = args.token.indexOf('.');
  if (dot < 1 || dot === args.token.length - 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = args.token.slice(0, dot);
  const sig = args.token.slice(dot + 1);
  const expectedSig = hmacB64(args.secret, payloadB64);
  // Constant-time compare; reject mismatched lengths up front.
  const aBuf = Buffer.from(sig, 'utf8');
  const bBuf = Buffer.from(expectedSig, 'utf8');
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: UnsubscribePayload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(json) as UnsubscribePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload?.email !== 'string' ||
    typeof payload?.scope !== 'string' ||
    typeof payload?.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (payload.exp <= nowSec) return { ok: false, reason: 'expired' };
  if (args.expectScope && payload.scope !== args.expectScope) {
    return { ok: false, reason: 'wrong_scope' };
  }
  return { ok: true, payload };
}

function hmacB64(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}
