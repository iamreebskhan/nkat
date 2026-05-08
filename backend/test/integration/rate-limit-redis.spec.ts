/**
 * Integration test for RedisRateLimitStore against a real Redis.
 *
 *   - Local: Docker Desktop must be running. Set `REDIS_URL=redis://localhost:6379`
 *     OR rely on the testcontainers harness if we add one.
 *   - CI: a Redis service container in the workflow.
 *
 * The unit suite (`rate-limit-store.spec.ts`) covers the contract via a
 * `FakeRedis` simulator. THIS suite proves the actual Lua script
 * survives a round-trip through real Redis — that EXPIRE works, that
 * HMGET/HMSET tokens-as-string parse correctly, that concurrent eval
 * calls don't tangle, etc.
 *
 * Skipped automatically when `INTEGRATION!=1` so unit runs aren't
 * coupled to a Redis daemon.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { RedisMiniClient } from '../../src/common/redis/redis-mini-client';
import { RedisRateLimitStore } from '../../src/common/rate-limit/rate-limit-store';
import { integrationDescribe } from './harness';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? '6379', 10);
const PREFIX = `br-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}:rl:`;

integrationDescribe('RedisRateLimitStore against real Redis (integration)', () => {
  let client: RedisMiniClient;
  let store: RedisRateLimitStore;

  beforeAll(async () => {
    client = new RedisMiniClient({ host: REDIS_HOST, port: REDIS_PORT });
    store = new RedisRateLimitStore(client, PREFIX, 60);
    // Sanity-check the connection.
    const pong = await client.eval('return "PONG"', 0);
    expect(pong).toBe('PONG');
  }, 30_000);

  afterAll(async () => {
    // Clean up the prefix's keys so we don't pollute the test Redis.
    try {
      const keys = (await client.eval(
        `return redis.call('KEYS', ARGV[1])`,
        0,
        `${PREFIX}*`,
      )) as string[];
      for (const k of keys) {
        await client.eval(`return redis.call('DEL', KEYS[1])`, 1, k);
      }
    } catch {
      /* best effort */
    }
    await client.quit();
  });

  it('Lua script is loaded + returns the documented [allowed, remaining, retryAfterMs] tuple', async () => {
    const r = await store.consume({
      key: 'lua-shape-test',
      limit: 5,
      refillPerSec: 1,
      nowMs: 1_700_000_000_000,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.remaining).toBeGreaterThanOrEqual(0);
  });

  it('allows up to limit, then rejects, then refills', async () => {
    const cfg = { key: 'allow-then-reject', limit: 3, refillPerSec: 1 };
    const t = 1_700_000_000_000;
    expect((await store.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    expect((await store.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    expect((await store.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    const rejected = await store.consume({ ...cfg, nowMs: t });
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) expect(rejected.retryAfterMs).toBeGreaterThan(0);
    // 2s later → 2 tokens refilled.
    expect((await store.consume({ ...cfg, nowMs: t + 2000 })).allowed).toBe(true);
  });

  it('two store instances pointed at the same Redis share state', async () => {
    const taskA = new RedisRateLimitStore(client, PREFIX, 60);
    const taskB = new RedisRateLimitStore(client, PREFIX, 60);
    const cfg = { key: 'shared-state', limit: 2, refillPerSec: 0 };
    const t = 1_700_000_000_000;
    expect((await taskA.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    expect((await taskB.consume({ ...cfg, nowMs: t })).allowed).toBe(true);
    expect((await taskA.consume({ ...cfg, nowMs: t })).allowed).toBe(false);
    expect((await taskB.consume({ ...cfg, nowMs: t })).allowed).toBe(false);
  });

  it('EXPIRE is set: bucket self-cleans after TTL', async () => {
    const cfg = { key: 'expire-test', limit: 1, refillPerSec: 0 };
    await store.consume({ ...cfg, nowMs: 1_700_000_000_000 });
    // TTL was set to 60 sec at construct; verify with a TTL command.
    const ttl = (await client.eval(
      `return redis.call('TTL', KEYS[1])`,
      1,
      `${PREFIX}expire-test`,
    )) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('100 concurrent consumes against the same bucket: exactly `limit` allowed', async () => {
    const cfg = { key: 'concurrent', limit: 5, refillPerSec: 0 };
    const t = 1_700_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.consume({ ...cfg, nowMs: t })),
    );
    const allowed = results.filter((r) => r.allowed).length;
    // Atomic Lua means EXACTLY 5, not "approximately 5".
    expect(allowed).toBe(5);
  });

  it('different keys are independent', async () => {
    const t = 1_700_000_000_000;
    const a = await store.consume({ key: 'iso-a', limit: 1, refillPerSec: 0, nowMs: t });
    const a2 = await store.consume({ key: 'iso-a', limit: 1, refillPerSec: 0, nowMs: t });
    const b = await store.consume({ key: 'iso-b', limit: 1, refillPerSec: 0, nowMs: t });
    expect(a.allowed).toBe(true);
    expect(a2.allowed).toBe(false);
    expect(b.allowed).toBe(true);
  });

  it('handles burst then steady-state correctly with realistic clock', async () => {
    const cfg = { key: 'realistic', limit: 5, refillPerSec: 5 }; // 5/sec
    // Drain.
    for (let i = 0; i < 5; i++) {
      expect((await store.consume(cfg)).allowed).toBe(true);
    }
    // Immediate next call: rejected.
    expect((await store.consume(cfg)).allowed).toBe(false);
    // After ~250ms (one token's worth at 5/sec): allowed.
    await sleep(300);
    expect((await store.consume(cfg)).allowed).toBe(true);
  });
});
