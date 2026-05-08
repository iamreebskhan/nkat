import { canonicalize, hashRequest, isValidKey } from '../idempotency-pure';

describe('isValidKey', () => {
  it.each([
    ['12345678', true],
    ['key-' + 'a'.repeat(11), true],
    ['a'.repeat(255), true],
    ['', false],
    ['short', false],
    ['a'.repeat(256), false],
    ['has space', false],
    ['has\ttab', false],
    [undefined, false],
    [null as unknown as string, false],
    [123 as unknown as string, false],
  ])('isValidKey(%p) → %p', (k, expected) => {
    expect(isValidKey(k as string | undefined)).toBe(expected);
  });
});

describe('canonicalize — object key sort', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts nested object keys', () => {
    expect(canonicalize({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(undefined)).toBe('null');
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(42)).toBe('42');
  });

  it('coerces non-finite numbers to null (JSON-safe)', () => {
    expect(canonicalize(Infinity)).toBe('null');
    expect(canonicalize(NaN)).toBe('null');
  });
});

describe('hashRequest', () => {
  it('produces stable 64-char hex output', () => {
    const h = hashRequest({ method: 'POST', path: '/v1/lookup', body: { a: 1 } });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    const a = hashRequest({ method: 'POST', path: '/v1/lookup', body: { a: 1, b: 2 } });
    const b = hashRequest({ method: 'POST', path: '/v1/lookup', body: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('changes when method differs', () => {
    expect(hashRequest({ method: 'POST', path: '/x', body: {} })).not.toBe(
      hashRequest({ method: 'PUT', path: '/x', body: {} }),
    );
  });

  it('changes when path differs', () => {
    expect(hashRequest({ method: 'POST', path: '/x', body: {} })).not.toBe(
      hashRequest({ method: 'POST', path: '/y', body: {} }),
    );
  });

  it('changes when body differs', () => {
    expect(hashRequest({ method: 'POST', path: '/x', body: { a: 1 } })).not.toBe(
      hashRequest({ method: 'POST', path: '/x', body: { a: 2 } }),
    );
  });

  it('case-normalizes method', () => {
    expect(hashRequest({ method: 'post', path: '/x', body: {} })).toBe(
      hashRequest({ method: 'POST', path: '/x', body: {} }),
    );
  });
});
