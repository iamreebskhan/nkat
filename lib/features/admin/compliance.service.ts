/**
 * Live HIPAA / RLS / retention probes for /admin/compliance.
 *
 * Each probe is independent and returns a {ok, detail} pair. The page
 * renders all probes as a single status board. Failures here don't
 * 5xx — the whole point is to surface the bad ones.
 */
import { prisma } from "@/lib/db";

export interface ComplianceCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const NON_TENANT_TABLES = new Set([
  "cpt_code", "icd10_code", "carc_code", "rarc_code", "place_of_service",
  "modifier", "taxonomy", "us_state", "payer", "payer_alias",
  "cms_final_rule", "cms_lcd", "cms_ncd", "cms_pa_list", "cms_pa_list_code",
  "fee_schedule_year", "fee_schedule_row", "schema_migration",
  "rate_limit_bucket", "idempotency_key", "_prisma_migrations",
]);

export async function runComplianceChecks(): Promise<ComplianceCheck[]> {
  const checks: ComplianceCheck[] = [];

  // 1) RLS — every tenant table has rls + policy
  try {
    const rows = await prisma.$queryRaw<
      { table_name: string; rls_enabled: boolean; policy_count: bigint; has_org_id: boolean }[]
    >`
      SELECT t.table_name, c.relrowsecurity AS rls_enabled,
             (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = t.table_name) AS policy_count,
             EXISTS(SELECT 1 FROM information_schema.columns col
                    WHERE col.table_name = t.table_name AND col.column_name = 'org_id') AS has_org_id
      FROM information_schema.tables t
      JOIN pg_class c ON c.relname = t.table_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    `;
    const offenders = rows.filter(
      (r) =>
        !NON_TENANT_TABLES.has(r.table_name) &&
        r.has_org_id &&
        (!r.rls_enabled || Number(r.policy_count) === 0),
    );
    checks.push({
      id: "rls",
      label: "RLS on every tenant table",
      ok: offenders.length === 0,
      detail:
        offenders.length === 0
          ? `All tenant tables have RLS + at least 1 policy (${rows.filter((r) => r.has_org_id && !NON_TENANT_TABLES.has(r.table_name)).length} scanned).`
          : `Unprotected: ${offenders.map((o) => o.table_name).join(", ")}`,
    });
  } catch (err) {
    checks.push({
      id: "rls",
      label: "RLS on every tenant table",
      ok: false,
      detail: err instanceof Error ? err.message : "RLS audit failed",
    });
  }

  // 2) Retention trigger present on audit_log
  try {
    const rows = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_log'::regclass
        AND tgname = 'audit_log_retention_guard'
    `;
    checks.push({
      id: "audit_retention",
      label: "Audit log 6-year retention trigger",
      ok: rows.length === 1,
      detail:
        rows.length === 1
          ? "prevent_premature_audit_delete trigger active on audit_log."
          : "Trigger missing — re-apply 0033 migration.",
    });
  } catch (err) {
    checks.push({
      id: "audit_retention",
      label: "Audit log 6-year retention trigger",
      ok: false,
      detail: err instanceof Error ? err.message : "probe failed",
    });
  }

  // 3) PHI access log retention trigger
  try {
    const rows = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'phi_access_log'::regclass
        AND tgname = 'phi_access_log_retention_guard'
    `;
    checks.push({
      id: "phi_retention",
      label: "PHI access log retention trigger",
      ok: rows.length === 1,
      detail:
        rows.length === 1
          ? "phi_access_log retention trigger active."
          : "Trigger missing.",
    });
  } catch (err) {
    checks.push({
      id: "phi_retention",
      label: "PHI access log retention trigger",
      ok: false,
      detail: err instanceof Error ? err.message : "probe failed",
    });
  }

  // 4) pgcrypto helpers exist
  try {
    const rows = await prisma.$queryRaw<{ proname: string }[]>`
      SELECT proname FROM pg_proc
      WHERE proname IN ('encrypt_phi', 'decrypt_phi')
    `;
    checks.push({
      id: "pgcrypto_helpers",
      label: "pgcrypto helpers (encrypt_phi / decrypt_phi)",
      ok: rows.length === 2,
      detail:
        rows.length === 2
          ? "Both helpers compiled. PALLIO_PHI_KEY env must be set at runtime."
          : `Missing: only ${rows.length}/2 helpers found.`,
    });
  } catch (err) {
    checks.push({
      id: "pgcrypto_helpers",
      label: "pgcrypto helpers",
      ok: false,
      detail: err instanceof Error ? err.message : "probe failed",
    });
  }

  // 5) Audit log freshness — at least one row in the last 24h
  try {
    const rows = await prisma.$queryRaw<{ recent: bigint; total: bigint }[]>`
      SELECT
        COUNT(*) FILTER (WHERE occurred_at > now() - interval '24 hours') AS recent,
        COUNT(*) AS total
      FROM audit_log
    `;
    const r = rows[0]!;
    checks.push({
      id: "audit_fresh",
      label: "Audit log freshness (24h)",
      ok: Number(r.recent) > 0 || Number(r.total) === 0,
      detail: `${r.recent} rows in last 24h · ${r.total} total. (Empty is OK pre-launch.)`,
    });
  } catch (err) {
    checks.push({
      id: "audit_fresh",
      label: "Audit log freshness (24h)",
      ok: false,
      detail: err instanceof Error ? err.message : "probe failed",
    });
  }

  // 6) AMA license token — env present?
  const amaSet = Boolean(process.env.AMA_LICENSE_TOKEN);
  checks.push({
    id: "ama_token",
    label: "AMA CPT license token",
    ok: amaSet,
    detail: amaSet
      ? "AMA_LICENSE_TOKEN set — descriptors visible per §15.1."
      : "Not set — CPT short_descriptor is redacted (gated). Set when contract signed.",
  });

  // 7) PHI key — for pgcrypto
  const phiKey = process.env.PALLIO_PHI_KEY ?? "";
  checks.push({
    id: "phi_key",
    label: "PALLIO_PHI_KEY (≥32 chars)",
    ok: phiKey.length >= 32,
    detail:
      phiKey.length >= 32
        ? "Key present. Rotate quarterly per deploy runbook."
        : "Not set or too short — pgcrypto helpers will throw at runtime.",
  });

  return checks;
}
