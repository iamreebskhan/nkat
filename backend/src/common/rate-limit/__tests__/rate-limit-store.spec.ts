import { InMemoryRateLimitStore, RedisRateLimitStore, type RedisLike } from '../rate-limit-store';

describe('InMemoryRateLimitStore', () => {
  it('allows up to limit, then rejects with retryAfterMs', async () => {
    const s = new InMemoryRateLimitStore();
    const cfg = { limit: 2, refillPerSec: 1, key: 'k' };
    const t = 1_000_000;
    expect((await s.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    expect((await s.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    const r = await s.consume({ ...cfg, nowMs: t });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterMs).toBe(1000);
  });

  it('different keys are independent', async () => {
    const s = new InMemoryRateLimitStore();
    const t = 1_000_000;
    expect((await s.consume({ key: 'a', limit: 1, refillPerSec: 1, nowMs: t })).allowed).toBe(true);
    expect((await s.consume({ key: 'a', limit: 1, refillPerSec: 1, nowMs: t })).allowed).toBe(
      false,
    );
    expect((await s.consume({ key: 'b', limit: 1, refillPerSec: 1, nowMs: t })).allowed).toBe(true);
  });
});

/**
 * Fake Redis: an in-process simulator that runs the same Lua semantics
 * the Redis store sends. We don't actually parse Lua; we replicate the
 * algorithm in JS so the tests prove the surface contract.
 */
class FakeRedis implements RedisLike {
  store = new Map<string, { tokens: number; lastRefillMs: number }>();
  evalCalls = 0;
  shouldFail = false;
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    limit: number,
    refillPerSec: number,
    nowMs: number,
    _ttlSec: number,
  ): Promise<unknown> {
    this.evalCalls++;
    if (this.shouldFail) throw new Error('redis simulated outage');
    let entry = this.store.get(key);
    if (!entry) {
      entry = { tokens: limit, lastRefillMs: nowMs };
      this.store.set(key, entry);
    }
    const elapsed = Math.max(0, (nowMs - entry.lastRefillMs) / 1000);
    let refilled = entry.tokens + elapsed * refillPerSec;
    if (refilled > limit) refilled = limit;
    if (refilled >= 1) {
      refilled -= 1;
      entry.tokens = refilled;
      entry.lastRefillMs = nowMs;
      return [1, Math.floor(refilled), 0];
    }
    entry.tokens = refilled;
    entry.lastRefillMs = nowMs;
    const retry = Math.ceil(((1 - refilled) / refillPerSec) * 1000);
    return [0, 0, retry];
  }
}

describe('RedisRateLimitStore', () => {
  it('passes the right Lua args to Redis', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([1, 5, 0]),
    } as unknown as RedisLike;
    const s = new RedisRateLimitStore(redis, 'br:rl:', 1800);
    await s.consume({ key: 'lookup:org-a', limit: 60, refillPerSec: 1, nowMs: 1_700_000_000_000 });
    expect((redis.eval as jest.Mock).mock.calls[0]).toEqual([
      expect.stringContaining('redis.call'),
      1,
      'br:rl:lookup:org-a',
      60,
      1,
      1_700_000_000_000,
      1800,
    ]);
  });

  it('end-to-end: allows up to limit, rejects, refills', async () => {
    const redis = new FakeRedis();
    const s = new RedisRateLimitStore(redis, 'rl:', 1800);
    const cfg = { key: 'k', limit: 2, refillPerSec: 1 };
    expect((await s.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(true);
    expect((await s.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(true);
    const rejected = await s.consume({ ...cfg, nowMs: 1_000_000 });
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) expect(rejected.retryAfterMs).toBe(1000);
    // 1.5s later → 1.5 tokens refilled.
    expect((await s.consume({ ...cfg, nowMs: 1_001_500 })).allowed).toBe(true);
  });

  it('shares state across two store instances pointed at the same FakeRedis (multi-task)', async () => {
    const redis = new FakeRedis();
    const taskA = new RedisRateLimitStore(redis, 'rl:', 1800);
    const taskB = new RedisRateLimitStore(redis, 'rl:', 1800);
    const cfg = { key: 'k', limit: 2, refillPerSec: 0 };
    expect((await taskA.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(true);
    expect((await taskB.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(true);
    // Both stores have consumed; the third request from EITHER hits the global limit.
    expect((await taskA.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(false);
    expect((await taskB.consume({ ...cfg, nowMs: 1_000_000 })).allowed).toBe(false);
  });

  it('fails open on Redis outage (logs but allows)', async () => {
    const redis = new FakeRedis();
    redis.shouldFail = true;
    const s = new RedisRateLimitStore(redis, 'rl:', 1800);
    const r = await s.consume({ key: 'k', limit: 5, refillPerSec: 1, nowMs: 1_000_000 });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBe(5);
  });

  it('keyPrefix is applied to every consume', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue([1, 0, 0]),
    } as unknown as RedisLike;
    const s = new RedisRateLimitStore(redis, 'br-prod:rl:', 1800);
    await s.consume({ key: 'synthesis:org-x', limit: 10, refillPerSec: 1, nowMs: 1 });
    expect((redis.eval as jest.Mock).mock.calls[0][2]).toBe('br-prod:rl:synthesis:org-x');
  });
});
