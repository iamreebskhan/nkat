import { createHash } from 'node:crypto';
import {
  constantTimeEqual,
  DEFAULT_TTL_MS,
  expiryFromNow,
  generateToken,
  parseToken,
  PREFIX_CHARS,
  RAW_TOKEN_BYTES,
} from '../invite-pure';

describe('generateToken', () => {
  it('produces base64url raw of expected length', () => {
    const t = generateToken();
    // 32 bytes → 43 base64url chars (no padding)
    expect(t.raw).toHaveLength(Math.ceil((RAW_TOKEN_BYTES * 4) / 3));
    expect(t.raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('prefix is the first 12 chars of raw', () => {
    const t = generateToken();
    expect(t.prefix).toHaveLength(PREFIX_CHARS);
    expect(t.raw.slice(0, PREFIX_CHARS)).toBe(t.prefix);
  });

  it('hash matches sha256(raw)', () => {
    const t = generateToken();
    const expected = createHash('sha256').update(t.raw).digest('hex');
    expect(t.hash).toBe(expected);
    expect(t.hash).toHaveLength(64);
  });

  it('raw is unique across many calls (no obvious collision)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateToken().raw);
    expect(seen.size).toBe(1000);
  });
});

describe('parseToken', () => {
  it('parses a well-formed raw token consistently with generateToken', () => {
    const t = generateToken();
    const parsed = parseToken(t.raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(t.prefix);
    expect(parsed!.hash).toBe(t.hash);
  });

  it('returns null on too-short input', () => {
    expect(parseToken('short')).toBeNull();
  });

  it('returns null on wrong charset', () => {
    // Character outside A-Z a-z 0-9 - _
    expect(parseToken('AAAAAAAAAAAA!')).toBeNull();
  });

  it.each([null, undefined, 0, {}])('returns null on non-string %p', (v) => {
    expect(parseToken(v as unknown as string)).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('true on identical strings', () => {
    expect(constantTimeEqual('abcd1234', 'abcd1234')).toBe(true);
  });

  it('false on different strings', () => {
    expect(constantTimeEqual('abcd1234', 'abcd1235')).toBe(false);
  });

  it('false on different lengths (without timing-side-channel risk)', () => {
    // Notably: timingSafeEqual would throw on mismatched lengths; our
    // wrapper turns that into a clean false.
    expect(constantTimeEqual('a', 'aa')).toBe(false);
  });
});

describe('expiryFromNow', () => {
  it('defaults to 7 days from the supplied clock', () => {
    const now = 1_700_000_000_000;
    expect(expiryFromNow(now).getTime()).toBe(now + DEFAULT_TTL_MS);
  });
  it('respects a custom ttlMs', () => {
    const now = 1_700_000_000_000;
    expect(expiryFromNow(now, 60_000).getTime()).toBe(now + 60_000);
  });
});
