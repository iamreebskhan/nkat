import { Module, type DynamicModule, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  type RateLimitStore,
  type RedisLike,
} from './rate-limit-store';
import { RateLimitInterceptor } from './rate-limit.interceptor';
import { OverrideResolver } from './override-resolver';
import { DB_TOKEN } from '../../database/database.module';
import type { Db } from '../../database/db';
import { OVERRIDE_RESOLVER_TOKEN, RATE_LIMIT_STORE_TOKEN } from './tokens';

// Re-export so callers that previously imported from this file keep working.
export { OVERRIDE_RESOLVER_TOKEN, RATE_LIMIT_STORE_TOKEN } from './tokens';

export interface RateLimitModuleOptions {
  /**
   * Pass a Redis-shaped client (eval) to use distributed bucket state.
   * When omitted, the module installs the in-memory store (per-task
   * buckets — fine for small ECS fleets).
   */
  redis?: RedisLike;
  /** Redis key prefix when redis is configured. */
  redisKeyPrefix?: string;
  /** Bucket idle TTL in seconds (Redis only). Default 1800. */
  redisTtlSec?: number;
  /** Override-cache refresh interval. Default 30s. 0 disables. */
  overrideRefreshIntervalMs?: number;
}

/**
 * Lifecycle wrapper around `OverrideResolver` so Nest starts/stops it.
 * Implementing OnApplicationBootstrap (NOT OnModuleInit) because the
 * DB connection isn't ready at module-init time in some configs.
 */
class OverrideResolverLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(OverrideResolverLifecycle.name);
  constructor(public readonly resolver: OverrideResolver) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.resolver.start();
      this.log.log('rate-limit override resolver started');
    } catch (e) {
      // A startup failure here must not crash the app — overrides are
      // an enhancement, not the security boundary. Log + continue.
      this.log.warn(
        `override resolver failed to start (continuing without): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  onApplicationShutdown(): void {
    this.resolver.stop();
  }
}

@Module({})
export class RateLimitModule {
  /**
   * Default — in-memory store. Behavior unchanged from Phase 30 in
   * the absence of Redis configuration.
   */
  static forRoot(opts: RateLimitModuleOptions = {}): DynamicModule {
    const log = new Logger(RateLimitModule.name);
    const store: RateLimitStore = opts.redis
      ? new RedisRateLimitStore(
          opts.redis,
          opts.redisKeyPrefix ?? 'br:rl:',
          opts.redisTtlSec ?? 1800,
        )
      : new InMemoryRateLimitStore();
    log.log(`rate-limit store: ${opts.redis ? 'redis' : 'in-memory'}`);
    return {
      module: RateLimitModule,
      global: true,
      providers: [
        { provide: RATE_LIMIT_STORE_TOKEN, useValue: store },
        {
          provide: OVERRIDE_RESOLVER_TOKEN,
          inject: [DB_TOKEN],
          useFactory: (db: Db) =>
            new OverrideResolver(db, {
              refreshIntervalMs: opts.overrideRefreshIntervalMs,
            }),
        },
        {
          provide: OverrideResolverLifecycle,
          inject: [OVERRIDE_RESOLVER_TOKEN],
          useFactory: (r: OverrideResolver) => new OverrideResolverLifecycle(r),
        },
        RateLimitInterceptor,
      ],
      exports: [
        RateLimitInterceptor,
        RATE_LIMIT_STORE_TOKEN,
        OVERRIDE_RESOLVER_TOKEN,
      ],
    };
  }
}
