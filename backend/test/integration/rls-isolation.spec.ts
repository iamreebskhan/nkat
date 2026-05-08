/**
 * RLS isolation — the core multi-tenant guarantee. Verifies that when the app
 * role is connected and `app.current_org_id` is unset (or set to a different
 * org), tenant-scoped tables return zero rows. Also verifies that a
 * cross-tenant write attempt is blocked.
 */
import { sql } from 'kysely';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';
import { runWithTenant } from '../../src/database/rls-transaction';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

integrationDescribe('RLS isolation (integration)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
    // Seed two orgs + one client_company per org (admin role bypasses RLS).
    await ctx.pool.query(
      `INSERT INTO org (id, name, slug, plan_tier) VALUES
        ($1, 'Acme RCM', 'acme', 'org'),
        ($2, 'Beta RCM', 'beta', 'org')
       ON CONFLICT (slug) DO NOTHING`,
      [ORG_A, ORG_B],
    );
    await ctx.pool.query(
      `INSERT INTO client_company (id, org_id, name, primary_state, specialties) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, 'Acme Hospice', 'OH', ARRAY['hospice']),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $2, 'Beta Oncology', 'NC', ARRAY['oncology'])
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B],
    );
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  it('app role with org-A context sees only org-A rows', async () => {
    const rows = await runWithTenant(ctx.appDb, ORG_A, (tx) =>
      tx.selectFrom('client_company').select(['name', 'primary_state']).execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme Hospice');
  });

  it('app role with org-B context sees only org-B rows', async () => {
    const rows = await runWithTenant(ctx.appDb, ORG_B, (tx) =>
      tx.selectFrom('client_company').select(['name']).execute(),
    );
    expect(rows.map((r) => r.name)).toEqual(['Beta Oncology']);
  });

  it('app role without app.current_org_id returns zero rows from tenant-scoped tables', async () => {
    const r = await sql<{ count: number }>`SELECT count(*)::int AS count FROM client_company`.execute(
      ctx.appDb,
    );
    expect(Number(r.rows[0].count)).toBe(0);
  });

  it('cross-tenant write is blocked (insert under org A while in org B context)', async () => {
    await expect(
      runWithTenant(ctx.appDb, ORG_B, (tx) =>
        tx
          .insertInto('client_company')
          .values({
            org_id: ORG_A,
            name: 'should fail',
            primary_state: 'OH',
            specialties: [],
            metadata: {},
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });

  it('reference data (payer_rule, code, ncci_ptp) is readable without org context', async () => {
    const r = await ctx.appDb.selectFrom('code').select('code').limit(1).execute();
    // Phase 1 seeded ~30 palliative codes; Phase 4 + 5 added BH + oncology + DMEPOS.
    expect(r.length).toBe(1);
  });
});
