/**
 * Intake and PATCH after audit R30.
 *
 * createPatient used to write the emergency contact and the referring
 * physician into four patient columns nothing read back. It now files them as
 * a patient_contact row and a roster link. updatePatient's demographics
 * branch wrote only the name and DOB and then audited "demographics" for a
 * PATCH carrying an address; it now writes every stored field, and names a
 * section only when it wrote something.
 *
 * lib/db is mocked with a fake tx that dispatches on the SQL text; writeAudit
 * is mocked so its payloads can be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { createPatient, updatePatient } from "../patient.service";
import { CreatePatientSchema, UpdatePatientSchema } from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const CONTACT = "66666666-6666-4666-8666-666666666666";
const EXISTING = "88888888-8888-4888-8888-888888888888";
const NEW_PROVIDER = "99999999-9999-4999-8999-999999999999";
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARESOURCE_OH = "a0000000-0000-4000-8000-000000000305";

let calls: { sql: string; values: unknown[] }[] = [];
let rosterByNpi: Record<string, string>;
/** The patient row as stored, for updates. */
let stored: { primary_payer_id: string | null; insurance_state: string | null; state: string | null };

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM payer")) {
      return Promise.resolve(values[0] === CARESOURCE_OH ? [{ name: "CareSource Ohio", states_served: ["OH"] }] : []);
    }
    if (sql.includes("FROM state")) return Promise.resolve(["OH", "UT"].includes(values[0] as string) ? [{ ok: 1 }] : []);
    if (sql.includes("primary_payer_id, insurance_state, state FROM patient")) return Promise.resolve([stored]);
    if (sql.includes("INSERT INTO patient_contact")) {
      return Promise.resolve([{
        id: CONTACT, full_name: values[2], relationship: values[3], phone: values[4], alt_phone: null,
        email: null, is_primary_caregiver: false, is_emergency_contact: true, is_healthcare_poa: false,
        lives_with_patient: false, notes: null, updated_at: new Date(),
      }]);
    }
    if (sql.includes("INSERT INTO patient_external_provider")) return Promise.resolve([{ id: LINK }]);
    if (sql.includes("INSERT INTO external_provider")) return Promise.resolve([{ id: NEW_PROVIDER }]);
    if (sql.includes("FROM external_provider WHERE npi")) {
      const id = rosterByNpi[values[0] as string];
      return Promise.resolve(id ? [{ id }] : []);
    }
    if (sql.includes("INSERT INTO patient (")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT id FROM patient WHERE")) return Promise.resolve([{ id: PATIENT }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  rosterByNpi = {};
  stored = { primary_payer_id: null, insurance_state: null, state: "OH" };
  vi.mocked(writeAudit).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

function payload(demographics: Record<string, unknown> = {}, clinical: Record<string, unknown> = {}) {
  return CreatePatientSchema.parse({
    demographics: { firstName: "Jo", lastName: "Test", dateOfBirth: "1950-01-01", ...demographics },
    insurance: {},
    clinical,
    consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: false },
    careTeam: {},
  });
}
const create = (p: ReturnType<typeof payload>) => createPatient({ orgId: ORG, createdByUserId: USER, payload: p });
const find = (fragment: string) => calls.find((c) => c.sql.includes(fragment));
const audit = (action: string) => vi.mocked(writeAudit).mock.calls.map((c) => c[1]).find((e) => e.action === action);

type UpdatePayload = Parameters<typeof updatePatient>[0]["payload"];

