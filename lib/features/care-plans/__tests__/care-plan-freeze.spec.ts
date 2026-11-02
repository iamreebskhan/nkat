/**
 * The care plan and the follow-up visit (Level-1 doc:50, doc:59).
 *
 * care_plan_version was to be "frozen at the moment a visit was signed", and
 * nothing wrote it: its one writer took an id no screen sent, so every
 * Version history was empty. A sign-off now freezes the whole plan (0110),
 * and an edit made during a visit is recorded against it. lib/db is mocked
 * with a fake tx that records every call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";

import { freezeCarePlanForSignedVisit, upsertCarePlan } from "../care-plan.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const VISIT = "e0000000-0000-4000-8000-00000000000a";
const OTHER_PATIENTS_VISIT = "e0000000-0000-4000-8000-00000000000b";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let calls: { sql: string; values: unknown[] }[];
let visitStatus: string;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
    // Only this patient's visit is found under this patient.
    if (sql.includes("SELECT id, status FROM visit")) {
      return Promise.resolve(values.includes(VISIT) ? [{ id: VISIT, status: visitStatus }] : []);
    }
    if (sql.includes("INSERT INTO care_plan (")) return Promise.resolve([{ id: "cp1", current_version: 4 }]);
    if (sql.includes("INSERT INTO care_plan_version")) return Promise.resolve([{ version: 5 }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  calls = [];
  visitStatus = "in_progress";
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

describe("freezeCarePlanForSignedVisit", () => {
  it("freezes the whole plan — document, goals, symptoms, medications — under a new version, tied to the visit and its signer", async () => {
    const tx = fakeTx();
    const v = await freezeCarePlanForSignedVisit(tx as never, { orgId: ORG, visitId: VISIT, signedByUserId: USER });
    expect(v).toBe(5);
    const sql = calls[0]!.sql.replace(/\s+/g, " ");
    // The visit's own patient's plan, in this org.
    expect(sql).toContain("cp.patient_id = v.patient_id AND cp.org_id = v.org_id");
    expect(sql).toContain("SET current_version = cp.current_version + 1");
    for (const col of ["document", "goals_of_care_summary", "primary_symptoms", "active_medications", "snapshot_visit_id", "created_by_user_id"]) {
      expect(sql).toContain(col);
    }
    expect(calls[0]!.values).toEqual(expect.arrayContaining([VISIT, ORG, USER]));
    // A sign-off is not an edit: the plan's own "last saved" time stays.
    expect(sql).not.toContain("updated_at");
  });

  it("freezes the chart's active medications, not the plan's old copy of them (0114)", async () => {
    const tx = fakeTx();
    await freezeCarePlanForSignedVisit(tx as never, { orgId: ORG, visitId: VISIT, signedByUserId: USER });
    const sql = calls[0]!.sql.replace(/\s+/g, " ");
    expect(sql).toContain("FROM patient_medication pm");
    expect(sql).toContain("pm.patient_id = cp.patient_id AND pm.org_id = cp.org_id AND pm.status = 'active'");
    // CONTROL: the superseded column is not what is frozen.
    expect(sql).not.toContain("cp.active_medications");
  });
});

describe("upsertCarePlan — medications are the chart's", () => {
  it("never writes the plan's own medication column, so a save cannot bring the old list back", async () => {
    await upsertCarePlan({ orgId: ORG, patientId: PATIENT, document: {}, primarySymptoms: ["Pain"] });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO care_plan ("))!;
    // The statement, without its comments (which explain the column's end).
    expect(insert.sql.replace(/--[^\n]*/g, "")).not.toContain("active_medications");
  });
});

