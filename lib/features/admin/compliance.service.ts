/**
 * Live HIPAA / RLS / retention probes.
 *
 * Two boards read these. /admin/compliance (runComplianceChecks) is the
 * platform operator's: every probe, with table names, env-var names and
 * integration keys, some read across tenants. The audit page's Safeguards
 * card (runOrgSafeguardChecks, audit R24) is an org admin's: the
 * data-protection subset, scoped to that org, in customer wording.
 *
 * Each probe is independent and returns a {ok, detail} pair. Failures here
 * don't 5xx — the whole point is to surface the bad ones.
 */
import { prisma, withBreakglass, withOrgContext } from "@/lib/db";
import { bypassSentence, bypassesRls, connectionRole } from "@/lib/db-role";
import { hasAmaLicense } from "@/lib/features/billing/code.service";

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

/**
 * Every public table with an org_id column, and the names of those without
 * RLS enabled or without a policy. Catalog reads only, no tenant data.
 */
async function tenantRlsCoverage(): Promise<{ scanned: number; offenders: string[] }> {
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
  const tenant = rows.filter((r) => r.has_org_id && !NON_TENANT_TABLES.has(r.table_name));
  return {
    scanned: tenant.length,
    offenders: tenant
      .filter((r) => !r.rls_enabled || Number(r.policy_count) === 0)
      .map((r) => r.table_name),
  };
}

/** Is the retention guard trigger installed on this log table? */
async function retentionGuardPresent(table: "audit_log" | "phi_access_log"): Promise<boolean> {
  const rows =
    table === "audit_log"
      ? await prisma.$queryRaw<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'audit_log'::regclass
            AND tgname = 'audit_log_retention_guard'
        `
      : await prisma.$queryRaw<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'phi_access_log'::regclass
            AND tgname = 'phi_access_log_retention_guard'
        `;
  return rows.length === 1;
}

/**
 * Can the role the app connects as empty this log with TRUNCATE? That fires
 * no row trigger and ignores RLS, so the retention guard alone does not stop
 * it (0104 revokes it).
 */
async function logTruncatable(table: "audit_log" | "phi_access_log"): Promise<boolean> {
  const rows =
    table === "audit_log"
      ? await prisma.$queryRaw<{ t: boolean }[]>`
          SELECT has_table_privilege(current_user, 'audit_log', 'TRUNCATE') AS t
        `
      : await prisma.$queryRaw<{ t: boolean }[]>`
          SELECT has_table_privilege(current_user, 'phi_access_log', 'TRUNCATE') AS t
        `;
  return rows[0]?.t === true;
}

