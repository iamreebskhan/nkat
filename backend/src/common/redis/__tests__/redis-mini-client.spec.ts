/**
 * Unit tests for the RESP-2 wire encoding/parsing primitives. The
 * connection-level + Redis-server interaction tests live in
 * `test/integration/rate-limit-redis.spec.ts` (skipped without
 * INTEGRATION=1 + a real Redis service container).
 */
import { encodeArray, parseOne } from '../redis-mini-client';

describe('encodeArray (RESP-2)', () => {
  it('encodes a simple command', () => {
    expect(encodeArray(['PING']).toString('utf8')).toBe('*1\r\n$4\r\nPING\r\n');
  });

  it('encodes EVAL with multiple args', () => {
    const out = encodeArray(['EVAL', 'return 1', '0']).toString('utf8');
    expect(out).toBe('*3\r\n$4\r\nEVAL\r\n$8\r\nreturn 1\r\n$1\r\n0\r\n');
  });

  it('encodes UTF-8 byte length, not character count', () => {
    // "héllo" = 6 bytes (é = 2 bytes in UTF-8), 5 chars.
    const out = encodeArray(['héllo']).toString('utf8');
    expect(out).toContain('$6\r\n');
  });

  it('encodes empty string', () => {
    expect(encodeArray(['']).toString('utf8')).toBe('*1\r\n$0\r\n\r\n');
  });
});

describe('parseOne (RESP-2)', () => {
  function p(s: string) {
    return parseOne(Buffer.from(s, 'utf8'), 0);
  }

  it('parses simple string +OK', () => {
    expect(p('+OK\r\n')).toEqual(['OK', 5]);
  });

  it('parses integer :42', () => {
    expect(p(':42\r\n')).toEqual([42, 5]);
  });

  it('parses negative integer', () => {
    expect(p(':-7\r\n')).toEqual([-7, 5]);
  });

  it('parses bulk string', () => {
    expect(p('$5\r\nhello\r\n')).toEqual(['hello', 11]);
  });

  it('parses nil bulk string ($-1)', () => {
    expect(p('$-1\r\n')).toEqual([null, 5]);
  });

  it('parses error -ERR ...', () => {
    const r = p('-ERR something bad\r\n');
    expect(r![0]).toBeInstanceOf(Error);
    expect((r![0] as Error).message).toBe('ERR something bad');
  });

  it('parses array of mixed types', () => {
    const r = p('*3\r\n:1\r\n+OK\r\n$4\r\ncool\r\n');
    expect(r![0]).toEqual([1, 'OK', 'cool']);
  });

  it('parses nested array', () => {
    const r = p('*2\r\n*2\r\n:1\r\n:2\r\n$5\r\nhello\r\n');
    expect(r![0]).toEqual([[1, 2], 'hello']);
  });

  it('returns null when buffer truncated mid-bulk-string', () => {
    expect(p('$5\r\nhel')).toBeNull();
  });

  it('returns null when buffer truncated mid-array', () => {
    expect(p('*2\r\n:1\r\n')).toBeNull();
  });

  it('parses across an offset (caller reusing the buffer)', () => {
    const buf = Buffer.from('+IGNORED\r\n+OK\r\n', 'utf8');
    expect(parseOne(buf, 10)).toEqual(['OK', 15]);
  });
});

describe('RESP round-trip — typical EVAL response shape', () => {
  it('encodes EVAL request + parses 3-element integer array reply', () => {
    // Request side
    const req = encodeArray([
      'EVAL',
      'return {1, 5, 0}',
      '0',
    ]).toString('utf8');
    expect(req).toContain('EVAL');
    // Server reply for `{1, 5, 0}` would be: *3\r\n:1\r\n:5\r\n:0\r\n
    const resp = parseOne(Buffer.from('*3\r\n:1\r\n:5\r\n:0\r\n', 'utf8'), 0);
    expect(resp![0]).toEqual([1, 5, 0]);
  });
});
