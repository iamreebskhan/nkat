/**
 * Saving a clinician's NPI and credential (audit R40, R25).
 *
 * lib/db is mocked with a fake tx dispatching on SQL text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { saveClinicianProfile } from "../clinician-profile.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GOOD_NPI = "1234567893";
const OLD_NPI = "1497758544";

let isMember: boolean;
let clashWith: string | null;
/** The profile row before this save; null = none yet. */
let prior: { npi: string | null } | null;
/** Bills the fill-in UPDATE ... RETURNING hands back. */
let filled: string[];
let calls: { sql: string; values: unknown[] }[] = [];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org_member")) return Promise.resolve(isMember ? [{ ok: 1 }] : []);
    if (sql.includes("SELECT user_id FROM clinician_profile")) {
      return Promise.resolve(clashWith ? [{ user_id: clashWith }] : []);
    }
    if (sql.includes("SELECT npi FROM clinician_profile")) {
      return Promise.resolve(prior ? [prior] : []);
    }
    if (sql.includes("WITH updated AS")) return Promise.resolve(filled.map((id) => ({ id })));
    return Promise.resolve(1);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const upsert = () => calls.find((c) => c.sql.includes("INSERT INTO clinician_profile"));
const fill = () => calls.find((c) => c.sql.includes("WITH updated AS"));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  isMember = true;
  clashWith = null;
  prior = null;
  filled = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

describe("saveClinicianProfile", () => {
  it("records a valid NPI and credential", async () => {
    const r = await saveClinicianProfile({
      orgId: ORG, userId: USER, actorUserId: ACTOR, npi: GOOD_NPI, credential: "NP",
    });
    expect(r).toEqual({ userId: USER, npi: GOOD_NPI, credential: "NP", openBillsUpdated: 0 });
    expect(upsert()!.values).toContain(GOOD_NPI);
    expect(upsert()!.sql).toContain("ON CONFLICT (org_id, user_id) DO UPDATE");
  });

  it("refuses an NPI whose check digit is wrong, before touching the database", async () => {
    await expect(
      saveClinicianProfile({ orgId: ORG, userId: USER, npi: "1234567890", credential: "NP" }),
    ).rejects.toThrow(/not a valid NPI/i);
    expect(calls).toHaveLength(0);
  });

  it("says an NPI is 10 digits when the length is wrong, rather than blaming the check digit", async () => {
    await expect(
      saveClinicianProfile({ orgId: ORG, userId: USER, npi: "123456789", credential: "NP" }),
    ).rejects.toThrow(/exactly 10 digits/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a credential outside the list", async () => {
    await expect(
      saveClinicianProfile({
        orgId: ORG, userId: USER, npi: null,
        credential: "SURGEON" as unknown as "MD",
      }),
    ).rejects.toThrow(/Unknown credential/);
  });

  it("stores a blank NPI as not recorded, and leaves every bill alone", async () => {
    const r = await saveClinicianProfile({ orgId: ORG, userId: USER, npi: "   ", credential: "MD" });
    expect(r.npi).toBeNull();
    expect(upsert()!.values).toContain(null);
    expect(fill()).toBeUndefined();
  });

  it("refuses someone who is not an active member of this org", async () => {
    isMember = false;
    await expect(
      saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" }),
    ).rejects.toThrow(/not an active member/i);
    expect(upsert()).toBeUndefined();
  });

  it("refuses an NPI already held by another member — it identifies one person", async () => {
    clashWith = ACTOR;
    await expect(
      saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" }),
    ).rejects.toThrow(/already recorded for another member/i);
    expect(upsert()).toBeUndefined();
  });

  it("audits the change by field name and count, never the NPI value", async () => {
    await saveClinicianProfile({
      orgId: ORG, userId: USER, actorUserId: ACTOR, npi: GOOD_NPI, credential: "MD",
    });
    const entry = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(entry.action).toBe("clinician_profile_update");
    expect(entry.targetId).toBe(USER);
    expect(entry.payload).toEqual({ fields: ["npi", "credential"], openBillsUpdated: 0 });
    expect(JSON.stringify(entry.payload)).not.toContain(GOOD_NPI);
  });
});

describe("saveClinicianProfile — the clinician's open bills", () => {
  // A blank rendering NPI blocks submission. Without the fill-in, a bill
  // drafted before the NPI was recorded could never be submitted.
  it("fills the NPI into the clinician's open bills and says how many", async () => {
    filled = ["b1", "b2"];
    const r = await saveClinicianProfile({
      orgId: ORG, userId: USER, actorUserId: ACTOR, npi: GOOD_NPI, credential: "NP",
    });
    expect(r.openBillsUpdated).toBe(2);
    expect(fill()!.values).toContain(GOOD_NPI);
    expect(fill()!.values).toContain(USER);
    expect(fill()!.sql).toContain("v.clinician_user_id = ");
  });

  it("only touches bills still being worked — never a claim already with a payer", async () => {
    await saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" });
    const sql = fill()!.sql;
    expect(sql).toContain("s.status IN ('draft', 'ready_to_submit', 'denied')");
    expect(sql).not.toMatch(/'submitted'|'paid'|'voided'/);
  });

  it("replaces only a blank NPI, the organization's stand-in, or the number being corrected", async () => {
    prior = { npi: OLD_NPI };
    await saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" });
    const f = fill()!;
    expect(f.sql).toContain("COALESCE(s.provider_npi, '') = ''");
    expect(f.sql).toContain("s.provider_npi = COALESCE(s.billing_npi, ob.npi)");
    expect(f.values).toContain(OLD_NPI);
  });

  it("fills this org's bills only, though the clinician may work for another practice too", async () => {
    // A text and bind assertion, and named as one: the fill is an UPDATE … FROM
    // inside a CTE, which no fake here runs. On real Postgres, over a
    // connection that bypasses RLS, the unscoped statement filled the other
    // practice's open bills too and put this org's history rows on them.
    await saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" });
    const f = fill()!;
    expect(f.sql).toContain("AND v.org_id = s.org_id");
    expect(f.sql).toMatch(/AND s\.org_id = ¶::uuid/);
    const at = f.sql.slice(0, f.sql.indexOf("AND s.org_id = ¶")).split("¶").length - 1;
    expect(f.values[at]).toBe(ORG);
  });

  it("puts an entry on each filled bill's own history", async () => {
    await saveClinicianProfile({ orgId: ORG, userId: USER, actorUserId: ACTOR, npi: GOOD_NPI, credential: "NP" });
    expect(fill()!.sql).toContain("INSERT INTO superbill_activity");
    expect(fill()!.values).toContain(ACTOR);
  });

  it("counts filled bills in the audit entry", async () => {
    filled = ["b1"];
    await saveClinicianProfile({ orgId: ORG, userId: USER, npi: GOOD_NPI, credential: "NP" });
    expect(vi.mocked(writeAudit).mock.calls[0]![1].payload).toEqual({
      fields: ["npi", "credential"],
      openBillsUpdated: 1,
    });
  });
});
