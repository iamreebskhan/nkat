/**
 * Family and caregivers on a patient (audit R30).
 *
 * The chart held one unlabelled emergency-contact pair. These rows replace it,
 * with the rule that matters most legally (at most one healthcare POA) and an
 * audit trail that names the contact by id and the columns written, never the
 * person or their number.
 *
 * lib/db is mocked with a fake tx that dispatches on the SQL text (the
 * care-team.spec pattern); writeAudit is mocked so its payload can be read.
 * The patient check is the exception: sql-fake RUNS it over two orgs'
 * patients, the other org's first, with no RLS, so its predicates decide.
 */
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { run as runSql } from "@/lib/features/team/__tests__/sql-fake";

import { createContact, deleteContact, isUniqueViolation, listContacts, updateContact } from "../contacts.service";
import { PatientContactSchema, UpdatePatientContactSchema } from "../contacts.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const CONTACT = "66666666-6666-4666-8666-666666666666";
const OTHER_POA = "77777777-7777-4777-8777-777777777777";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
/** Another org's patient, and a contact on their chart. */
const OTHER_PATIENT = "44444444-4444-4444-8444-44444444bbbb";
const OTHER_CONTACT = "66666666-6666-4666-8666-66666666bbbb";

let calls: { sql: string; values: unknown[] }[] = [];
let patientFound: boolean;
/** The contact holding the POA flag, if any. */
let poaHolder: string | null;
/** Whether the UPDATE/DELETE, scoped to the patient, matched a row. */
let rowHits: boolean;
/** What the INSERT/UPDATE throws instead of returning, if anything. */
let writeError: unknown;

const row = {
  id: CONTACT, full_name: "Mary Singleton", relationship: "child_in_law", phone: "614-555-0142",
  alt_phone: null, email: null, is_primary_caregiver: true, is_emergency_contact: true,
  is_healthcare_poa: false, lives_with_patient: false, notes: null,
  updated_at: new Date("2026-09-15T10:00:00Z"),
};

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id FROM patient WHERE")) {
      const patients = [{ id: OTHER_PATIENT, org_id: OTHER_ORG }, ...(patientFound ? [{ id: PATIENT, org_id: ORG }] : [])];
      return Promise.resolve(runSql({ patient: { columns: ["id", "org_id"], rows: patients } }, strings, values));
    }
    if (sql.includes("AND is_healthcare_poa")) {
      // The real query leaves out the contact being saved (id IS DISTINCT FROM $2).
      return Promise.resolve(
        poaHolder && poaHolder !== values[1] ? [{ id: poaHolder, full_name: "Tom Reyes" }] : [],
      );
    }
    if (sql.includes("INSERT INTO patient_contact")) {
      return writeError ? Promise.reject(writeError) : Promise.resolve([row]);
    }
    if (sql.includes("UPDATE patient_contact")) {
      return writeError ? Promise.reject(writeError) : Promise.resolve(rowHits ? [row] : []);
    }
    if (sql.includes("DELETE FROM patient_contact")) return Promise.resolve(rowHits ? [{ id: CONTACT }] : []);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const insertCall = () => calls.find((c) => c.sql.includes("INSERT INTO patient_contact"));
const updateCall = () => calls.find((c) => c.sql.includes("UPDATE patient_contact"));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);

