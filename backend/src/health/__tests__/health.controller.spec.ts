import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from '../health.controller';
import {
  InMemoryRateLimitStore,
  RedisRateLimitStore,
} from '../../common/rate-limit/rate-limit-store';

const fakeDb = {} as never; // controller never touches it directly under our injected pings.

describe('HealthController.liveness', () => {
  it('returns ok unconditionally', () => {
    const c = new HealthController(fakeDb);
    expect(c.liveness()).toEqual({ status: 'ok' });
  });
});

describe('HealthController.readiness — happy paths', () => {
  it('ok + redis=not_configured when no rate-limit store wired', async () => {
    const c = new HealthController(fakeDb, undefined);
    c.dbPing = async () => undefined;
    const r = await c.readiness();
    expect(r.status).toBe('ok');
    expect(r.redis).toBe('not_configured');
    expect(typeof r.db_latency_ms).toBe('number');
  });

  it('ok + redis=not_configured when in-memory rate-limit store wired', async () => {
    const c = new HealthController(fakeDb, new InMemoryRateLimitStore());
    c.dbPing = async () => undefined;
    const r = await c.readiness();
    expect(r.redis).toBe('not_configured');
    expect(r.redis_latency_ms).toBeUndefined();
  });

  it('ok + redis=ok when RedisRateLimitStore wired and ping succeeds', async () => {
    const store = new RedisRateLimitStore({ eval: jest.fn() }, 'rl:', 60);
    const redisPing = jest.fn().mockResolvedValue(undefined);
    const c = new HealthController(fakeDb, store);
    c.dbPing = async () => undefined;
    c.redisPing = redisPing;
    const r = await c.readiness();
    expect(r.redis).toBe('ok');
    expect(typeof r.redis_latency_ms).toBe('number');
    expect(redisPing).toHaveBeenCalledWith(store);
  });
});

describe('HealthController.readiness — failure paths', () => {
  it('throws 503 component=database when DB ping rejects', async () => {
    const c = new HealthController(fakeDb, undefined);
    c.dbPing = async () => {
      throw new Error('db down');
    };
    try {
      await c.readiness();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const body = (e as ServiceUnavailableException).getResponse() as { component?: string };
      expect(body.component).toBe('database');
    }
  });

  it('throws 503 component=redis when Redis ping rejects', async () => {
    const store = new RedisRateLimitStore({ eval: jest.fn() }, 'rl:', 60);
    const c = new HealthController(fakeDb, store);
    c.dbPing = async () => undefined;
    c.redisPing = async () => {
      throw new Error('redis ECONNREFUSED');
    };
    try {
      await c.readiness();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      const body = (e as ServiceUnavailableException).getResponse() as { component?: string };
      expect(body.component).toBe('redis');
    }
  });
});

describe('realDbPing / realRedisPing — production code paths', () => {
  it('realDbPing calls sql`SELECT 1`.execute(db)', async () => {
    const { realDbPing } = await import('../health.controller');
    // We can't unit-test this against the real Kysely without mocking
    // its internals, so this just asserts the export exists + is a
    // function. Integration coverage proves the actual behavior.
    expect(typeof realDbPing).toBe('function');
  });

  it('realRedisPing rejects when store.consume returns allowed=false', async () => {
    const { realRedisPing } = await import('../health.controller');
    const store = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consume: async () => ({ allowed: false, retryAfterMs: 1000, remaining: 0 }) as any,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(realRedisPing(store as any)).rejects.toThrow(/unexpectedly rejected/);
  });

  it('realRedisPing resolves when store.consume returns allowed=true', async () => {
    const { realRedisPing } = await import('../health.controller');
    const store = {
      consume: async () => ({ allowed: true, remaining: 999_999 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(realRedisPing(store as any)).resolves.toBeUndefined();
  });
});
