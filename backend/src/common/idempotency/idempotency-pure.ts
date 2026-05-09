/**
 * Pure helpers for the Stripe-style `Idempotency-Key` flow.
 *
 *   hashRequest({ method, path, body })  → 64-char hex SHA-256
 *   isValidKey(s)                         → boolean (8..255 chars, ASCII-printable)
 *
 * The hash is COMPUTED OVER (method, path, canonical-body). We canonicalize
 * the body by sort-keying every JSON object so that semantically-identical
 * bodies — `{a:1,b:2}` vs `{b:2,a:1}` — produce the same hash. This stops a
 * client retry that re-serializes its payload from being rejected with
 * IDEMPOTENCY_KEY_REUSED on a cosmetic difference.
 */
import { createHash } from 'node:crypto';

const KEY_RE = /^[\x21-\x7e]+$/; // printable ASCII, no spaces

export function isValidKey(key: string | undefined): key is string {
  if (typeof key !== 'string') return false;
  if (key.length < 8 || key.length > 255) return false;
  return KEY_RE.test(key);
}

export function hashRequest(args: { method: string; path: string; body: unknown }): string {
  const h = createHash('sha256');
  h.update(args.method.toUpperCase());
  h.update('\n');
  h.update(args.path);
  h.update('\n');
  h.update(canonicalize(args.body));
  return h.digest('hex');
}

/**
 * Deterministic JSON serialization with object keys sorted lexicographically
 * at every level. Arrays preserve order. Numbers, strings, booleans, null
 * round-trip via JSON.stringify with the sort applied.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}
