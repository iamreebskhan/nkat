import { canonicalQuery, canonicalUri, formatAmzDate, signRequest } from '../sigv4';

describe('formatAmzDate', () => {
  it('produces YYYYMMDDTHHMMSSZ', () => {
    expect(formatAmzDate(new Date('2026-05-06T09:30:15.123Z'))).toBe('20260506T093015Z');
  });
});

describe('canonicalUri', () => {
  it('returns / on empty input', () => {
    expect(canonicalUri('')).toBe('/');
  });
  it('preserves slashes, percent-encodes segments', () => {
    expect(canonicalUri('/v2/email/outbound emails')).toBe('/v2/email/outbound%20emails');
  });
  it('encodes RFC-3986 reserved chars', () => {
    expect(canonicalUri('/x/y(z)')).toBe('/x/y%28z%29');
  });
});

describe('canonicalQuery', () => {
  it('returns empty string on empty input', () => {
    expect(canonicalQuery('')).toBe('');
  });
  it('sorts keys + percent-encodes values (literal + is %2B per RFC 3986)', () => {
    // decodeURIComponent does NOT treat '+' as space (that's
    // application/x-www-form-urlencoded, not URI). So '+' round-trips
    // to '%2B'. Tested explicitly because this is the #1 trap in
    // SigV4 implementations.
    expect(canonicalQuery('B=2&A=1+2')).toBe('A=1%2B2&B=2');
  });

  it('preserves space encoding (input %20 → output %20)', () => {
    expect(canonicalQuery('A=1%202')).toBe('A=1%202');
  });
  it('handles missing values', () => {
    expect(canonicalQuery('flag&key=v')).toBe('flag=&key=v');
  });
});

/**
 * Structural regression suite. Verifies the signer's deterministic shape:
 *   - Authorization line format (Credential / SignedHeaders / Signature).
 *   - amzDate ISO compliance.
 *   - The signature changes when ANY signed input changes (body, query,
 *     header value, region, secret).
 *   - The signer is deterministic for identical inputs (same time).
 *
 * Cross-validation against AWS prod is the integration story, not the
 * unit story — Phase 18's stage rehearsal sends one real email and
 * inspects the SES result directly.
 */
describe('signRequest — structural regression', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  };
  const baseArgs = {
    method: 'POST' as const,
    path: '/v2/email/outbound-emails',
    query: '',
    headers: { host: 'email.us-east-1.amazonaws.com', 'content-type': 'application/json' },
    body: '{"FromEmailAddress":"no-reply@example.com"}',
    region: 'us-east-1',
    service: 'ses',
    credentials,
    now: new Date('2026-05-06T09:30:15Z'),
  };

  function sigOf(over: Partial<typeof baseArgs>): string {
    const r = signRequest({ ...baseArgs, ...over });
    return r.headers.Authorization;
  }

  it('produces a parseable Authorization line', () => {
    const r = signRequest(baseArgs);
    expect(r.amzDate).toBe('20260506T093015Z');
    expect(r.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260506\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('is deterministic on identical inputs', () => {
    expect(sigOf({})).toBe(sigOf({}));
  });

  it('changes when body changes', () => {
    expect(sigOf({})).not.toBe(sigOf({ body: '{"x":1}' }));
  });
  it('changes when query changes', () => {
    expect(sigOf({})).not.toBe(sigOf({ query: 'foo=1' }));
  });
  it('changes when a signed header value changes', () => {
    const a = sigOf({});
    const b = sigOf({ headers: { ...baseArgs.headers, host: 'email.us-west-2.amazonaws.com' } });
    expect(a).not.toBe(b);
  });
  it('changes when secret changes', () => {
    expect(sigOf({})).not.toBe(
      sigOf({ credentials: { ...credentials, secretAccessKey: 'OTHERSECRET' } }),
    );
  });
  it('changes when region changes', () => {
    expect(sigOf({})).not.toBe(sigOf({ region: 'us-west-2' }));
  });
});

describe('signRequest — session token branch', () => {
  it('includes x-amz-security-token in canonical headers + final headers', () => {
    const r = signRequest({
      method: 'POST',
      path: '/v2/email/outbound-emails',
      query: '',
      headers: { host: 'email.us-east-1.amazonaws.com', 'content-type': 'application/json' },
      body: JSON.stringify({ FromEmailAddress: 'no-reply@example.com' }),
      region: 'us-east-1',
      service: 'ses',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'sekret',
        sessionToken: 'AWSSESSIONTOKENVALUE',
      },
      now: new Date('2026-05-06T09:30:15.000Z'),
    });
    expect(r.headers['x-amz-security-token']).toBe('AWSSESSIONTOKENVALUE');
    expect(r.headers.Authorization).toMatch(/SignedHeaders=[^,]*x-amz-security-token/);
  });
});
