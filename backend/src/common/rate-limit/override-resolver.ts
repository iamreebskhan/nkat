/**
 * Per-tenant rate-limit override resolver.
 *
 * The interceptor's hot path can't run a DB query per request (we're
 * trying to cap requests, not amplify them). Instead the resolver:
 *
 *   - Holds an in-memory `(orgId, scope) → override` cache.
 *   - Refreshes from `rate_limit_override` every `refreshIntervalMs`
 *     (default 30 seconds) on a background timer.
 *   - Honors row-level `expires_at` — expired rows aren't returned.
 *   - Tolerates DB failures: a refresh that throws is logged but does
 *     not nuke the existing cache (stale-but-available beats no-cache).
 *
 * Lookup is synchronous + O(1).
 *
 * The pure logic (filtering expired rows; building the lookup map) is
 * exported separately so unit tests don't need a DB.
 */
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Db } from '../../database/db';

export interface RateLimitOverride {
  limit: number;
  refillPerSec: number;
}

export interface OverrideRow {
  org_id: string;
  scope: string;
  limit: number;
  refill_per_sec: number; // already coerced to number in the loader
  expires_at: Date | null;
}

/**
 * Pure: build an in-memory lookup of `${orgId}:${scope} → override`
 * from a list of rows, dropping anything whose expires_at has passed.
 */
export function buildOverrideMap(
  rows: OverrideRow[],
  nowMs: number,
): Map<string, RateLimitOverride> {
  const out = new Map<string, RateLimitOverride>();
  for (const r of rows) {
    if (r.expires_at !== null && r.expires_at.getTime() <= nowMs) continue;
    out.set(`${r.org_id}:${r.scope}`, {
      limit: r.limit,
      refillPerSec: r.refill_per_sec,
    });
  }
  return out;
}

/**
 * Pure: resolve effective limit/refill for a scope. If an override
 * exists, it wins. Otherwise return undefined (caller falls back to
 * decorator defaults).
 */
export function resolveOverride(
  map: Map<string, RateLimitOverride>,
  orgId: string,
  scope: string,
): RateLimitOverride | undefined {
  return map.get(`${orgId}:${scope}`);
}

export interface OverrideResolverOptions {
  /** Default 30 seconds. Set to 0 to disable background refresh (tests). */
  refreshIntervalMs?: number;
  nowFn?: () => number;
}

export class OverrideResolver {
  private readonly log = new Logger(OverrideResolver.name);
  private map: Map<string, RateLimitOverride> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshIntervalMs: number;
  private readonly nowFn: () => number;

  constructor(
    private readonly db: Db,
    opts: OverrideResolverOptions = {},
  ) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 30_000;
    this.nowFn = opts.nowFn ?? Date.now;
  }

  /**
   * Initial load + start background timer. Idempotent.
   */
  async start(): Promise<void> {
    await this.refresh();
    if (this.refreshIntervalMs > 0 && this.timer === null) {
      this.timer = setInterval(() => {
        void this.refresh().catch((e) => {
          this.log.warn(
            `override refresh failed (keeping stale cache): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
      }, this.refreshIntervalMs);
      // Don't keep the event loop alive solely on this timer.
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Synchronous lookup used in the interceptor hot path.
   */
  resolve(orgId: string, scope: string): RateLimitOverride | undefined {
    return resolveOverride(this.map, orgId, scope);
  }

  /**
   * Force a refresh from DB. Used by the admin controller after a
   * write so the new override is visible immediately.
   */
  async refresh(): Promise<void> {
    // Cross-tenant read via SECURITY DEFINER function — RLS would
    // otherwise scope to a single org per call. See migration 0023.
    const result = await sql<{
      org_id: string;
      scope: string;
      limit: number;
      refill_per_sec: string | number;
      expires_at: Date | null;
    }>`SELECT org_id, scope, "limit", refill_per_sec, expires_at
       FROM app.list_active_rate_limit_overrides()`.execute(this.db);
    const coerced: OverrideRow[] = result.rows.map((r) => ({
      org_id: r.org_id,
      scope: r.scope,
      limit: r.limit,
      refill_per_sec:
        typeof r.refill_per_sec === 'string' ? Number(r.refill_per_sec) : r.refill_per_sec,
      expires_at: r.expires_at,
    }));
    const next = buildOverrideMap(coerced, this.nowFn());
    this.map = next;
    this.log.debug?.(`refreshed ${next.size} override(s).`);
  }

  /** For tests. */
  _setMap(m: Map<string, RateLimitOverride>): void {
    this.map = m;
  }
}
