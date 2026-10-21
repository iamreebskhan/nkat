/**
 * The safeguards an org admin sees on the audit page (audit R24).
 *
 * What matters: they are this org's, read under its own RLS context and
 * never through breakglass, and a failed probe never names a table or an
 * environment variable. Those details stay on the platform operator's board.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: vi.fn() },
  withOrgContext: vi.fn(),
  withBreakglass: vi.fn(),
}));
vi.mock("@/lib/features/billing/code.service", () => ({ hasAmaLicense: vi.fn(() => false) }));

import { prisma, withBreakglass, withOrgContext } from "@/lib/db";

import { runComplianceChecks, runOrgSafeguardChecks } from "../compliance.service";

const ORG = "11111111-1111-4111-8111-111111111111";

/** Answers for the catalog probes (prisma) and the org-scoped counts (withOrgContext). */
let catalog: (sql: string) => unknown;
/** The role the app's own connection has, as pg_roles describes it. */
let connection: { role: string; superuser: boolean; bypass_rls: boolean };
let tenant: (sql: string) => unknown;
let orgSql: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  orgSql = [];
  connection = { role: "app", superuser: false, bypass_rls: false };
  catalog = (sql) =>
    sql.includes("FROM pg_roles")
      ? [connection]
      : sql.includes("information_schema.tables")
      ? [
          { table_name: "patient", rls_enabled: true, policy_count: BigInt(1), has_org_id: true },
          { table_name: "visit_addendum", rls_enabled: false, policy_count: BigInt(0), has_org_id: true },
          // Exempt reference data is never counted.
          { table_name: "payer", rls_enabled: false, policy_count: BigInt(0), has_org_id: true },
        ]
      : [{ tgname: "guard" }];
  tenant = (sql) =>
    sql.includes("primary_member_id")
      ? [{ p: BigInt(0), s: BigInt(0) }]
      : [{ recent: BigInt(3), total: BigInt(40) }];
  vi.mocked(prisma.$queryRaw).mockImplementation(((strings: TemplateStringsArray) =>
    Promise.resolve(catalog(strings.join("¶")))) as never);
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      $queryRaw: (strings: TemplateStringsArray) => {
        const sql = strings.join("¶");
        orgSql.push(sql);
        return Promise.resolve(tenant(sql));
      },
    }),
  );
});

describe("runOrgSafeguardChecks", () => {
  it("returns exactly the six org checks", async () => {
    const checks = await runOrgSafeguardChecks(ORG);
    expect(checks.map((c) => c.id)).toEqual([
      "tenant_isolation",
      "audit_retention",
      "phi_access_retention",
      "member_id_encryption",
      "audit_activity",
      "cpt_licence",
    ]);
  });

  it("reads this org's rows under its own context, never breakglass", async () => {
    await runOrgSafeguardChecks(ORG);
    expect(withOrgContext).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(withOrgContext).mock.calls) expect(call[0]).toBe(ORG);
    expect(withBreakglass).not.toHaveBeenCalled();
    expect(orgSql.some((s) => s.includes("member_id_snapshot_enc"))).toBe(true);
    expect(orgSql.some((s) => s.includes("FROM audit_log"))).toBe(true);
  });

  it("reports a table without isolation by count, never by name", async () => {
    const iso = (await runOrgSafeguardChecks(ORG)).find((c) => c.id === "tenant_isolation")!;
    expect(iso.ok).toBe(false);
    expect(iso.detail).toContain("1 of 2");
    expect(iso.detail).not.toContain("visit_addendum");
  });

  it("never echoes a database error, which can name tables", async () => {
    catalog = () => {
      throw new Error('relation "visit_addendum" does not exist');
    };
    tenant = () => {
      throw new Error("permission denied for table patient");
    };
    const checks = await runOrgSafeguardChecks(ORG);
    for (const c of checks) expect(c.detail).not.toMatch(/visit_addendum|permission denied|relation/);
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "tenant_isolation",
      "audit_retention",
      "phi_access_retention",
      "member_id_encryption",
      "audit_activity",
      "cpt_licence",
    ]);
  });

  it("names no environment variable anywhere", async () => {
    for (const c of await runOrgSafeguardChecks(ORG)) {
      expect(`${c.label} ${c.detail}`).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
  });

  it("counts this org's member IDs that lack an encrypted copy", async () => {
    tenant = (sql) =>
      sql.includes("primary_member_id")
        ? [{ p: BigInt(2), s: BigInt(1) }]
        : [{ recent: BigInt(0), total: BigInt(0) }];
    const enc = (await runOrgSafeguardChecks(ORG)).find((c) => c.id === "member_id_encryption")!;
    expect(enc.ok).toBe(false);
    expect(enc.detail).toContain("3 member IDs");
  });

  it("states the CPT licence in the customer's terms", async () => {
    const lic = (await runOrgSafeguardChecks(ORG)).find((c) => c.id === "cpt_licence")!;
    expect(lic.ok).toBe(false);
    expect(lic.detail).toContain("withheld until Pallio's AMA licence is active");
  });
});

