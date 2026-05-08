/**
 * Integration tests for IdempotencyService against a real Postgres.
 * Exercises the three FindResult branches + the race-loser re-read on
 * `(org_id, key)` PK conflict.
 */
import { sql } from 'kysely';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';

const ORG = '11111111-1111-4111-8111-111111111111';

integrationDescribe('IdempotencyService (integration)', () => {
  let ctx: IntegrationContext;
  let svc: IdempotencyService;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    svc = new IdempotencyService(ctx.appDb);
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  beforeEach(async () => {
    await sql`DELETE FROM idempotency_record WHERE org_id = ${ORG}`.execute(ctx.db);
  });

  it('miss → store → cached: full happy path', async () => {
    const hash = 'a'.repeat(64);
    const key = 'idem-test-key-1';

    const r1 = await svc.findExisting(ORG, key, hash);
    expect(r1.kind).toBe('miss');

    await svc.store(ORG, key, hash, 200, { ok: true });

    const r2 = await svc.findExisting(ORG, key, hash);
    expect(r2.kind).toBe('cached');
    if (r2.kind === 'cached') {
      expect(r2.status).toBe(200);
      expect(r2.body).toEqual({ ok: true });
    }
  });

  it('cached + hash mismatch → conflict', async () => {
    const key = 'idem-test-key-2';
    await svc.store(ORG, key, 'a'.repeat(64), 200, { ok: true });
    const r = await svc.findExisting(ORG, key, 'b'.repeat(64));
    expect(r.kind).toBe('conflict');
  });

  it('expired row treated as miss', async () => {
    const key = 'idem-test-key-3';
    const hash = 'c'.repeat(64);
    await svc.store(ORG, key, hash, 200, { ok: true });
    // Force-expire the row.
    await sql`
      UPDATE idempotency_record SET expires_at = now() - interval '1 second'
      WHERE org_id = ${ORG} AND key = ${key}
    `.execute(ctx.db);
    const r = await svc.findExisting(ORG, key, hash);
    expect(r.kind).toBe('miss');
  });

  it('PK race: second store re-reads the winner', async () => {
    const key = 'idem-test-key-4';
    const hashA = 'd'.repeat(64);
    const hashB = 'e'.repeat(64);
    // First call wins, stores A.
    const winA = await svc.store(ORG, key, hashA, 200, { winner: 'A' });
    expect(winA).toEqual({ status: 200, body: { winner: 'A' } });
    // Second call with a different hash — INSERT will conflict on PK,
    // service falls through and re-reads the existing row (which has
    // hashA, not hashB). The race loser sees the winner's response.
    const winB = await svc.store(ORG, key, hashB, 200, { winner: 'B' });
    expect(winB).toEqual({ status: 200, body: { winner: 'A' } });
  });

  it('keys are scoped per (org_id, key) — different orgs never collide', async () => {
    const ORG2 = '22222222-2222-4222-8222-222222222222';
    // Need to insert a peer org row before we can use it (FK constraint
    // on idempotency_record.org_id).
    await sql`
      INSERT INTO org (id, name, slug, plan_tier, status)
      VALUES (${ORG2}, 'peer', 'peer-org-' || substr(${ORG2}, 1, 8), 'team', 'active')
      ON CONFLICT DO NOTHING
    `.execute(ctx.db);

    const key = 'cross-org-key';
    const hash = 'f'.repeat(64);
    await svc.store(ORG, key, hash, 200, { in: 'org1' });
    await svc.store(ORG2, key, hash, 200, { in: 'org2' });
    const r1 = await svc.findExisting(ORG, key, hash);
    const r2 = await svc.findExisting(ORG2, key, hash);
    expect(r1.kind).toBe('cached');
    expect(r2.kind).toBe('cached');
    if (r1.kind === 'cached') expect(r1.body).toEqual({ in: 'org1' });
    if (r2.kind === 'cached') expect(r2.body).toEqual({ in: 'org2' });
  });
});