describe("upsertCarePlan — an edit made during a visit", () => {
  it("records the visit as the plan's last update, without a snapshot per save", async () => {
    await upsertCarePlan({
      orgId: ORG,
      patientId: PATIENT,
      document: { type: "doc" },
      primarySymptoms: ["Dyspnea", "Nausea"],
      visitId: VISIT,
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO care_plan ("))!;
    expect(insert.values).toContain(VISIT);
    expect(insert.values).toContainEqual(["Dyspnea", "Nausea"]);
    expect(calls.some((c) => c.sql.includes("care_plan_version"))).toBe(false);
  });

  it("CONTROL: refuses another patient's visit and writes nothing", async () => {
    await expect(
      upsertCarePlan({ orgId: ORG, patientId: PATIENT, document: {}, visitId: OTHER_PATIENTS_VISIT }),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(calls.some((c) => c.sql.includes("INSERT INTO care_plan"))).toBe(false);
  });

  it("CONTROL: an edit outside a visit names none, and stops naming the last one", async () => {
    await upsertCarePlan({ orgId: ORG, patientId: PATIENT, document: {} });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO care_plan ("))!;
    expect(insert.values).not.toContain(VISIT);
    expect(calls.some((c) => c.sql.includes("FROM visit"))).toBe(false);
    // Overwritten, not COALESCEd: the plan was last updated outside a visit.
    expect(insert.sql.replace(/\s+/g, " ")).toContain("last_updated_visit_id = EXCLUDED.last_updated_visit_id");
  });

  it("refuses to tie an edit to a visit already signed, whose plan was frozen with it", async () => {
    for (const status of ["documented", "pending_billing", "billed", "cancelled", "no_show"]) {
      calls = [];
      visitStatus = status;
      await expect(
        upsertCarePlan({ orgId: ORG, patientId: PATIENT, document: {}, visitId: VISIT }),
      ).rejects.toMatchObject({ name: "ValidationError" });
      expect(calls.some((c) => c.sql.includes("INSERT INTO care_plan")), status).toBe(false);
    }
  });
});

describe("upsertCarePlan — the formal plan's structured parts (0116)", () => {
  it("writes the parts sent and keeps the ones not sent, a cleared review day included", async () => {
    await upsertCarePlan({
      orgId: ORG,
      patientId: PATIENT,
      document: {},
      structure: { escalation: [{ measure: "pain", threshold: 7 }], reviewOn: null },
      signedByUserId: USER,
    });
    const insert = calls.find((c) => c.sql.includes("INSERT INTO care_plan ("))!;
    const sql = insert.sql.replace(/\s+/g, " ");
    // A new plan's lists start empty, never NULL.
    expect(sql).toContain("COALESCE(¶::text[], ARRAY[]::text[])");
    expect(insert.values).toContain(JSON.stringify([{ measure: "pain", threshold: 7 }]));
    // Sent: goals, interventions, monitoring no; escalation and the review day yes.
    expect(insert.values.filter((v) => typeof v === "boolean")).toEqual([false, false, false, true, true]);
    expect(sql).toContain("escalation = CASE WHEN ¶ THEN EXCLUDED.escalation ELSE care_plan.escalation END");
  });

  it("audits which parts were saved, never what they say", async () => {
    await upsertCarePlan({
      orgId: ORG,
      patientId: PATIENT,
      document: {},
      structure: { goals: ["Pain at or below 4/10"], monitoring: [{ item: "Pain by phone", everyDays: 7, how: "phone" }] },
      signedByUserId: USER,
    });
    const audit = calls.find((c) => c.sql.includes("audit_log"))!;
    const payload = audit.values.find((v) => typeof v === "string" && v.includes('"parts"')) as string;
    expect(JSON.parse(payload)).toMatchObject({ version: 4, duringVisit: false, parts: ["document", "goals", "monitoring"] });
    expect(payload).not.toMatch(/Pain/);
  });

  it("a sign-off freezes them with the rest of the plan", async () => {
    await freezeCarePlanForSignedVisit(fakeTx() as never, { orgId: ORG, visitId: VISIT, signedByUserId: USER });
    const sql = calls[0]!.sql.replace(/\s+/g, " ");
    for (const col of ["goals", "interventions", "monitoring", "escalation", "review_on"]) {
      expect(sql).toContain(`cp.${col}`);
    }
  });
});