export async function runComplianceChecks(): Promise<ComplianceCheck[]> {
  const checks: ComplianceCheck[] = [];

  // 0) The app's own connection is subject to RLS. Every policy below is moot
  // on a superuser or BYPASSRLS connection.
  try {
    const role = await connectionRole();
    const bypass = bypassesRls(role);
    checks.push({
      id: "rls_enforced",
      label: "App connection enforces RLS",
      ok: !bypass,
      detail: bypass
        ? bypassSentence(role)
        : `The app connects as "${role.role}", which row-level security applies to.`,
    });
  } catch (err) {
    checks.push({
      id: "rls_enforced",
      label: "App connection enforces RLS",
      ok: false,
      detail: `Probe failed: ${(err as Error).message}`,
    });
  }

  // 1) RLS — every tenant table has rls + policy
  try {
    const { scanned, offenders } = await tenantRlsCoverage();
    checks.push({
      id: "rls",
      label: "RLS on every tenant table",
      ok: offenders.length === 0,
      detail:
        offenders.length === 0
          ? `All tenant tables have RLS + at least 1 policy (${scanned} scanned).`
          : `Unprotected: ${offenders.join(", ")}`,
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
    const present = await retentionGuardPresent("audit_log");
    const truncatable = present && (await logTruncatable("audit_log"));
    checks.push({
      id: "audit_retention",
      label: "Audit log 6-year retention trigger",
      ok: present && !truncatable,
      detail: !present
        ? "Trigger missing — re-apply 0033 migration."
        : truncatable
          ? "Trigger active, but the app role holds TRUNCATE on audit_log, which bypasses it — apply 0104."
          : "prevent_premature_audit_delete trigger active on audit_log; the app role holds no TRUNCATE.",
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
    const present = await retentionGuardPresent("phi_access_log");
    const truncatable = present && (await logTruncatable("phi_access_log"));
    checks.push({
      id: "phi_retention",
      label: "PHI access log retention trigger",
      ok: present && !truncatable,
      detail: !present
        ? "Trigger missing."
        : truncatable
          ? "Trigger active, but the app role holds TRUNCATE on phi_access_log, which bypasses it — apply 0104."
          : "phi_access_log retention trigger active; the app role holds no TRUNCATE.",
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

  // 4b) PHI encryption coverage — the helpers existing is not the same as
  // the _enc companions actually being populated (0034 dual-write). Counts
  // plaintext member ids that lack ciphertext; non-zero means the backfill
  // (scripts/backfill-phi-encryption.sql) hasn't run or the key is unset.
  try {
    // Cross-tenant read via withBreakglass (audited): patient + superbill are
    // FORCE-RLS'd — the tenant client with no org GUC sees ZERO rows, which
    // would report this check green forever.
    const rows = await withBreakglass(
      (client) => client.$queryRaw<{ p: bigint; s: bigint }[]>`
        SELECT
          -- An empty string is not a member id: a bill for a patient with none
          -- on file snapshots '', which has nothing to encrypt.
          (SELECT count(*) FROM patient
            WHERE NULLIF(btrim(primary_member_id), '') IS NOT NULL AND primary_member_id_enc IS NULL)  AS p,
          (SELECT count(*) FROM superbill
            WHERE NULLIF(btrim(member_id_snapshot), '') IS NOT NULL AND member_id_snapshot_enc IS NULL) AS s
      `,
      "compliance dashboard: PHI encryption coverage counts (aggregate, no PHI values)",
    );
    const p = Number(rows[0]?.p ?? 0);
    const s = Number(rows[0]?.s ?? 0);
    checks.push({
      id: "phi_encryption_coverage",
      label: "PHI member-id encryption coverage",
      ok: p === 0 && s === 0,
      detail:
        p === 0 && s === 0
          ? "Every stored member id has an encrypted companion."
          : `${p} patient + ${s} superbill member ids lack ciphertext — set PALLIO_PHI_KEY and run scripts/backfill-phi-encryption.sql.`,
    });
  } catch (err) {
    checks.push({
      id: "phi_encryption_coverage",
      label: "PHI member-id encryption coverage",
      ok: false,
      detail: err instanceof Error ? err.message : "probe failed",
    });
  }

  // 5) Audit log freshness — at least one row in the last 24h
  try {
    // Cross-tenant read via withBreakglass (audited): audit_log is RLS'd
    // (0007) — the tenant client reported "0 rows, ok" forever.
    const rows = await withBreakglass(
      (client) => client.$queryRaw<{ recent: bigint; total: bigint }[]>`
        SELECT
          COUNT(*) FILTER (WHERE occurred_at > now() - interval '24 hours') AS recent,
          COUNT(*) AS total
        FROM audit_log
      `,
      "compliance dashboard: audit-log freshness counts (aggregate)",
    );
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

  // 8) The integrations onboarding actually depends on.
  //
  // These were invisible. Every one degrades QUIETLY when its key is absent —
  // no crash, no error page, a 503 or a no-op somewhere a user will not be
  // looking — so the only way to learn that outbound email was off was for an
  // invited colleague to never arrive. Stated here, before the first customer
  // rather than after.
  const outbound = Boolean(process.env.RESEND_API_KEY);
  checks.push({
    id: "email_outbound",
    label: "Outbound email (Resend)",
    ok: outbound,
    detail: outbound
      ? "RESEND_API_KEY set — invites and password resets are delivered."
      : "NOT SET — invites and password resets are written to stdout and never sent. " +
        "Nobody can be invited and nobody can recover an account.",
  });

  const stripe = Boolean(process.env.STRIPE_SECRET_KEY);
  const stripePrices = ["SOLO", "TEAM", "ORG", "ENT"].filter(
    (p) => process.env[`STRIPE_PRICE_${p}`],
  );
  checks.push({
    id: "billing_stripe",
    label: "Billing (Stripe)",
    ok: stripe && stripePrices.length > 0,
    detail: !stripe
      ? "STRIPE_SECRET_KEY not set — checkout returns 503 and no org can subscribe."
      : stripePrices.length === 0
        ? "Key set but no STRIPE_PRICE_* configured — checkout has no plan to sell."
        : `Configured with ${stripePrices.length} plan(s): ${stripePrices.join(", ").toLowerCase()}.` +
          (process.env.STRIPE_WEBHOOK_SECRET
            ? ""
            : " STRIPE_WEBHOOK_SECRET missing — payment results will not post back."),
  });

  const gcal =
    Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID) &&
    Boolean(process.env.GOOGLE_OAUTH_CLIENT_SECRET) &&
    Boolean(process.env.GOOGLE_OAUTH_REDIRECT_URI) &&
    Boolean(process.env.PALLIO_TOKEN_KEY);
  checks.push({
    id: "calendar_google",
    label: "Google Calendar sync",
    ok: gcal,
    detail: gcal
      ? "OAuth client and token key present — clinicians can connect a calendar."
      : "Not configured — the Integrations page offers a connect button that returns 503. " +
        "Optional unless visit scheduling is being sold.",
  });

  const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  checks.push({
    id: "ai_anthropic",
    label: "Rule synthesis (Anthropic)",
    ok: anthropic,
    detail: anthropic
      ? "ANTHROPIC_API_KEY set — lookups synthesise cited answers."
      : "NOT SET — every rule lookup falls back to stored rules only, and document " +
        "ingestion cannot extract at all.",
  });

  const openai = Boolean(process.env.OPENAI_API_KEY);
  checks.push({
    id: "ai_embeddings",
    label: "Embeddings (OpenAI)",
    ok: openai,
    detail: openai
      ? "OPENAI_API_KEY set — semantic search over document chunks is live."
      : "Not set — lookups fall back to keyword search over stored rules.",
  });

  return checks;
}

/**
 * The safeguards an ORG ADMIN sees, on the audit page (audit R24).
 *
 * The retention, isolation and encryption evidence that answers a buyer's
 * "how is my patients' data protected" was visible only to the platform
 * operator, on a board that also prints table names, env-var names and
 * integration keys and reads across tenants. This is the org-scoped subset:
 * counts, never table names; this org's rows only, read under its own RLS
 * context, never breakglass; and a failed probe says so without echoing the
 * database's error text, which can name tables.
 */
export async function runOrgSafeguardChecks(orgId: string): Promise<ComplianceCheck[]> {
  const checks: ComplianceCheck[] = [];
  const unavailable = (id: string, label: string): ComplianceCheck => ({
    id,
    label,
    ok: false,
    detail: "This check could not run just now. Try again, or contact Pallio support if it persists.",
  });

  const isolation = "Isolated from every other organization";
  try {
    const { scanned, offenders } = await tenantRlsCoverage();
    // The policies hold only if the application's own connection obeys them.
    // A superuser or BYPASSRLS connection skips every one, and this used to
    // report the policies as isolation all the same.
    const bypass = bypassesRls(await connectionRole());
    checks.push({
      id: "tenant_isolation",
      label: isolation,
      ok: offenders.length === 0 && !bypass,
      detail: bypass
        ? "Pallio's application connects to the database in a way that bypasses this isolation, so it is not in force. Contact Pallio support."
        : offenders.length === 0
          ? `All ${scanned} tables holding practice data enforce per-organization isolation in the database itself.`
          : `${offenders.length} of ${scanned} tables holding practice data lack per-organization isolation. Contact Pallio support.`,
    });
  } catch {
    checks.push(unavailable("tenant_isolation", isolation));
  }

  const retention = "Audit log kept for six years";
  try {
    const present = await retentionGuardPresent("audit_log");
    const truncatable = present && (await logTruncatable("audit_log"));
    checks.push({
      id: "audit_retention",
      label: retention,
      ok: present && !truncatable,
      detail: !present
        ? "The guard that stops audit entries being deleted early is not active. Contact Pallio support."
        : truncatable
          ? "Entries cannot be deleted one by one, but the application's database role can still empty the whole log at once. Contact Pallio support."
          : "Entries in this log cannot be changed, and cannot be deleted before they are six years old.",
    });
  } catch {
    checks.push(unavailable("audit_retention", retention));
  }

  const access = "Record access logged and kept";
  try {
    const present = await retentionGuardPresent("phi_access_log");
    const truncatable = present && (await logTruncatable("phi_access_log"));
    checks.push({
      id: "phi_access_retention",
      label: access,
      ok: present && !truncatable,
      detail: !present
        ? "The guard protecting the record-access log is not active. Contact Pallio support."
        : truncatable
          ? "Record opening is logged, but the application's database role can still empty that log at once. Contact Pallio support."
          : "Every opening of a patient record is logged, and that log is protected by the same retention guard.",
    });
  } catch {
    checks.push(unavailable("phi_access_retention", access));
  }

  const encryption = "Member IDs encrypted at rest";
  try {
    // This org's rows, named as well as left to RLS: on a connection that
    // bypasses RLS these counts were every org's, reported as "yours".
    const rows = await withOrgContext(orgId, (tx) =>
      tx.$queryRaw<{ p: bigint; s: bigint }[]>`
        SELECT
          -- Real member ids only: an empty snapshot has nothing to encrypt and
          -- read as a failing check for every bill whose patient has no id.
          (SELECT count(*) FROM patient
            WHERE org_id = ${orgId}::uuid
              AND NULLIF(btrim(primary_member_id), '') IS NOT NULL AND primary_member_id_enc IS NULL)  AS p,
          (SELECT count(*) FROM superbill
            WHERE org_id = ${orgId}::uuid
              AND NULLIF(btrim(member_id_snapshot), '') IS NOT NULL AND member_id_snapshot_enc IS NULL) AS s
      `,
    );
    const missing = Number(rows[0]?.p ?? 0) + Number(rows[0]?.s ?? 0);
    checks.push({
      id: "member_id_encryption",
      label: encryption,
      ok: missing === 0,
      detail:
        missing === 0
          ? "Every member ID your organization has stored also has an encrypted copy."
          : `${missing} member ID${missing === 1 ? "" : "s"} stored by your organization ${missing === 1 ? "lacks" : "lack"} an encrypted copy. Contact Pallio support.`,
    });
  } catch {
    checks.push(unavailable("member_id_encryption", encryption));
  }

  const activity = "Activity is being recorded";
  try {
    const rows = await withOrgContext(orgId, (tx) =>
      tx.$queryRaw<{ recent: bigint; total: bigint }[]>`
        SELECT
          COUNT(*) FILTER (WHERE occurred_at > now() - interval '24 hours') AS recent,
          COUNT(*) AS total
        FROM audit_log
        WHERE org_id = ${orgId}::uuid
      `,
    );
    const recent = Number(rows[0]?.recent ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    checks.push({
      id: "audit_activity",
      label: activity,
      ok: recent > 0 || total === 0,
      detail:
        `${recent} entr${recent === 1 ? "y" : "ies"} in the last 24 hours · ${total} in total.` +
        (recent === 0 && total > 0
          ? " If your team has worked in Pallio today, contact Pallio support."
          : ""),
    });
  } catch {
    checks.push(unavailable("audit_activity", activity));
  }

  const licensed = hasAmaLicense();
  checks.push({
    id: "cpt_licence",
    label: "CPT® descriptors",
    ok: licensed,
    detail: licensed
      ? "CPT® descriptors are shown under Pallio's AMA licence."
      : "CPT® descriptors are withheld until Pallio's AMA licence is active on this deployment. Codes, coverage and rules are unaffected.",
  });

  return checks;
}
