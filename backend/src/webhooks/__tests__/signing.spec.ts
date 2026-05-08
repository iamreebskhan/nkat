import { canonicalJson, signPayload, verifySignature } from '../signing';

describe('canonicalJson', () => {
  it('sorts top-level keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
  });

  it('escapes JSON strings', () => {
    expect(canonicalJson({ x: 'a"b\\c' })).toBe('{"x":"a\\"b\\\\c"}');
  });
});

describe('signPayload + verifySignature', () => {
  const SECRET = 'whsec_supersecret';
  const FIXED = 1_700_000_000_000;

  it('signs a payload and verifies round-trip', () => {
    const signed = signPayload(SECRET, { event: 'alert.created', alert_id: 'x' }, FIXED);
    expect(signed.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(SECRET, signed.body, signed.timestamp, signed.signature, 60_000, FIXED)).toBe(true);
  });

  it('fails verification on tampered body', () => {
    const signed = signPayload(SECRET, { x: 1 }, FIXED);
    expect(verifySignature(SECRET, signed.body + ' ', signed.timestamp, signed.signature, 60_000, FIXED)).toBe(false);
  });

  it('fails verification on wrong secret', () => {
    const signed = signPayload(SECRET, { x: 1 }, FIXED);
    expect(verifySignature('different', signed.body, signed.timestamp, signed.signature, 60_000, FIXED)).toBe(false);
  });

  it('fails verification on stale timestamp (replay protection)', () => {
    const signed = signPayload(SECRET, { x: 1 }, FIXED);
    // 10 minutes later, default 5-min tolerance
    expect(verifySignature(SECRET, signed.body, signed.timestamp, signed.signature, 5 * 60 * 1000, FIXED + 10 * 60 * 1000)).toBe(false);
  });

  it('fails verification on missing sha256 prefix', () => {
    const signed = signPayload(SECRET, { x: 1 }, FIXED);
    const naked = signed.signature.replace('sha256=', '');
    expect(verifySignature(SECRET, signed.body, signed.timestamp, naked, 60_000, FIXED)).toBe(false);
  });

  it('produces stable signature for equivalent objects with different key orders', () => {
    const a = signPayload(SECRET, { a: 1, b: 2 }, FIXED);
    const b = signPayload(SECRET, { b: 2, a: 1 }, FIXED);
    expect(a.signature).toBe(b.signature);
  });

  it('produces different signatures for different payloads at the same timestamp', () => {
    const a = signPayload(SECRET, { a: 1 }, FIXED);
    const b = signPayload(SECRET, { a: 2 }, FIXED);
    expect(a.signature).not.toBe(b.signature);
  });

  it('uses constant-time comparison (no early return on mismatch length)', () => {
    const signed = signPayload(SECRET, { x: 1 }, FIXED);
    // truncated signature must fail (not throw)
    const truncated = signed.signature.slice(0, signed.signature.length - 5);
    expect(verifySignature(SECRET, signed.body, signed.timestamp, truncated, 60_000, FIXED)).toBe(false);
  });
});
