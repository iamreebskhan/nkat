/**
 * What the chart's own create and update do for the course of care (0115):
 * where the acuity history starts and how it grows, the day care began, and
 * the status changes a PATCH may still make now that a discharge carries its
 * day and reason. lib/db is mocked with a fake tx that records every statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/features/referrals/referral.service", () => ({ admitReferralInTx: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { createPatient, updatePatient } from "../patient.service";
import type { CreatePatient } from "../patient.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const REFERRAL = "88888888-8888-4888-8888-888888888888";
const TRIAGE = "99999999-9999-4999-8999-999999999999";

let calls: { sql: string; values: unknown[] }[];
/** The chart's status before the change. */
let status: string;
/** The discharge in force, if any. */
let discharge: { died: boolean } | null;
/** The referral's latest triage acuity. */
let triageAcuity: string | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("INSERT INTO patient (")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT id FROM patient WHERE id")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT status FROM patient")) return Promise.resolve([{ status }]);
    if (sql.includes("FROM patient_discharge")) return Promise.resolve(discharge ? [discharge] : []);
    if (sql.includes("FROM referral_triage")) return Promise.resolve([{ id: TRIAGE, preliminary_acuity: triageAcuity }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  status = "active";
  discharge = null;
  triageAcuity = "high";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const find = (fragment: string) => calls.find((c) => c.sql.includes(fragment));
/** The status the PATCH wrote, or null when it wrote none. */
const wroteStatus = () => (find("UPDATE patient SET status")?.values[0] as string | undefined) ?? null;
const patch = (payload: Parameters<typeof updatePatient>[0]["payload"]) =>
  updatePatient({ orgId: ORG, id: PATIENT, userId: USER, payload });

const BASE: CreatePatient = {
  demographics: { firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1942-03-08" },
  insurance: {},
  clinical: {},
  consents: { hipaaAcknowledged: true, goalsOfCareConsent: true, telehealthConsent: true },
  careTeam: {},
};

describe("acuity at intake", () => {
  it("the referral's triage acuity carried over is recorded as the triage's, naming the triage", async () => {
    await createPatient({ orgId: ORG, createdByUserId: USER, payload: { ...BASE, clinical: { acuity: "high" }, referralId: REFERRAL } });
    expect(find("INSERT INTO patient_acuity_event")!.values).toEqual(expect.arrayContaining(["high", "triage", TRIAGE]));
  });

  it("CONTROL: a different acuity at intake is the intake's own", async () => {
    triageAcuity = "medium";
    await createPatient({ orgId: ORG, createdByUserId: USER, payload: { ...BASE, clinical: { acuity: "high" }, referralId: REFERRAL } });
    const ev = find("INSERT INTO patient_acuity_event")!;
    expect(ev.values).toEqual(expect.arrayContaining(["high", "intake"]));
    expect(ev.values).not.toContain(TRIAGE);
  });

  it("starts no history when no acuity is given, and records the practice's day care began", async () => {
    await createPatient({ orgId: ORG, createdByUserId: USER, payload: BASE });
    expect(find("patient_acuity_event")).toBeUndefined();
    const ins = find("INSERT INTO patient (")!;
    expect(ins.sql).toContain("admitted_on");
    expect(ins.sql).toContain("AT TIME ZONE (SELECT o.timezone FROM org o");
  });
});

describe("acuity changed on the chart", () => {
  it("joins the history as a chart review, only when it differs from the stored one", async () => {
    await patch({ clinical: { acuity: "high" } });
    const ev = find("INSERT INTO patient_acuity_event")!;
    expect(ev.sql).toContain("'review'");
    expect(ev.sql).toContain("IS DISTINCT FROM");
    expect(ev.values).toEqual(expect.arrayContaining(["high", USER, PATIENT]));
  });

  it("CONTROL: an update that leaves acuity alone writes no history", async () => {
    await patch({ clinical: { palliativeReferralReason: "Symptom management" } });
    expect(find("patient_acuity_event")).toBeUndefined();
  });
});

describe("a status change by PATCH", () => {
  it("CONTROL: refuses a discharge or a death as a bare status", async () => {
    for (const s of ["discharged", "deceased"] as const) {
      await expect(patch({ status: s })).rejects.toThrow(/Discharge the patient from the chart/);
    }
    expect(wroteStatus()).toBeNull();
  });

  it("CONTROL: refuses bringing a discharged patient back except by readmission", async () => {
    status = "discharged";
    await expect(patch({ status: "active" })).rejects.toThrow(/Readmit/);
    expect(wroteStatus()).toBeNull();
  });

  it("archives, and unarchives a chart never discharged back under care", async () => {
    await patch({ status: "archived" });
    expect(wroteStatus()).toBe("archived");
    calls = [];
    status = "archived";
    await patch({ status: "active" });
    expect(wroteStatus()).toBe("active");
  });

  it("unarchives a chart archived after a discharge as discharged, or deceased after a death", async () => {
    status = "archived";
    discharge = { died: false };
    await patch({ status: "active" });
    expect(wroteStatus()).toBe("discharged");
    calls = [];
    discharge = { died: true };
    await patch({ status: "active" });
    expect(wroteStatus()).toBe("deceased");
    // The discharge in force: one reversed by a readmission does not count.
    expect(find("FROM patient_discharge")!.sql).toContain("reversed_at IS NULL");
  });
});
