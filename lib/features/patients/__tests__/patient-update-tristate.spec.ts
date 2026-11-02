/**
 * Correcting a chart after intake (audit 27 Oct, doc:21 and :23).
 *
 * The chart had no edit screen, and the update wrote COALESCE(new, old), so a
 * wrong phone or group number could be replaced but never removed. Every
 * optional field is now tri-state — absent keeps, null clears, a value sets —
 * secondary insurance is captured (Mark Q11g default), and consents can be
 * recorded or withdrawn after intake (0109). lib/db is mocked with a fake tx
 * that records every call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/hipaa/pgp", () => ({ applyPhiKeyIfConfigured: vi.fn(async () => false) }));
vi.mock("@/lib/features/audit/audit-write", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/audit/audit-write")>()),
  writeAudit: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { updatePatient } from "../patient.service";
import { UpdatePatientSchema } from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const PRIMARY = "a0000000-0000-4000-8000-000000000401";
const OTHER = "a0000000-0000-4000-8000-000000000305";

let calls: { sql: string; values: unknown[] }[];

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => {
    const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("¶");
      calls.push({ sql, values });
      if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
      if (sql.includes("SELECT primary_payer_id FROM patient")) return Promise.resolve([{ primary_payer_id: PRIMARY }]);
      return Promise.resolve([]);
    };
    return (fn as (tx: unknown) => Promise<unknown>)({ $queryRaw: run, $executeRaw: run });
  });
});

const update = () => calls.find((c) => c.sql.includes("UPDATE patient SET"))!;
/** The bound value for `column = CASE WHEN <sent> THEN <value> ...`: [sent, value]. */
function caseFor(column: string): [unknown, unknown] {
  const u = update();
  const parts = u.sql.split("¶");
  const at = new RegExp(`\\b${column}\\s+= CASE WHEN $`);
  const k = parts.findIndex((p) => at.test(p));
  expect(k, column).toBeGreaterThanOrEqual(0);
  return [u.values[k], u.values[k + 1]];
}

describe("UpdatePatientSchema", () => {
  it("takes null to clear an optional field, but never for name or date of birth", () => {
    expect(UpdatePatientSchema.safeParse({ demographics: { phone: null, addressLine2: null } }).success).toBe(true);
    expect(UpdatePatientSchema.safeParse({ demographics: { firstName: null } }).success).toBe(false);
    expect(UpdatePatientSchema.safeParse({ demographics: { dateOfBirth: null } }).success).toBe(false);
  });

  it("carries secondary insurance and consents, and still refuses an unknown key", () => {
    expect(
      UpdatePatientSchema.safeParse({
        insurance: { secondaryPayerId: OTHER, secondaryMemberId: "X9", secondaryGroupNumber: null },
        consents: { hipaaAcknowledged: true, signedBy: "Daughter, Ann Byers" },
      }).success,
    ).toBe(true);
    expect(UpdatePatientSchema.safeParse({ demographics: { emergencyContactName: "x" } }).success).toBe(false);
  });

  // The primary diagnosis took /^[A-Z]\d{2}(\.\d{1,4})?$/i: real codes with a
  // letter after the first digit-pair were refused, and "i509" was stored as
  // typed, matching nothing the visit's diagnosis search returns.
  it("takes any ICD-10-CM shape for the primary diagnosis and stores it dotted, upper case", () => {
    const icd = (code: string) => {
      const r = UpdatePatientSchema.safeParse({ clinical: { primaryDiagnosisIcd10: code } });
      return r.success ? r.data.clinical?.primaryDiagnosisIcd10 : "refused";
    };
    expect(icd("C7A.1")).toBe("C7A.1");
    expect(icd("S72.001A")).toBe("S72.001A");
    expect(icd("i509")).toBe("I50.9");
    expect(icd("c34.90")).toBe("C34.90");
    expect(icd("R64")).toBe("R64");
  });

  it("CONTROL: still refuses what is not a code", () => {
    for (const code of ["50.9", "I5", "I50.99999", "I5.09", "hello"]) {
      expect(UpdatePatientSchema.safeParse({ clinical: { primaryDiagnosisIcd10: code } }).success, code).toBe(false);
    }
    expect(UpdatePatientSchema.safeParse({ clinical: { primaryDiagnosisIcd10: null } }).success).toBe(true);
  });
});

describe("updatePatient — tri-state fields", () => {
  it("clears a field sent as null, and leaves one not sent alone", async () => {
    await updatePatient({ orgId: ORG, id: PATIENT, payload: { demographics: { phone: null } } });
    expect(caseFor("phone")).toEqual([true, null]);
    expect(caseFor("address_line_2")).toEqual([false, null]);
  });

  it("CONTROL: a value sent is written", async () => {
    await updatePatient({ orgId: ORG, id: PATIENT, payload: { demographics: { city: "Toledo" } } });
    expect(caseFor("city")).toEqual([true, "Toledo"]);
  });

  it("writes secondary insurance, and refuses the primary plan as secondary", async () => {
    await updatePatient({
      orgId: ORG,
      id: PATIENT,
      payload: { insurance: { secondaryPayerId: OTHER, secondaryMemberId: "X9" } },
    });
    expect(caseFor("secondary_payer_id")).toEqual([true, OTHER]);
    expect(caseFor("secondary_member_id")).toEqual([true, "X9"]);

    calls = [];
    await expect(
      updatePatient({ orgId: ORG, id: PATIENT, payload: { insurance: { secondaryPayerId: PRIMARY } } }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(calls.some((c) => c.sql.includes("UPDATE patient SET"))).toBe(false);
  });
});

describe("updatePatient — consents after intake", () => {
  it("records a consent keeping any date already on file, and audits the section only", async () => {
    await updatePatient({
      orgId: ORG,
      id: PATIENT,
      payload: { consents: { hipaaAcknowledged: true, signedBy: "Ann Byers" } },
    });
    const u = update();
    expect(u.sql).toContain("COALESCE(hipaa_acknowledged_at, now())");
    expect(u.values).toContain("Ann Byers");
    const audit = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(audit.payload).toEqual({ sections: ["consents"] });
  });
});
