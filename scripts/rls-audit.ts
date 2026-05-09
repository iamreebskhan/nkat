/**
 * RLS audit — fail-loud check that every tenant-scoped table has
 * row-level security enabled + at least one policy attached.
 *
 * Run before every prod deploy:
 *   npm run rls:audit
 *
 * Exits 0 on clean. Exits 1 with a list of unprotected tables otherwise.
 *
 * Pre-launch checklist gate per pallio_complete_vision_v3 §15.1.
 */
import { prisma } from "@/lib/db";

/**
 * Allow-list of tables that are intentionally NOT tenant-scoped.
 * Reference data: codes, payers, CMS rules, taxonomies.
 */
const NON_TENANT_TABLES = new Set([
  "cpt_code",
  "icd10_code",
  "carc_code",
  "rarc_code",
  "place_of_service",
  "modifier",
  "taxonomy",
  "us_state",
  "payer",
  "payer_alias",
  "cms_final_rule",
  "cms_lcd",
  "cms_ncd",
  "cms_pa_list",
  "cms_pa_list_code",
  "fee_schedule_year",
  "fee_schedule_row",
  "schema_migration",
  "rate_limit_bucket",
  "idempotency_key",
  "_prisma_migrations",
]);

interface TableInfo {
  table_name: string;
  rls_enabled: boolean;
  policy_count: bigint;
  has_org_id: boolean;
}

async function main(): Promise<void> {
  const rows = await prisma.$queryRaw<TableInfo[]>`
    SELECT
      t.table_name,
      c.relrowsecurity AS rls_enabled,
      (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = t.table_name) AS policy_count,
      EXISTS(
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_name = t.table_name AND col.column_name = 'org_id'
      ) AS has_org_id
    FROM information_schema.tables t
    JOIN pg_class c ON c.relname = t.table_name
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
    ORDER BY t.table_name
  `;

  const offenders: string[] = [];
  const tenantTables: string[] = [];
  for (const row of rows) {
    if (NON_TENANT_TABLES.has(row.table_name)) continue;
    if (!row.has_org_id) continue;
    tenantTables.push(row.table_name);
    if (!row.rls_enabled || Number(row.policy_count) === 0) {
      offenders.push(
        `${row.table_name}  rls=${row.rls_enabled ? "on" : "OFF"} policies=${row.policy_count}`,
      );
    }
  }

  await prisma.$disconnect();

  console.log(`Scanned ${tenantTables.length} tenant tables.`);
  if (offenders.length === 0) {
    console.log("RLS audit: PASS — every tenant table has RLS enabled + policy.");
    process.exit(0);
  }

  console.error(`RLS audit: FAIL — ${offenders.length} table(s) unprotected:\n`);
  for (const o of offenders) console.error("  - " + o);
  console.error("\nFix: enable RLS + add a tenant_isolation policy per db/migrations/0007_rls.sql.");
  process.exit(1);
}

main().catch((err) => {
  console.error("RLS audit script crashed:", err);
  process.exit(2);
});
