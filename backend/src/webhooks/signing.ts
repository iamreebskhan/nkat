/**
 * HMAC-SHA256 signing for webhook payloads.
 *
 * Header format: `X-Signature: sha256=<hex>`
 * Sign over: `<timestamp>.<canonical_json>`
 *
 * This matches the GitHub / Stripe convention closely enough that customers
 * who already integrate with those won't be surprised. We additionally
 * require timestamp prefix for replay protection.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedPayload {
  timestamp: number; // unix millis
  body: string; // canonical JSON string
  signature: string; // 'sha256=<hex>'
}

export function canonicalJson(input: unknown): string {
  // Deterministic JSON: sort keys recursively. Required for signature stability.
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(input as Record<string, unknown>).sort();
  const inner = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((input as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${inner}}`;
}

export function signPayload(secret: string, payload: unknown, now = Date.now()): SignedPayload {
  const body = canonicalJson(payload);
  const message = `${now}.${body}`;
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  return { timestamp: now, body, signature: `sha256=${digest}` };
}

/**
 * Verify a signature. Caller checks `tolerance_ms` against drift; default 5
 * minutes is enough for clock skew on cloud workers.
 */
export function verifySignature(
  secret: string,
  body: string,
  timestamp: number,
  signatureHeader: string,
  toleranceMs = 5 * 60 * 1000,
  now = Date.now(),
): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  if (Math.abs(now - timestamp) > toleranceMs) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}
