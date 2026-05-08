/**
 * Token-bucket rate limiter — pure functions.
 *
 *   tryConsume(state, now, key, limit, refillPerSec)
 *
 * State is a Map<key, BucketState>. Bucket holds a `tokens` count + a
 * `lastRefill` timestamp; on every check we refill linearly based on
 * elapsed time, cap at `limit`, then attempt to consume 1 token.
 *
 * Why token bucket vs fixed window:
 *   - Smooth burst: a 60/min limit lets the customer burst 60 in the
 *     first second AFTER 60 seconds of idle, then steady-state at 1/sec.
 *   - Fairness across many tenants — each gets independent capacity.
 *
 * Per-test we expose `now` as an explicit arg so behavior is deterministic.
 */

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitConfig {
  /** Max tokens in the bucket (== max burst). */
  limit: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export type TryConsumeResult =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterMs: number; remaining: 0 };

/**
 * Try to consume one token from the bucket for `key`. Returns
 * `{allowed, remaining}` or `{allowed:false, retryAfterMs}`. Mutates
 * the supplied `state` Map in place — caller owns the lifecycle.
 */
export function tryConsume(
  state: Map<string, BucketState>,
  nowMs: number,
  key: string,
  cfg: RateLimitConfig,
): TryConsumeResult {
  let bucket = state.get(key);
  if (!bucket) {
    bucket = { tokens: cfg.limit, lastRefillMs: nowMs };
    state.set(key, bucket);
  }
  // Refill since last check.
  const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
  const refilled = Math.min(cfg.limit, bucket.tokens + elapsedSec * cfg.refillPerSec);
  bucket.tokens = refilled;
  bucket.lastRefillMs = nowMs;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }
  // Time until 1 token is available.
  const tokensNeeded = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil((tokensNeeded / cfg.refillPerSec) * 1000);
  return { allowed: false, retryAfterMs, remaining: 0 };
}

/**
 * Coarse eviction sweep — call periodically to drop buckets that have
 * been idle for `maxIdleMs`. Bounded memory growth in long-running
 * processes.
 */
export function evictIdle(state: Map<string, BucketState>, nowMs: number, maxIdleMs: number): number {
  let evicted = 0;
  for (const [k, v] of state) {
    if (nowMs - v.lastRefillMs > maxIdleMs) {
      state.delete(k);
      evicted++;
    }
  }
  return evicted;
}
