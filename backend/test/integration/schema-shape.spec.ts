/**
 * Schema-shape integration tests — verify migrations + seeds applied cleanly,
 * RLS posture is correct on every relevant table, and reference data is
 * loaded.
 */
import { sql } from 'kysely';
import { startIntegrationContext, integrationDescribe, type IntegrationContext } from './harness';

integrationDescribe('Schema shape (integration)', () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    ctx = await startIntegrationContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.stop();
  }, 30_000);

  const TENANT_TABLES = [
    'org',
    'org_member',
    'client_company',
    'client_rulebook',
    'client_rule',
    'audit_log',
    'consent_record',
    'alert',
    'era_835_record',
    'denial_event',
    'abn_record',
    'rule_dispute',
    'client_doc_upload',
    'redaction_event',
    'webhook_subscription',
    'webhook_delivery',
    'cms_0057_pa_response',
    // Phase 11–24
    'subscription',
    'billing_event',
    'invite_token',
    'email_send',
    'idempotency_record',
    'synthesis_cache',
  ];

  const NON_RLS_PLATFORM_TABLES = [
    // Cross-tenant by design — see migration comments.
    'signup_attempt', // admin-only audit log
    'email_suppression', // SES-policy global suppression list
    'system_setting', // platform-global settings (cache version)
  ];
  const REFERENCE_TABLES = [
    'code',
    'modifier',
    'modifier_relationship',
    'pos',
    'icd10',
    'provider_taxonomy',
    'revenue_code',
    'ms_drg',
    'ndc',
    'hcc_mapping',
    'payer',
    'state',
    'product_line',
    'source_document',
    'document_chunk',
    'payer_rule',
    'ncci_ptp',
    'ncci_mue',
    'cob_rule',
    'documentation_requirement',
    'mhpaea_parity_pair',
    'dme_master_list',
    'wc_state_fee_schedule',
    'ihs_encounter_rate',
    'feature_flag',
    'asc_payment_indicator',
    'ub04_bill_type',
    'revenue_code_product_line',
    'extraction_candidate',
    'extraction_decision',
    'attestation_reverification',
  ];

  it.each(TENANT_TABLES)('%s has RLS enabled', async (tbl) => {
    const r = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ${tbl}
    `.execute(ctx.db);
    expect(r.rows[0]).toBeDefined();
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it.each(NON_RLS_PLATFORM_TABLES)(
    '%s has RLS DISABLED (platform-global by design)',
    async (tbl) => {
      const r = await sql<{ relrowsecurity: boolean }>`
      SELECT relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ${tbl}
    `.execute(ctx.db);
      expect(r.rows[0]).toBeDefined();
      expect(r.rows[0]?.relrowsecurity).toBe(false);
    },
  );

  it.each(REFERENCE_TABLES)('%s has RLS DISABLED (reference data is global)', async (tbl) => {
    const r = await sql<{ relrowsecurity: boolean }>`
      SELECT relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ${tbl}
    `.execute(ctx.db);
    expect(r.rows[0]?.relrowsecurity).toBe(false);
  });

  it('seed loaded states + product_lines + POS', async () => {
    const states = await sql<{ count: number }>`SELECT count(*)::int AS count FROM state`.execute(
      ctx.db,
    );
    const productLines = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM product_line`.execute(ctx.db);
    const posCodes = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pos`.execute(
      ctx.db,
    );
    expect(Number(states.rows[0].count)).toBeGreaterThanOrEqual(50);
    expect(Number(productLines.rows[0].count)).toBeGreaterThanOrEqual(20);
    expect(Number(posCodes.rows[0].count)).toBeGreaterThanOrEqual(40);
  });

  it('NC + SC + Ohio commercial payers are seeded with deterministic IDs', async () => {
    const r = await ctx.pool.query<{ name: string; states_served: string[] }>(
      `SELECT name, states_served FROM payer
       WHERE id IN (
         'a0000000-0000-4000-8000-000000000101',
         'a0000000-0000-4000-8000-000000000201',
         'a0000000-0000-4000-8000-000000000301'
       ) ORDER BY id`,
    );
    expect(r.rows.map((r) => r.name)).toEqual([
      'Healthy Blue North Carolina',
      'Absolute Total Care',
      'Aetna',
    ]);
  });

  it('hcc_mapping seed has v28 entries with known categories', async () => {
    const r = await ctx.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM hcc_mapping WHERE hcc_version = 'V28' AND effective_year = 2026`,
    );
    expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(20);
  });

  it('app.apply_tenant_rls function is installed', async () => {
    const r = await ctx.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'apply_tenant_rls'`,
    );
    expect(Number(r.rows[0].count)).toBe(1);
  });

  it('pgvector and citext extensions are enabled', async () => {
    const r = await ctx.pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'citext') ORDER BY extname`,
    );
    expect(r.rows.map((r) => r.extname)).toEqual(['citext', 'vector']);
  });
});
