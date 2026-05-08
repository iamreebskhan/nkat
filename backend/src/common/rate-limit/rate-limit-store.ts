/**
 * Storage layer for the rate-limit interceptor. Two implementations:
 *
 *   - InMemoryRateLimitStore — Phase 30 default. Per-task buckets;
 *     effective tenant quota = (running ECS tasks) × limit. Fine for
 *     small fleets (<5 tasks); the headroom is intentional.
 *
 *   - RedisRateLimitStore — Phase 31. Atomic Lua script per consume so
 *     all ECS tasks share one bucket per (scope, orgId). Effective
 *     quota matches the configured limit, regardless of fleet size.
 *
 * Both implementations satisfy the same `RateLimitStore` interface so
 * the interceptor doesn't change.
 */
import { Logger } from '@nestjs/common';
import { evictIdle, tryConsume, type BucketState } from './rate-limit-pure';

export interface RateLimitStore {
  consume(args: {
    key: string;
    limit: number;
    refillPerSec: number;
    nowMs?: number;
  }): Promise<RateLimitResult>;
}

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: 0; retryAfterMs: number };

// ----------------------------------------------------------------------------
// In-memory store (Phase 30 default — preserves existing behavior).
// ----------------------------------------------------------------------------

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();
  private lastEviction = 0;
  private readonly maxIdleMs: number;

  constructor(maxIdleMs: number = 30 * 60 * 1000) {
    this.maxIdleMs = maxIdleMs;
  }

  async consume(args: {
    key: string;
    limit: number;
    refillPerSec: number;
    nowMs?: number;
  }): Promise<RateLimitResult> {
    const now = args.nowMs ?? Date.now();
    if (now - this.lastEviction > 30_000) {
      evictIdle(this.buckets, now, this.maxIdleMs);
      this.lastEviction = now;
    }
    const r = tryConsume(this.buckets, now, args.key, {
      limit: args.limit,
      refillPerSec: args.refillPerSec,
    });
    return r;
  }

  /** Test-only — clear all buckets. */
  _reset(): void {
    this.buckets.clear();
    this.lastEviction = 0;
  }
}

// ----------------------------------------------------------------------------
// Redis store (Phase 31 — atomic via Lua script).
// ----------------------------------------------------------------------------

/**
 * Minimal Redis surface we depend on. The real `ioredis` client matches
 * this interface; tests can stub it directly.
 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Lua script that atomically:
 *   - Reads `tokens` + `lastRefillMs` from the bucket hash.
 *   - Refills based on elapsed time + cap at limit.
 *   - If tokens >= 1, decrement + write + return allowed.
 *   - Else compute retryAfterMs + return rejected.
 *   - Sets a TTL on the key so abandoned buckets self-clean.
 *
 * Keys: [1] bucket key
 * Args: [1] limit, [2] refillPerSec, [3] nowMs, [4] ttlSec
 * Returns: [allowed (0|1), remaining, retryAfterMs]
 */
const LUA_TOKEN_BUCKET = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
if tokens == nil then tokens = limit end
if last == nil then last = nowMs end

local elapsedSec = (nowMs - last) / 1000
if elapsedSec < 0 then elapsedSec = 0 end
local refilled = tokens + elapsedSec * refillPerSec
if refilled > limit then refilled = limit end

if refilled >= 1 then
  refilled = refilled - 1
  redis.call('HMSET', key, 'tokens', refilled, 'lastRefillMs', nowMs)
  redis.call('EXPIRE', key, ttl)
  return {1, math.floor(refilled), 0}
else
  redis.call('HMSET', key, 'tokens', refilled, 'lastRefillMs', nowMs)
  redis.call('EXPIRE', key, ttl)
  local needed = 1 - refilled
  local retry = math.ceil((needed / refillPerSec) * 1000)
  return {0, 0, retry}
end
`.trim();

export class RedisRateLimitStore implements RateLimitStore {
  private readonly log = new Logger(RedisRateLimitStore.name);
  private readonly ttlSec: number;

  constructor(
    private readonly redis: RedisLike,
    /** Redis key prefix to namespace buckets. e.g. `br-prod:rl:` */
    private readonly keyPrefix: string,
    /** Idle TTL on each bucket key, in seconds. Default 30 min. */
    ttlSec: number = 1800,
  ) {
    this.ttlSec = ttlSec;
  }

  async consume(args: {
    key: string;
    limit: number;
    refillPerSec: number;
    nowMs?: number;
  }): Promise<RateLimitResult> {
    const nowMs = args.nowMs ?? Date.now();
    const fullKey = `${this.keyPrefix}${args.key}`;
    let raw: unknown;
    try {
      raw = await this.redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        fullKey,
        args.limit,
        args.refillPerSec,
        nowMs,
        this.ttlSec,
      );
    } catch (e) {
      // Fail-open: a Redis outage shouldn't take down our API. Log
      // loudly so on-call sees the underlying failure.
      this.log.error(
        `Redis rate-limit eval failed; fail-open: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { allowed: true, remaining: args.limit };
    }
    if (!Array.isArray(raw) || raw.length < 3) {
      this.log.error(`Redis rate-limit eval returned unexpected shape: ${JSON.stringify(raw)}`);
      return { allowed: true, remaining: args.limit };
    }
    const [allowedFlag, remaining, retryAfterMs] = raw as [number, number, number];
    if (allowedFlag === 1) {
      return { allowed: true, remaining: Math.max(0, Math.floor(Number(remaining))) };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(1, Math.ceil(Number(retryAfterMs))),
    };
  }
}
