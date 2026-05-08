/**
 * Per-tenant rate limit interceptor.
 *
 *   @UseGuards(AuthGuard)
 *   @RateLimit({ limit: 60, refillPerSec: 1, scope: 'lookup' })
 *   @Post('foo')
 *
 * Behavior:
 *   - Reads `req.auth.orgId`. Without it (anonymous endpoint),
 *     pass-through.
 *   - Bucket key: `${scope}:${orgId}` so different routes don't share
 *     a quota.
 *   - On reject: 429 with `Retry-After` header (seconds, ceiling) plus
 *     `X-RateLimit-Limit` / `X-RateLimit-Remaining`.
 *
 * Storage is abstracted behind `RateLimitStore` (in-memory or Redis).
 * Selection happens at module init via env (REDIS_URL → Redis).
 */
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { defer, type Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { RateLimitStore } from './rate-limit-store';
import { OVERRIDE_RESOLVER_TOKEN, RATE_LIMIT_STORE_TOKEN } from './tokens';
import type { OverrideResolver } from './override-resolver';
import { MetricsService } from '../../observability/metrics.service';

// Re-export for back-compat with existing importers (health.controller.ts).
export { RATE_LIMIT_STORE_TOKEN } from './tokens';

export interface RateLimitConfig {
  /** Bucket capacity == max burst. */
  limit: number;
  /** Refill rate. 1 = sustained 1/sec; 1/60 = 1/min. */
  refillPerSec: number;
  /** Bucket scope. Different scopes → different buckets per org. */
  scope: string;
}

export const RATE_LIMIT_KEY = 'rate-limit';
export const RateLimit = (cfg: RateLimitConfig) => SetMetadata(RATE_LIMIT_KEY, cfg);

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE_TOKEN) private readonly store: RateLimitStore,
    @Optional() @Inject(OVERRIDE_RESOLVER_TOKEN) private readonly overrides?: OverrideResolver,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const baseCfg = this.reflector.getAllAndOverride<RateLimitConfig>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!baseCfg) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const orgId = (req as Request & { auth?: { orgId?: string } }).auth?.orgId;
    if (!orgId) return next.handle(); // anonymous → pass-through

    // Per-tenant override (if any) wins; otherwise use the decorator
    // defaults. Lookup is O(1) in-memory — no DB hit on the hot path.
    const override = this.overrides?.resolve(orgId, baseCfg.scope);
    const effectiveLimit = override?.limit ?? baseCfg.limit;
    const effectiveRefill = override?.refillPerSec ?? baseCfg.refillPerSec;

    // Defer the async consume so error+next paths compose with rxjs.
    return defer(() =>
      this.store.consume({
        key: `${baseCfg.scope}:${orgId}`,
        limit: effectiveLimit,
        refillPerSec: effectiveRefill,
      }),
    ).pipe(
      mergeMap((r) => {
        const res = ctx.switchToHttp().getResponse<Response>();
        res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
        if (!r.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
          res.setHeader('Retry-After', String(retryAfterSec));
          res.setHeader('X-RateLimit-Remaining', '0');
          this.metrics?.increment('billing_rules.rate_limit.rejected', 1, {
            scope: baseCfg.scope,
          });
          throw new HttpException(
            { code: 'RATE_LIMITED', scope: baseCfg.scope },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        res.setHeader('X-RateLimit-Remaining', String(r.remaining));
        return next.handle();
      }),
    );
  }
}
