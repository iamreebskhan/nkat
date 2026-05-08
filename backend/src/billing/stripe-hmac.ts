/**
 * Verify a Stripe webhook signature without importing the Stripe SDK.
 *
 * Stripe's `Stripe-Signature` header carries: `t=<unix>,v1=<hex>` with
 * v1 = HMAC-SHA256(`<t>.<rawBody>`, signing_secret). We reconstruct it
 * and constant-time compare. Replay protection: reject if `t` is older
 * than `toleranceSec` (default 5 minutes).
 *
 * Pure function: takes header + raw body + secret + clock-now, returns
 * `{ ok: true, timestamp }` or throws InvalidWebhookSignatureError.
 *
 * Why our own verifier instead of `Stripe.webhooks.constructEvent(...)`:
 * keeps the Stripe SDK out of the hot path's import graph, makes the
 * verifier trivially testable with a known body + known secret + known
 * expected signature (computed in the test).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidWebhookSignatureError } from './billing-types';

export interface VerifyArgs {
  header: string;
  rawBody: string;
  /**
   * Active signing secret(s). Pass an array during rotation: the new
   * secret first, the previous secret second. Each candidate v1
   * signature is checked against every secret. Stripe admin lets two
   * secrets coexist on the endpoint during rotation; by accepting
   * BOTH on the verify side we can roll deploys without coordinating
   * the dashboard rotation to the second.
   */
  signingSecret: string | string[];
  /** Replay-protection tolerance in seconds. Stripe default = 300. */
  toleranceSec?: number;
  /** Override clock for tests. Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Result includes which secret index (0-based) matched, so callers
 * can metric "rotation candidate hits" and know when it's safe to
 * retire the previous secret.
 */
export interface VerifyResult {
  timestamp: number;
  secretIndex: number;
}

export function verifyStripeSignature(args: VerifyArgs): VerifyResult {
  const { header, rawBody } = args;
  const secrets = Array.isArray(args.signingSecret)
    ? args.signingSecret
    : [args.signingSecret];
  if (secrets.length === 0) {
    throw new InvalidWebhookSignatureError('no signing secrets configured');
  }
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new InvalidWebhookSignatureError('signing secret must be a non-empty string');
    }
  }
  const tolerance = args.toleranceSec ?? 300;
  const now = Math.floor((args.nowMs ?? Date.now()) / 1000);

  if (typeof header !== 'string' || header.length === 0) {
    throw new InvalidWebhookSignatureError('missing Stripe-Signature header');
  }

  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (k === 't') timestamp = parseInt(v, 10);
    else if (k === 'v1') v1.push(v);
  }
  if (timestamp === null || Number.isNaN(timestamp) || v1.length === 0) {
    throw new InvalidWebhookSignatureError('malformed Stripe-Signature header');
  }
  if (Math.abs(now - timestamp) > tolerance) {
    throw new InvalidWebhookSignatureError(
      `signature timestamp outside tolerance (${Math.abs(now - timestamp)}s > ${tolerance}s)`,
    );
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  // Try each (secret, candidate-v1) pair. We fully iterate both lists
  // — no early-return on first secret-mismatch — so timing leaks the
  // *count* of secrets but not which one matched. The count is non-
  // sensitive (we publish rotation in changelog).
  for (let i = 0; i < secrets.length; i++) {
    const expected = createHmac('sha256', secrets[i]).update(signedPayload).digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    for (const candidate of v1) {
      const candBuf = Buffer.from(candidate, 'utf8');
      if (candBuf.length !== expectedBuf.length) continue;
      if (timingSafeEqual(candBuf, expectedBuf)) {
        return { timestamp, secretIndex: i };
      }
    }
  }
  throw new InvalidWebhookSignatureError('no matching v1 signature');
}
