/**
 * Integration tests for CacheVersionService against a real Postgres.
 * Exercises:
 *   - read-with-TTL caching
 *   - atomic increment (concurrent bumps each get distinct return)
 *   - in-process cache invalidation on bump (read-your-own-write)
 */
import { sql } from 'kysely';
import { CacheVersionService } from '../../src/synthesis/cache-version.service';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';

integrationDescribe('CacheVersionService (integration)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    // Ensure the byUserId used in 'updated_by_user_id + note are persisted'
    // exists — system_setting.updated_by_user_id has an FK to app_user.
    await sql`
      INSERT INTO app_user (id, email, full_name, status)
      VALUES ('00000000-0000-4000-8000-000000000001',
              'cache-version-test@example.com', 'Cache Version Test', 'active')
      ON CONFLICT (id) DO NOTHING
    `.execute(ctx.db);
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  beforeEach(async () => {
    // Re-seed to a known state so each test starts from the same baseline.
    await sql`
      UPDATE system_setting SET value = '1'::jsonb, updated_at = now()
      WHERE key = 'synthesis_cache.version'
    `.execute(ctx.db);
  });

  it('current() reads the seeded version', async () => {
    const svc = new CacheVersionService(ctx.db);
    const v = await svc.current();
    expect(v).toBe(1);
  });

  it('bump() increments atomically + invalidates the in-process cache', async () => {
    const svc = new CacheVersionService(ctx.db);
    await svc.current(); // populate the in-process cache
    const newV = await svc.bump({ note: 'integration-test' });
    expect(newV).toBe(2);
    // Read-your-own-write: the bumping caller's next current() returns
    // the bumped value, not the cached pre-bump one.
    const after = await svc.current();
    expect(after).toBe(2);
  });

  it('two concurrent bumps each get distinct return values', async () => {
    const svc1 = new CacheVersionService(ctx.db);
    const svc2 = new CacheVersionService(ctx.db);
    const [a, b] = await Promise.all([
      svc1.bump({ note: 'race-1' }),
      svc2.bump({ note: 'race-2' }),
    ]);
    // Order-independent: one is N+1, the other is N+2; sum = (N+1) + (N+2) = 2N+3.
    // From baseline N=1: sum should be 5.
    expect(a + b).toBe(5);
    expect(new Set([a, b])).toEqual(new Set([2, 3]));
  });

  it('TTL cache: stale read holds for ~60s', async () => {
    const svc = new CacheVersionService(ctx.db);
    await svc.current(); // populate
    // External bump (different service instance) — our svc's in-process
    // cache should hold the old value until TTL elapses or we
    // explicitly reset.
    await sql`
      UPDATE system_setting
         SET value = '99'::jsonb, updated_at = now()
       WHERE key = 'synthesis_cache.version'
    `.execute(ctx.db);
    const stillStale = await svc.current();
    expect(stillStale).toBe(1);
    // After explicit reset, fresh read picks up the new value.
    svc._resetCache();
    expect(await svc.current()).toBe(99);
  });

  it('updated_by_user_id + note are persisted', async () => {
    const svc = new CacheVersionService(ctx.db);
    await svc.bump({
      byUserId: '00000000-0000-4000-8000-000000000001',
      note: 'rule-deploy-q3',
    });
    const r = await sql<{ uid: string | null; note: string | null }>`
      SELECT updated_by_user_id::text AS uid, note FROM system_setting
      WHERE key = 'synthesis_cache.version'
    `.execute(ctx.db);
    expect(r.rows[0].uid).toBe('00000000-0000-4000-8000-000000000001');
    expect(r.rows[0].note).toBe('rule-deploy-q3');
  });
});