beforeEach(() => {
  calls = [];
  patientFound = true;
  poaHolder = null;
  rowHits = true;
  writeError = null;
  vi.mocked(writeAudit).mockReset();
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const MARY = {
  fullName: "Mary Singleton",
  relationship: "child_in_law" as const,
  phone: "614-555-0142",
  isPrimaryCaregiver: true,
  isEmergencyContact: true,
};
const base = { orgId: ORG, userId: USER, patientId: PATIENT };

describe("contact schemas", () => {
  it("refuses a blank name, a phone that is not one, and a relationship outside the list", () => {
    expect(PatientContactSchema.safeParse({ ...MARY, fullName: "   " }).success).toBe(false);
    expect(PatientContactSchema.safeParse({ ...MARY, phone: "abc" }).success).toBe(false);
    expect(PatientContactSchema.safeParse({ ...MARY, relationship: "cousin" }).success).toBe(false);
    expect(PatientContactSchema.safeParse(MARY).success).toBe(true);
  });

  it("defaults every role to false", () => {
    const r = PatientContactSchema.parse({ fullName: "Kim Test", relationship: "friend" });
    expect([r.isPrimaryCaregiver, r.isEmergencyContact, r.isHealthcarePoa, r.livesWithPatient]).toEqual([
      false, false, false, false,
    ]);
  });

  it("PATCH refuses an empty change, and takes null as 'clear'", () => {
    expect(UpdatePatientContactSchema.safeParse({}).success).toBe(false);
    expect(UpdatePatientContactSchema.safeParse({ phone: null }).success).toBe(true);
    expect(UpdatePatientContactSchema.safeParse({ fullName: null }).success).toBe(false);
  });
});

describe("createContact", () => {
  it("404s when the patient is not visible in this org, and writes nothing", async () => {
    patientFound = false;
    await expect(createContact({ ...base, input: MARY })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(insertCall()).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("inserts under the org and patient, with the roles that were ticked", async () => {
    await createContact({ ...base, input: MARY });
    const v = insertCall()!.values;
    expect(v.slice(0, 5)).toEqual([ORG, PATIENT, "Mary Singleton", "child_in_law", "614-555-0142"]);
    // primary caregiver, emergency contact, healthcare POA, lives with patient
    expect(v.slice(7, 11)).toEqual([true, true, false, false]);
  });

  it("refuses a second healthcare POA, naming the first, and inserts nothing", async () => {
    poaHolder = OTHER_POA;
    await expect(
      createContact({ ...base, input: { fullName: "Ann Reyes", relationship: "other", isHealthcarePoa: true } }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("Tom Reyes is already this patient's healthcare POA"),
    });
    expect(insertCall()).toBeUndefined();
  });

  it("does not ask about the POA when the new contact is not one", async () => {
    poaHolder = OTHER_POA;
    await createContact({ ...base, input: MARY });
    expect(calls.some((c) => c.sql.includes("AND is_healthcare_poa"))).toBe(false);
    expect(insertCall()).toBeDefined();
  });

  it("audits the contact id and the columns written — never the name or number", async () => {
    await createContact({ ...base, input: MARY });
    const [entry] = audited();
    expect(entry).toMatchObject({ action: "patient_contact_change", targetType: "patient", targetId: PATIENT });
    expect(entry!.payload).toEqual({
      contactId: CONTACT,
      op: "create",
      fields: ["full_name", "is_emergency_contact", "is_primary_caregiver", "phone", "relationship"],
    });
    const json = JSON.stringify(entry!.payload);
    expect(json).not.toContain("Mary");
    expect(json).not.toContain("614-555-0142");
  });
});

describe("another org's patient", () => {
  const theirs = { orgId: ORG, userId: USER, patientId: OTHER_PATIENT };
  const nothingWritten = () =>
    expect(calls.filter((c) => /INSERT INTO|UPDATE |DELETE FROM/.test(c.sql)).map((c) => c.sql)).toEqual([]);

  it("lists none of their contacts: not found", async () => {
    await expect(listContacts(theirs)).rejects.toMatchObject({ name: "NotFoundError" });
    expect(calls.some((c) => c.sql.includes("FROM patient_contact"))).toBe(false);
  });

  it("adds, edits and removes none of their contacts: not found, nothing written or audited", async () => {
    await expect(createContact({ ...theirs, input: MARY })).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(
      updateContact({ ...theirs, contactId: OTHER_CONTACT, patch: { phone: null } }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(deleteContact({ ...theirs, contactId: OTHER_CONTACT })).rejects.toMatchObject({
      name: "NotFoundError",
    });
    nothingWritten();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("updateContact", () => {
  it("lets the POA holder be re-saved with its own id", async () => {
    poaHolder = CONTACT;
    await updateContact({ ...base, contactId: CONTACT, patch: { isHealthcarePoa: true, phone: "614-555-0000" } });
    expect(updateCall()).toBeDefined();
  });

  it("refuses making a second contact the POA, and changes nothing", async () => {
    poaHolder = OTHER_POA;
    await expect(
      updateContact({ ...base, contactId: CONTACT, patch: { isHealthcarePoa: true } }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(updateCall()).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("is tri-state: null clears, an absent field keeps its value", async () => {
    await updateContact({ ...base, contactId: CONTACT, patch: { phone: null } });
    const v = updateCall()!.values;
    // [keep?, value] per text column: full_name, relationship, phone, alt_phone, email, notes.
    expect(v.slice(0, 2)).toEqual([true, null]); // full_name absent → keep
    expect(v.slice(4, 6)).toEqual([false, null]); // phone null → clear
    expect(v.slice(6, 8)).toEqual([true, null]); // alt_phone absent → keep
    // Role flags absent → NULL, which COALESCE turns into "keep".
    expect(v.slice(12, 16)).toEqual([null, null, null, null]);
    // Scoped to the patient in the URL and this org, as well as the contact id.
    expect(v.slice(-3)).toEqual([CONTACT, PATIENT, ORG]);
    expect(audited()[0]!.payload).toEqual({ contactId: CONTACT, op: "update", fields: ["phone"] });
  });

  it("counts a role being cleared as a change", async () => {
    await updateContact({ ...base, contactId: CONTACT, patch: { isEmergencyContact: false } });
    expect(audited()[0]!.payload).toMatchObject({ fields: ["is_emergency_contact"] });
  });

  it("404s a contact that is not on this patient, and audits nothing", async () => {
    rowHits = false;
    await expect(
      updateContact({ ...base, contactId: CONTACT, patch: { phone: null } }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("deleteContact", () => {
  it("404s a contact belonging to another patient (0 rows), and audits nothing", async () => {
    rowHits = false;
    await expect(deleteContact({ ...base, contactId: CONTACT })).rejects.toMatchObject({ name: "NotFoundError" });
    const del = calls.find((c) => c.sql.includes("DELETE FROM patient_contact"))!;
    expect(del.values).toEqual([CONTACT, PATIENT, ORG]);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("audits the removal by id", async () => {
    await deleteContact({ ...base, contactId: CONTACT });
    expect(audited()[0]).toMatchObject({
      action: "patient_contact_change",
      payload: { contactId: CONTACT, op: "delete" },
    });
  });
});

/**
 * What Prisma really throws when a $queryRaw statement hits a unique index:
 * P2010, the SQLSTATE in meta.code, and a message that names no index. The
 * old check looked for the constraint name in that text, never found it, and
 * let the race through as a 500 (audit R30).
 */
const prismaRawError = (sqlState: string, message: string) =>
  new PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`. Message: \`${message}\``, {
    code: "P2010",
    clientVersion: "6.2.1",
    meta: { code: sqlState, message },
  });
const uniqueViolation = () => prismaRawError("23505", "Unique constraint failed: ");

describe("isUniqueViolation", () => {
  it("knows Prisma's raw-query shape and node-pg's bare SQLSTATE", () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(true);
  });

  it("CONTROL: another database error, or a bare message naming a constraint, is not one", () => {
    expect(isUniqueViolation(prismaRawError("23503", "Foreign key constraint violated"))).toBe(false);
    expect(
      isUniqueViolation(new Error('duplicate key value violates unique constraint "patient_contact_one_poa"')),
    ).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("a save that loses the race for the one POA (R30)", () => {
  const ANN = { fullName: "Ann Reyes", relationship: "other" as const, isHealthcarePoa: true };

  it("createContact answers with the POA refusal (422), not a 500, and audits nothing", async () => {
    writeError = uniqueViolation();
    await expect(createContact({ ...base, input: ANN })).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has a healthcare POA"),
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("updateContact the same", async () => {
    writeError = uniqueViolation();
    await expect(
      updateContact({ ...base, contactId: CONTACT, patch: { isHealthcarePoa: true } }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("already has a healthcare POA"),
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("CONTROL: any other database error still propagates as itself", async () => {
    const fk = prismaRawError("23503", "Foreign key constraint violated");
    writeError = fk;
    await expect(createContact({ ...base, input: ANN })).rejects.toBe(fk);
    await expect(updateContact({ ...base, contactId: CONTACT, patch: { phone: null } })).rejects.toBe(fk);
  });
});
