/**
 * Verify migration 0021's auto-invalidation triggers fire on writes to
 * the rule-source tables. Statement-level: one bump per statement, not
 * one per row.
 *
 * The tests UPDATE existing seed rows rather than INSERTing fresh ones,
 * because the rule-source schemas have many required columns that vary
 * across migrations. Updating a known-good row sidesteps that and
 * isolates the test to the trigger behavior we actually care about.
 */
import { sql } from 'kysely';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';

integrationDescribe('Cache invalidation triggers (integration)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  async function readVersion(): Promise<number> {
    const r = await sql<{ v: number }>`
      SELECT (value)::int AS v FROM system_setting WHERE key = 'synthesis_cache.version'
    `.execute(ctx.db);
    return Number(r.rows[0]?.v ?? 0);
  }

  it('30 triggers (10 tables × 3 ops) are installed', async () => {
    const r = await sql<{ tgname: string }>`
      SELECT tgname FROM pg_trigger
      WHERE tgname LIKE '%bump_cache%'
        AND NOT tgisinternal
      ORDER BY tgname
    `.execute(ctx.db);
    expect(r.rows.length).toBe(30);
  });

  it('seed migration 0020 inserted the cache version row', async () => {
    const v = await readVersion();
    expect(v).toBeGreaterThanOrEqual(1);
  });

  it('UPDATE on payer_rule bumps the version exactly once (statement-level)', async () => {
    const before = await readVersion();
    // No-op self-update against a real seeded row. Triggers fire on
    // every UPDATE (Postgres doesn't suppress self-updates), so the
    // version should bump even though no column actually changed.
    const r = await sql<{ id: string }>`SELECT id FROM payer_rule LIMIT 1`.execute(ctx.db);
    if (r.rows.length === 0) {
      // Skip — no seeded payer_rule rows in this env.
      return;
    }
    await sql`
      UPDATE payer_rule SET coverage_status = coverage_status WHERE id = ${r.rows[0].id}
    `.execute(ctx.db);
    const after = await readVersion();
    expect(after - before).toBe(1);
  });

  it('UPDATE WHERE FALSE does NOT bump (WHEN guard)', async () => {
    const before = await readVersion();
    await sql`UPDATE payer_rule SET code = code WHERE FALSE`.execute(ctx.db);
    const after = await readVersion();
    expect(after).toBe(before);
  });

  it('multi-row UPDATE bumps exactly once (statement-level, not row-level)', async () => {
    const before = await readVersion();
    const r = await sql<{ id: string }>`SELECT id FROM payer_rule LIMIT 5`.execute(ctx.db);
    if (r.rows.length < 2) return;
    const ids = r.rows.map((x) => x.id);
    await sql`UPDATE payer_rule SET code = code WHERE id = ANY(${ids})`.execute(ctx.db);
    const after = await readVersion();
    // Exactly +1 regardless of N rows touched.
    expect(after - before).toBe(1);
  });

  it('writes to a non-monitored table (audit_log) do NOT bump', async () => {
    const before = await readVersion();
    await sql`
      INSERT INTO audit_log (org_id, action, target_type, target_id, payload)
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'test.no_bump',
        'system_setting',
        NULL,
        '{}'::jsonb
      )
    `.execute(ctx.db).catch(() => null);
    const after = await readVersion();
    expect(after).toBe(before);
  });

  it('SET session_replication_role = replica skips triggers', async () => {
    const before = await readVersion();
    const r = await sql<{ id: string }>`SELECT id FROM payer_rule LIMIT 1`.execute(ctx.db);
    if (r.rows.length === 0) return;
    // session_replication_role is per-session; we run inside a
    // transaction so we use SET LOCAL.
    await ctx.db.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(tx);
      await sql`UPDATE payer_rule SET code = code WHERE id = ${r.rows[0].id}`.execute(tx);
    });
    const after = await readVersion();
    expect(after).toBe(before);
  });
});
