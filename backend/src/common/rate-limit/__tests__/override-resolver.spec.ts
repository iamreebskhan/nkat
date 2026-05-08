/**
 * Pure-helper tests for OverrideResolver. The DB refresh path is
 * exercised in the integration suite.
 */
import {
  buildOverrideMap,
  resolveOverride,
  type OverrideRow,
} from '../override-resolver';

const orgA = '11111111-1111-1111-1111-111111111111';
const orgB = '22222222-2222-2222-2222-222222222222';

const NOW = 1_700_000_000_000;

describe('buildOverrideMap', () => {
  it('keys by org_id:scope', () => {
    const m = buildOverrideMap(
      [
        { org_id: orgA, scope: 'lookup', limit: 100, refill_per_sec: 5, expires_at: null },
        { org_id: orgB, scope: 'lookup', limit: 200, refill_per_sec: 10, expires_at: null },
      ],
      NOW,
    );
    expect(m.get(`${orgA}:lookup`)).toEqual({ limit: 100, refillPerSec: 5 });
    expect(m.get(`${orgB}:lookup`)).toEqual({ limit: 200, refillPerSec: 10 });
    expect(m.size).toBe(2);
  });

  it('drops rows whose expires_at has passed', () => {
    const m = buildOverrideMap(
      [
        {
          org_id: orgA,
          scope: 'lookup',
          limit: 100,
          refill_per_sec: 5,
          expires_at: new Date(NOW - 1000),
        },
        {
          org_id: orgB,
          scope: 'lookup',
          limit: 200,
          refill_per_sec: 10,
          expires_at: new Date(NOW + 60_000),
        },
      ],
      NOW,
    );
    expect(m.has(`${orgA}:lookup`)).toBe(false);
    expect(m.has(`${orgB}:lookup`)).toBe(true);
  });

  it('treats expires_at exactly at NOW as expired (boundary)', () => {
    const m = buildOverrideMap(
      [
        {
          org_id: orgA,
          scope: 'lookup',
          limit: 100,
          refill_per_sec: 5,
          expires_at: new Date(NOW),
        },
      ],
      NOW,
    );
    expect(m.size).toBe(0);
  });

  it('different scopes for same org coexist', () => {
    const rows: OverrideRow[] = [
      { org_id: orgA, scope: 'lookup', limit: 100, refill_per_sec: 5, expires_at: null },
      { org_id: orgA, scope: 'synthesis', limit: 20, refill_per_sec: 1, expires_at: null },
    ];
    const m = buildOverrideMap(rows, NOW);
    expect(m.size).toBe(2);
  });
});

describe('resolveOverride', () => {
  const m = buildOverrideMap(
    [
      { org_id: orgA, scope: 'lookup', limit: 100, refill_per_sec: 5, expires_at: null },
    ],
    NOW,
  );

  it('returns the override when (orgId, scope) matches', () => {
    expect(resolveOverride(m, orgA, 'lookup')).toEqual({ limit: 100, refillPerSec: 5 });
  });

  it('returns undefined when scope misses', () => {
    expect(resolveOverride(m, orgA, 'synthesis')).toBeUndefined();
  });

  it('returns undefined when org misses', () => {
    expect(resolveOverride(m, orgB, 'lookup')).toBeUndefined();
  });
});
