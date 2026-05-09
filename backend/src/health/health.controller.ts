import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { RATE_LIMIT_STORE_TOKEN } from '../common/rate-limit/rate-limit.interceptor';
import { RedisRateLimitStore, type RateLimitStore } from '../common/rate-limit/rate-limit-store';
import { DB_TOKEN } from '../database/database.module';
import type { Db } from '../database/db';

interface ReadyzResponse {
  status: 'ok';
  db_latency_ms: number;
  redis_latency_ms?: number;
  redis: 'ok' | 'not_configured';
}

/**
 * The DB + Redis ping bodies are extracted so unit tests can swap them
 * in (the Nest factory below uses the real implementations). This keeps
 * the controller pure orchestration + makes coverage of the failure
 * branches achievable without Kysely-internal mocking.
 */
export type DbPing = (db: Db) => Promise<void>;
export type RedisPing = (store: RateLimitStore) => Promise<void>;

export const realDbPing: DbPing = async (db) => {
  await sql`SELECT 1`.execute(db);
};

export const realRedisPing: RedisPing = async (store) => {
  const r = await store.consume({
    key: 'health',
    limit: 1_000_000,
    refillPerSec: 0,
  });
  if (!r.allowed) {
    throw new Error('rate-limit health probe unexpectedly rejected');
  }
};

@ApiTags('health')
@Controller()
export class HealthController {
  // The DbPing/RedisPing fields are NOT @Inject() / @Optional() —
  // they're regular instance fields with defaults. Nest's DI never
  // sees them because we don't list them as constructor injections;
  // unit tests assign via the property bag below.
  dbPing: DbPing = realDbPing;
  redisPing: RedisPing = realRedisPing;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    @Optional() @Inject(RATE_LIMIT_STORE_TOKEN) private readonly rateLimitStore?: RateLimitStore,
  ) {}

  @Get('healthz')
  @ApiOperation({ summary: 'Liveness probe' })
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  @ApiOperation({ summary: 'Readiness probe — DB + (when wired) Redis roundtrip' })
  async readiness(): Promise<ReadyzResponse> {
    const dbStart = Date.now();
    try {
      await this.dbPing(this.db);
    } catch (err) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        component: 'database',
        detail: (err as Error).message,
      });
    }
    const dbLatency = Date.now() - dbStart;

    const out: ReadyzResponse = {
      status: 'ok',
      db_latency_ms: dbLatency,
      redis: 'not_configured',
    };
    if (this.rateLimitStore instanceof RedisRateLimitStore) {
      const redisStart = Date.now();
      try {
        await this.redisPing(this.rateLimitStore);
      } catch (err) {
        throw new ServiceUnavailableException({
          status: 'unavailable',
          component: 'redis',
          detail: (err as Error).message,
        });
      }
      out.redis_latency_ms = Date.now() - redisStart;
      out.redis = 'ok';
    }
    return out;
  }

  /**
   * Public status JSON — what status.example.com renders. Distinct
   * from /readyz: fail-soft (always 200 with per-component states),
   * cacheable, includes the build sha + uptime + recent-incidents
   * count for the operator dashboard.
   */
  @Get('status')
  @ApiOperation({ summary: 'Public service status (fail-soft, cacheable)' })
  async status(): Promise<StatusResponse> {
    const components: ComponentStatus[] = [];

    let dbOk = true;
    const dbStart = Date.now();
    try {
      await this.dbPing(this.db);
      components.push({
        name: 'database',
        status: 'operational',
        latency_ms: Date.now() - dbStart,
      });
    } catch (e) {
      dbOk = false;
      components.push({
        name: 'database',
        status: 'major_outage',
        latency_ms: Date.now() - dbStart,
        detail: (e as Error).message,
      });
    }

    if (this.rateLimitStore instanceof RedisRateLimitStore) {
      const t = Date.now();
      try {
        await this.redisPing(this.rateLimitStore);
        components.push({ name: 'redis', status: 'operational', latency_ms: Date.now() - t });
      } catch (e) {
        components.push({
          name: 'redis',
          status: 'partial_outage',
          latency_ms: Date.now() - t,
          detail: (e as Error).message,
        });
      }
    } else {
      components.push({ name: 'redis', status: 'not_configured' });
    }

    const overall: StatusResponse['status'] = dbOk
      ? components.some((c) => c.status === 'major_outage')
        ? 'major_outage'
        : components.some((c) => c.status === 'partial_outage')
          ? 'partial_outage'
          : 'operational'
      : 'major_outage';

    return {
      status: overall,
      version: process.env.GIT_SHA?.slice(0, 8) ?? 'unknown',
      uptime_sec: Math.floor(process.uptime()),
      checked_at: new Date().toISOString(),
      components,
    };
  }
}

export interface ComponentStatus {
  name: string;
  status: 'operational' | 'partial_outage' | 'major_outage' | 'not_configured';
  latency_ms?: number;
  detail?: string;
}

export interface StatusResponse {
  status: 'operational' | 'partial_outage' | 'major_outage';
  version: string;
  uptime_sec: number;
  checked_at: string;
  components: ComponentStatus[];
}