describe("runOrgSafeguardChecks — TRUNCATE (0104)", () => {
  it("fails the retention checks when the app's role can empty the logs at once", async () => {
    const base = catalog;
    catalog = (sql) => (sql.includes("has_table_privilege") ? [{ t: true }] : base(sql));
    const checks = await runOrgSafeguardChecks(ORG);
    for (const id of ["audit_retention", "phi_access_retention"]) {
      const c = checks.find((x) => x.id === id)!;
      expect(c.ok).toBe(false);
      expect(c.detail).toMatch(/empty/);
      expect(c.detail).not.toMatch(/audit_log|phi_access_log|TRUNCATE/);
    }
  });

  it("passes them when it cannot", async () => {
    const base = catalog;
    catalog = (sql) => (sql.includes("has_table_privilege") ? [{ t: false }] : base(sql));
    const checks = await runOrgSafeguardChecks(ORG);
    expect(checks.find((x) => x.id === "audit_retention")!.ok).toBe(true);
    expect(checks.find((x) => x.id === "phi_access_retention")!.ok).toBe(true);
  });
});

describe("runOrgSafeguardChecks — member ids", () => {
  it("counts only real member ids, never an empty snapshot", async () => {
    await runOrgSafeguardChecks(ORG);
    const sql = orgSql.find((s) => s.includes("member_id_snapshot_enc"))!;
    expect(sql).toContain("NULLIF(btrim(member_id_snapshot), '') IS NOT NULL");
    expect(sql).toContain("NULLIF(btrim(primary_member_id), '') IS NOT NULL");
  });
});

/**
 * The policies keep organizations apart only if the app's own connection obeys
 * them. A superuser or BYPASSRLS connection skips every one, which is how a
 * deployment connecting as the superuser came to depend on each query's own org
 * filter; the safeguard reported "isolated" all the same.
 */
describe("isolation and the app's own database connection", () => {
  beforeEach(() => {
    const base = catalog;
    // Every practice table has its policies, so the connection is the only
    // thing in question.
    catalog = (sql) =>
      sql.includes("information_schema.tables")
        ? [{ table_name: "patient", rls_enabled: true, policy_count: BigInt(2), has_org_id: true }]
        : base(sql);
  });

  it.each([
    ["a superuser", { role: "admin", superuser: true, bypass_rls: false }],
    ["a BYPASSRLS role", { role: "breakglass", superuser: false, bypass_rls: true }],
  ])("fails it when the app connects as %s, in the org's own terms", async (_k, role) => {
    connection = role;
    const iso = (await runOrgSafeguardChecks(ORG)).find((c) => c.id === "tenant_isolation")!;
    expect(iso.ok).toBe(false);
    expect(iso.detail).toBe(
      "Pallio's application connects to the database in a way that bypasses this isolation, so it is not in force. Contact Pallio support.",
    );
    // Neither the role nor an environment variable is named to an org admin.
    expect(iso.detail).not.toContain(role.role);
    expect(iso.detail).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
  });

  it("CONTROL: passes it on the app role, judged by the policies as before", async () => {
    const iso = (await runOrgSafeguardChecks(ORG)).find((c) => c.id === "tenant_isolation")!;
    expect(iso.ok).toBe(true);
    expect(iso.detail).toBe("All 1 tables holding practice data enforce per-organization isolation in the database itself.");
  });

  it("names the role and the fix on the platform operator's board", async () => {
    connection = { role: "admin", superuser: true, bypass_rls: false };
    const check = (await runComplianceChecks()).find((c) => c.id === "rls_enforced")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('DATABASE_URL connects as "admin", which is a superuser');
    expect(check.detail).toContain("Point DATABASE_URL at the app role (NOBYPASSRLS)");
  });

  it("CONTROL: and passes there on the app role", async () => {
    const check = (await runComplianceChecks()).find((c) => c.id === "rls_enforced")!;
    expect(check).toMatchObject({ ok: true, detail: 'The app connects as "app", which row-level security applies to.' });
  });
});
