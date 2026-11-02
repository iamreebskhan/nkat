/**
 * The chart's problem, medication and allergy lists (0114): the rules the
 * service keeps whatever screen calls it. lib/db is mocked with a fake tx that
 * records every statement and answers the reads each test sets up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/org/org-time-zone", () => ({ readOrgTimeZone: vi.fn(async () => "America/New_York") }));
vi.mock("@/lib/features/org/org-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/org/org-date")>()),
  orgToday: vi.fn(() => "2026-10-28"),
}));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import {
  addAllergy,
  addProblem,
  setNoKnownAllergies,
  updateMedication,
  updateProblem,
} from "../clinical-lists.service";
import {
  UpdateMedicationSchema,
  UpdateProblemSchema,
  medicationLabel,
  noteAllergyLines,
  noteMedicationLines,
  type AllergyView,
  type MedicationView,
} from "../clinical-lists.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ITEM = "c1000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
/** The ICD-10 catalog the fake holds. */
let catalog: Record<string, string>;
/** An active problem already on the list with this code, if any. */
let activeDuplicate: boolean;
let currentProblem: { icd10: string; status: string; onset_on: string | null } | null;
let currentMedication: { status: string; started_on: string | null } | null;
let activeAllergies: number;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id FROM patient WHERE id")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("FROM icd10")) {
      const code = String(values[0]);
      const hit = Object.entries(catalog).find(([c]) => c.replace(/\./g, "") === code);
      return Promise.resolve(hit ? [{ code: hit[0], description: hit[1] }] : []);
    }
    if (sql.includes("SELECT id FROM patient_problem")) return Promise.resolve(activeDuplicate ? [{ id: "other" }] : []);
    if (sql.includes("FROM patient_problem") && sql.includes("FOR UPDATE")) {
      return Promise.resolve(currentProblem ? [currentProblem] : []);
    }
    if (sql.includes("FROM patient_medication") && sql.includes("FOR UPDATE")) {
      return Promise.resolve(currentMedication ? [currentMedication] : []);
    }
    if (sql.includes("count(*)::bigint AS n FROM patient_allergy")) return Promise.resolve([{ n: BigInt(activeAllergies) }]);
    if (sql.includes("INSERT INTO")) return Promise.resolve([{ id: ITEM }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  catalog = { "I50.9": "Heart failure, unspecified", "C34.90": "Malignant neoplasm of unspecified part of unspecified bronchus or lung" };
  activeDuplicate = false;
  currentProblem = { icd10: "I50.9", status: "active", onset_on: "2026-01-10" };
  currentMedication = { status: "active", started_on: "2026-09-01" };
  activeAllergies = 0;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const wrote = (fragment: string) => calls.some((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const who = { orgId: ORG, userId: USER, patientId: PATIENT };

describe("the problem list", () => {
  it("adds a catalog code with the catalog's description, and audits no code", async () => {
    await addProblem({ ...who, payload: { icd10: "I50.9" } });
    const ins = calls.find((c) => c.sql.includes("INSERT INTO patient_problem"))!;
    expect(ins.values).toEqual(expect.arrayContaining(["I50.9", "Heart failure, unspecified"]));
    expect(audited()[0]).toMatchObject({ action: "clinical_list_change", payload: { list: "problems", op: "add", itemId: ITEM } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/I50|Heart/);
  });

  it("CONTROL: refuses a code outside ICD-10-CM, a second active entry, and an onset after today", async () => {
    await expect(addProblem({ ...who, payload: { icd10: "I50.99" } })).rejects.toThrow(/not in the ICD-10-CM/);
    activeDuplicate = true;
    await expect(addProblem({ ...who, payload: { icd10: "I50.9" } })).rejects.toThrow(/already on the problem list/);
    activeDuplicate = false;
    await expect(addProblem({ ...who, payload: { icd10: "C34.90", onsetOn: "2026-10-29" } })).rejects.toThrow(/after today/);
    expect(wrote("INSERT INTO patient_problem")).toBe(false);
  });

  it("resolves with a day, and the schema asks for the day", async () => {
    expect(UpdateProblemSchema.safeParse({ status: "resolved" }).success).toBe(false);
    await updateProblem({ ...who, itemId: ITEM, payload: { status: "resolved", resolvedOn: "2026-10-20" } });
    expect(audited()[0]).toMatchObject({ payload: { op: "resolve", itemId: ITEM } });
  });

  it("CONTROL: refuses a resolution before the onset, and reopening a code that is active again", async () => {
    await expect(
      updateProblem({ ...who, itemId: ITEM, payload: { status: "resolved", resolvedOn: "2026-01-01" } }),
    ).rejects.toThrow(/before its onset/);
    currentProblem = { icd10: "I50.9", status: "resolved", onset_on: null };
    activeDuplicate = true;
    await expect(updateProblem({ ...who, itemId: ITEM, payload: { status: "active" } })).rejects.toThrow(/already active/);
    expect(wrote("UPDATE patient_problem")).toBe(false);
  });
});

describe("the medication list", () => {
  it("stops a medication with its day and reason, never deleting it", async () => {
    expect(UpdateMedicationSchema.safeParse({ status: "stopped" }).success).toBe(false);
    await updateMedication({
      ...who, itemId: ITEM,
      payload: { status: "stopped", stoppedOn: "2026-10-27", stopReason: "Switched to patch" },
    });
    const upd = calls.find((c) => c.sql.includes("UPDATE patient_medication"))!;
    expect(upd.values).toEqual(expect.arrayContaining(["stopped", "2026-10-27", "Switched to patch"]));
    expect(wrote("DELETE")).toBe(false);
    expect(audited()[0]).toMatchObject({ payload: { list: "medications", op: "stop" } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/patch/i);
  });

  it("CONTROL: refuses a stop before the start or after today", async () => {
    for (const stoppedOn of ["2026-08-31", "2026-10-29"]) {
      await expect(
        updateMedication({ ...who, itemId: ITEM, payload: { status: "stopped", stoppedOn } }),
      ).rejects.toMatchObject({ name: "ValidationError" });
    }
    expect(wrote("UPDATE patient_medication")).toBe(false);
  });

  it("reads as one line, with PRN when it is", () => {
    expect(medicationLabel({ name: "Morphine IR", dose: "5 mg", route: "PO", frequency: "every 4 hours", prn: true }))
      .toBe("Morphine IR 5 mg PO every 4 hours PRN");
    expect(medicationLabel({ name: "Oxygen", dose: null, route: " ", frequency: null, prn: false })).toBe("Oxygen");
  });
});

describe("allergies", () => {
  it("recording an allergy clears 'no known allergies'", async () => {
    await addAllergy({ ...who, payload: { substance: "Penicillin", kind: "drug", reaction: "Hives", severity: "moderate" } });
    expect(wrote("SET no_known_allergies_at = NULL")).toBe(true);
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Penicillin|Hives/);
  });

  it("records 'no known allergies' as an answer", async () => {
    await setNoKnownAllergies(who);
    expect(wrote("SET no_known_allergies_at = now()")).toBe(true);
    expect(audited()[0]).toMatchObject({ payload: { list: "no_known_allergies", op: "record" } });
  });

  it("CONTROL: refuses 'no known allergies' while an allergy is active", async () => {
    activeAllergies = 1;
    await expect(setNoKnownAllergies(who)).rejects.toThrow(/active/);
    expect(wrote("SET no_known_allergies_at = now()")).toBe(false);
  });
});

describe("what 'Fill from the chart' writes into the note", () => {
  const med = (o: Partial<MedicationView>): MedicationView => ({
    id: "m", name: "Morphine IR", dose: "5 mg", route: "PO", frequency: "every 4 hours", prn: true,
    indication: "dyspnea", status: "active", startedOn: null, stoppedOn: null, stopReason: null, rxnormCui: null,
    recordedByName: null, recordedAt: "", updatedByName: null, updatedAt: "", ...o,
  });
  const allergy = (o: Partial<AllergyView>): AllergyView => ({
    id: "a", substance: "Penicillin", kind: "drug", reaction: "Hives", severity: "moderate", status: "active",
    inactiveReason: null, rxnormCui: null, recordedByName: null, recordedAt: "", updatedByName: null, updatedAt: "", ...o,
  });

  it("lists the active medications only, with what each is for", () => {
    expect(
      noteMedicationLines({ medications: [med({}), med({ name: "Morphine ER", status: "stopped" })] }),
    ).toEqual(["Morphine IR 5 mg PO every 4 hours PRN — for dyspnea"]);
  });

  it("lists active allergies with reaction and severity, or says none when that was recorded", () => {
    expect(noteAllergyLines({ allergies: [allergy({}), allergy({ substance: "Latex", status: "inactive" })], noKnownAllergies: null }))
      .toEqual(["Penicillin — Hives (moderate)"]);
    expect(noteAllergyLines({ allergies: [], noKnownAllergies: { at: "2026-10-28T00:00:00Z", byName: null } }))
      .toEqual(["No known allergies"]);
  });

  it("CONTROL: says nothing about allergies the chart never recorded either way", () => {
    expect(noteAllergyLines({ allergies: [allergy({ status: "inactive" })], noKnownAllergies: null })).toEqual([]);
  });
});