describe("createPatient — contacts and referrer (audit R30)", () => {
  it("no longer writes the four legacy columns on the patient row", async () => {
    await create(payload({ emergencyContactName: "Kim Test" }, { referringPhysicianNpi: "1234567893" }));
    const sql = find("INSERT INTO patient (")!.sql;
    for (const col of ["emergency_contact_name", "emergency_contact_phone", "referring_physician_npi", "referring_physician_name"]) {
      expect(sql).not.toContain(col);
    }
  });

  it("files the emergency contact, with its phone, as a patient_contact flagged emergency", async () => {
    await create(payload({
      emergencyContactName: "Kim Test", emergencyContactPhone: "614-555-0199", emergencyContactRelationship: "child",
    }));
    const v = find("INSERT INTO patient_contact")!.values;
    expect(v.slice(0, 5)).toEqual([ORG, PATIENT, "Kim Test", "child", "614-555-0199"]);
    expect(v[8]).toBe(true); // is_emergency_contact
    expect(audit("patient_create")!.payload).toMatchObject({ hasEmergencyContact: true, hasReferringPhysician: false });
  });

  it("records the relationship as 'other' when intake did not ask", async () => {
    await create(payload({ emergencyContactName: "Kim Test" }));
    expect(find("INSERT INTO patient_contact")!.values[3]).toBe("other");
  });

  it("refuses a phone with no name, and writes nothing", async () => {
    await expect(create(payload({ emergencyContactPhone: "614-555-0199" }))).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("emergency contact's name"),
    });
    expect(calls.some((c) => c.sql.includes("INSERT INTO"))).toBe(false);
  });

  it("links a referring NPI already on the roster as referring, without a second roster row", async () => {
    rosterByNpi = { "1234567893": EXISTING };
    await create(payload({}, { referringPhysicianNpi: "1234567893", referringPhysicianName: "Dr Alan Brooks" }));
    expect(find("INSERT INTO external_provider")).toBeUndefined();
    expect(find("INSERT INTO patient_external_provider")!.values).toEqual([ORG, PATIENT, EXISTING, "referring", null, USER]);
    expect(audit("patient_create")!.payload).toMatchObject({ hasReferringPhysician: true });
  });

  it("adds a new referrer to the roster under the name given, then links it", async () => {
    await create(payload({}, { referringPhysicianNpi: "1234567893", referringPhysicianName: "Dr Alan Brooks" }));
    expect(find("INSERT INTO external_provider")!.values.slice(0, 3)).toEqual([ORG, "Dr Alan Brooks", "1234567893"]);
    expect(find("INSERT INTO patient_external_provider")!.values[2]).toBe(NEW_PROVIDER);
  });

  it("requires the intake NPI to pass its check digit", () => {
    expect(() => payload({}, { referringPhysicianNpi: "1234567890" })).toThrow(/check digit/);
  });
});

describe("updatePatient — no more silent demographics drop (audit R30)", () => {
  it("writes the address and phone the branch used to discard", async () => {
    const r = await updatePatient({
      orgId: ORG, id: PATIENT, userId: USER,
      payload: { demographics: { city: "Columbus", phone: "614-555-0100", sexAssignedAtBirth: "F" } },
    });
    const upd = calls.find((c) => c.sql.includes("UPDATE patient SET") && c.sql.includes("address_line_1"))!;
    expect(upd.values).toContain("Columbus");
    expect(upd.values).toContain("614-555-0100");
    expect(upd.values).toContain("F");
    expect(r.updated).toBe(true);
    expect(audit("patient_update")!.payload).toEqual({ sections: ["demographics"] });
  });

  it("writes nothing, and audits nothing, for a demographics payload with no stored field", async () => {
    const r = await updatePatient({
      orgId: ORG, id: PATIENT,
      payload: { demographics: { emergencyContactName: "Kim Test" } } as unknown as UpdatePayload,
    });
    expect(calls.some((c) => c.sql.includes("UPDATE patient"))).toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(r.updated).toBe(false);
  });

  it("the PATCH schema names the moved keys instead of dropping them", () => {
    const ec = UpdatePatientSchema.safeParse({ demographics: { emergencyContactName: "Kim Test" } });
    expect(ec.success).toBe(false);
    expect(JSON.stringify(ec.error?.issues)).toContain("emergencyContactName");
    expect(UpdatePatientSchema.safeParse({ clinical: { referringPhysicianNpi: "1234567893" } }).success).toBe(false);
    // What the chart does send still passes.
    expect(UpdatePatientSchema.safeParse({ clinical: { acuity: "high" } }).success).toBe(true);
    expect(UpdatePatientSchema.safeParse({ careTeam: { rnUserId: null } }).success).toBe(true);
  });

  it("checks a new address state against the payer while no policy state is stored (audit R37)", async () => {
    stored = { primary_payer_id: CARESOURCE_OH, insurance_state: null, state: "OH" };
    await expect(
      updatePatient({ orgId: ORG, id: PATIENT, payload: { demographics: { state: "UT" } } }),
    ).rejects.toThrow("CareSource Ohio does not cover UT. It covers OH.");
    expect(calls.some((c) => c.sql.includes("UPDATE patient"))).toBe(false);
  });

  it("CONTROL — under a stored policy state, an address move leaves the pair alone", async () => {
    stored = { primary_payer_id: CARESOURCE_OH, insurance_state: "OH", state: "OH" };
    const r = await updatePatient({ orgId: ORG, id: PATIENT, payload: { demographics: { state: "UT" } } });
    expect(r.updated).toBe(true);
    expect(calls.some((c) => c.sql.includes("FROM payer"))).toBe(false);
  });

  it("refuses an address state that is not a state", async () => {
    await expect(
      updatePatient({ orgId: ORG, id: PATIENT, payload: { demographics: { state: "ZZ" } } }),
    ).rejects.toThrow(/Unknown state code "ZZ"/);
  });
});
