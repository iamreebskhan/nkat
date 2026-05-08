import { evictIdle, tryConsume, type BucketState } from '../rate-limit-pure';

describe('tryConsume — token bucket', () => {
  it('allows up to `limit` consecutive consumes, then rejects', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 3, refillPerSec: 1 };
    const t = 1_000_000;
    expect(tryConsume(state, t, 'k', cfg).allowed).toBe(true);     // 2 left
    expect(tryConsume(state, t, 'k', cfg).allowed).toBe(true);     // 1 left
    expect(tryConsume(state, t, 'k', cfg).allowed).toBe(true);     // 0 left
    const fourth = tryConsume(state, t, 'k', cfg);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('refills linearly over time', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 2, refillPerSec: 1 };
    const t0 = 1_000_000;
    tryConsume(state, t0, 'k', cfg); // 1 left
    tryConsume(state, t0, 'k', cfg); // 0 left
    expect(tryConsume(state, t0, 'k', cfg).allowed).toBe(false);
    // 1.5s later → 1.5 tokens refilled, but cap is 2.
    expect(tryConsume(state, t0 + 1500, 'k', cfg).allowed).toBe(true);
  });

  it('caps refill at `limit` (no token-hoarding past idle window)', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 5, refillPerSec: 1 };
    const t0 = 1_000_000;
    tryConsume(state, t0, 'k', cfg); // 4 left
    // 1000s later — would refill 1000 tokens, but cap at 5.
    const r = tryConsume(state, t0 + 1_000_000, 'k', cfg);
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(4);
  });

  it('keys are independent (per-tenant isolation)', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 1, refillPerSec: 0.1 };
    const t = 1_000_000;
    expect(tryConsume(state, t, 'org-A', cfg).allowed).toBe(true);
    expect(tryConsume(state, t, 'org-A', cfg).allowed).toBe(false);
    // org-B gets its own bucket.
    expect(tryConsume(state, t, 'org-B', cfg).allowed).toBe(true);
  });

  it('retryAfterMs is at least 1ms when bucket exhausted', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 1, refillPerSec: 1 };
    const t = 1_000_000;
    tryConsume(state, t, 'k', cfg);
    const r = tryConsume(state, t, 'k', cfg);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      // Need 1 token at 1/sec → 1000ms ceiling.
      expect(r.retryAfterMs).toBe(1000);
    }
  });

  it('refillPerSec=0 means strict-window (only initial burst, no recovery)', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 2, refillPerSec: 0 };
    const t0 = 1_000_000;
    tryConsume(state, t0, 'k', cfg);
    tryConsume(state, t0, 'k', cfg);
    // Even an hour later, no refill.
    expect(tryConsume(state, t0 + 3_600_000, 'k', cfg).allowed).toBe(false);
  });
});

describe('evictIdle', () => {
  it('drops buckets idle past maxIdleMs', () => {
    const state = new Map<string, BucketState>();
    const cfg = { limit: 5, refillPerSec: 1 };
    tryConsume(state, 1_000_000, 'a', cfg);
    tryConsume(state, 1_000_000, 'b', cfg);
    tryConsume(state, 2_000_000, 'a', cfg); // a refreshes lastRefill
    // Now=2_500_000; maxIdle=600_000. 'b' last touched at 1_000_000 → 1.5M idle → evicted.
    const n = evictIdle(state, 2_500_000, 600_000);
    expect(n).toBe(1);
    expect(state.has('a')).toBe(true);
    expect(state.has('b')).toBe(false);
  });

  it('returns 0 when nothing is idle', () => {
    const state = new Map<string, BucketState>();
    tryConsume(state, 1_000_000, 'x', { limit: 1, refillPerSec: 1 });
    expect(evictIdle(state, 1_001_000, 600_000)).toBe(0);
  });
});
