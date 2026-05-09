/**
 * Pure-helper tests for the DogStatsD line builder.
 * The UDP-emit path is environment-coupled and gets exercised in
 * the integration suite (testcontainer datadog mock).
 */
import { buildTagList, formatMetricLine, NoopMetrics, sanitizeTagPart } from '../metrics.service';

describe('formatMetricLine', () => {
  it('encodes a counter with no tags', () => {
    expect(formatMetricLine('foo.bar', 1, 'c', [])).toBe('foo.bar:1|c');
  });

  it('encodes integer values without trailing zeros', () => {
    expect(formatMetricLine('m', 42, 'g', [])).toBe('m:42|g');
  });

  it('encodes fractional values without trailing zeros', () => {
    expect(formatMetricLine('m', 1.5, 'h', [])).toBe('m:1.5|h');
    expect(formatMetricLine('m', 1.5, 'h', [])).toBe('m:1.5|h');
  });

  it('encodes timing values', () => {
    expect(formatMetricLine('m', 250, 'ms', [])).toBe('m:250|ms');
  });

  it('coerces non-finite values to 0', () => {
    expect(formatMetricLine('m', Number.NaN, 'g', [])).toBe('m:0|g');
    expect(formatMetricLine('m', Number.POSITIVE_INFINITY, 'g', [])).toBe('m:0|g');
  });

  it('appends tags joined by commas after |#', () => {
    expect(formatMetricLine('m', 1, 'c', ['env:prod', 'scope:lookup'])).toBe(
      'm:1|c|#env:prod,scope:lookup',
    );
  });
});

describe('buildTagList', () => {
  it('combines global tags with per-call kv pairs', () => {
    expect(buildTagList(['env:prod'], { scope: 'lookup', orgId: 'abc' })).toEqual([
      'env:prod',
      'scope:lookup',
      'orgId:abc',
    ]);
  });

  it('handles missing per-call tags', () => {
    expect(buildTagList(['env:prod'], undefined)).toEqual(['env:prod']);
  });

  it('coerces numeric values to strings', () => {
    expect(buildTagList([], { secret_index: 1 })).toEqual(['secret_index:1']);
  });
});

describe('sanitizeTagPart', () => {
  it('replaces |, comma, whitespace with _', () => {
    expect(sanitizeTagPart('a|b,c d')).toBe('a_b_c_d');
  });

  it('truncates to 200 chars', () => {
    expect(sanitizeTagPart('x'.repeat(300)).length).toBe(200);
  });
});

describe('NoopMetrics', () => {
  it('does nothing on every call', () => {
    const m = new NoopMetrics();
    m.increment('a');
    m.gauge('b', 1);
    m.histogram('c', 2);
    m.timing('d', 3);
    // No assertion needed — just verifying methods exist and return void.
  });
});
