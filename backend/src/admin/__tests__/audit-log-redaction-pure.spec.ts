/**
 * Unit tests for the pure helpers in `audit-log-redaction.service`.
 * The DB-touching service is integration-tested separately.
 */
import {
  canonicalize,
  computeRedactedPayload,
  hashPayload,
} from '../audit-log-redaction.service';

describe('canonicalize', () => {
  it('serializes primitives unchanged', () => {
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
  });

  it('sorts object keys deterministically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('recurses into nested objects + arrays', () => {
    const v = { z: [{ b: 1, a: 2 }], a: 'x' };
    expect(canonicalize(v)).toBe('{"a":"x","z":[{"a":2,"b":1}]}');
  });
});

describe('hashPayload', () => {
  it('produces a stable hex SHA-256', () => {
    const h = hashPayload({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-independent on object keys', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('different payloads → different hashes', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});

describe('computeRedactedPayload', () => {
  it('payload_remove returns minimal marker', () => {
    expect(computeRedactedPayload({ patient: 'X', dob: '1990-01-01' }, 'payload_remove'))
      .toEqual({ redacted: true });
  });

  it('payload_scrub keeps shape, replaces strings with [REDACTED]', () => {
    const out = computeRedactedPayload(
      { patient_name: 'Jane Doe', mrn: '12345', age: 42, active: true },
      'payload_scrub',
    );
    expect(out).toEqual({
      redacted: true,
      patient_name: '[REDACTED]',
      mrn: '[REDACTED]',
      age: 0,
      active: false,
    });
  });

  it('payload_scrub recurses into nested objects', () => {
    const out = computeRedactedPayload(
      { patient: { name: 'Jane', dob: '1990' }, codes: ['99213'] },
      'payload_scrub',
    );
    expect(out).toEqual({
      redacted: true,
      patient: { redacted: true, name: '[REDACTED]', dob: '[REDACTED]' },
      codes: [], // arrays cleared — length itself can be PII
    });
  });

  it('payload_scrub on a primitive returns marker + redacted value', () => {
    expect(computeRedactedPayload('PHI', 'payload_scrub')).toEqual({
      redacted: true,
      value: '[REDACTED]',
    });
  });

  it('payload_scrub preserves null', () => {
    const out = computeRedactedPayload({ a: null, b: 'x' }, 'payload_scrub');
    expect(out).toEqual({ redacted: true, a: null, b: '[REDACTED]' });
  });
});
