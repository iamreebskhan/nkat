/**
 * The course of care (0115): acuity at a visit, hospice eligibility, events,
 * the discharge, the hospice outcome and readmission. lib/db is mocked with a
 * fake tx that records every statement and answers the reads each test sets
 * up; the practice's today is 2026-10-28.
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
  addEvent,
  addHospiceAssessment,
  dischargePatient,
  getClinicalCourse,
  readmitPatient,
  recordHospiceStay,
  setVisitAcuity,
  updateEvent,
} from "../clinical-course.service";
import {
  AddEventSchema,
  HospiceStaySchema,
  readmissionIds,
  type HospiceStay,
  type PatientEventView,
} from "../clinical-course.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const VISIT = "55555555-5555-4555-8555-555555555555";
const CODE = "66666666-6666-4666-8666-666666666666";
const DISCHARGE = "77777777-7777-4777-8777-777777777777";
const ITEM = "c1000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
let patient: { status: string; admitted_on: string | null } | null;
let visit: { patient_id: string; status: string } | null;
/** Whether a visit named in a payload is this patient's. */
let visitIsPatients: boolean;
/** The practice's discharge code asked for, when it is one and active. */
let code: { code: string; category: string } | null;
/** The discharge in force. */
let current: {
  id: string; category: string; discharged_on: string; hospice_admitted_on: string | null; hospice_ended_on: string | null;
} | null;
let event: { kind: string; occurred_on: string; voided_at: Date | null } | null;
let eventRows: unknown[];
let dischargeRows: unknown[];
/** The admitting referral's triage acuity. */
let triageRows: unknown[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("AS admitted_on, acuity FROM patient")) return Promise.resolve(patient ? [{ ...patient, acuity: "high" }] : []);
    if (sql.includes("AS admitted_on FROM patient")) return Promise.resolve(patient ? [patient] : []);
    if (sql.includes("SELECT patient_id, status FROM visit")) return Promise.resolve(visit ? [visit] : []);
    if (sql.includes("SELECT id FROM visit WHERE id")) return Promise.resolve(visitIsPatients ? [{ id: VISIT }] : []);
    if (sql.includes("FROM org_reason_code")) return Promise.resolve(code ? [code] : []);
    if (sql.includes("FOR UPDATE OF d")) return Promise.resolve(current ? [current] : []);
    if (sql.includes("FROM patient_discharge") && sql.includes("FOR UPDATE")) {
      return Promise.resolve(current ? [{ id: current.id, discharged_on: current.discharged_on }] : []);
    }
    if (sql.includes("FROM patient_event") && sql.includes("FOR UPDATE")) return Promise.resolve(event ? [event] : []);
    if (sql.includes("FROM patient_event e")) return Promise.resolve(eventRows);
    if (sql.includes("ORDER BY d.recorded_at DESC")) return Promise.resolve(dischargeRows);
    if (sql.includes("t.preliminary_acuity IS NOT NULL")) return Promise.resolve(triageRows);
    if (sql.includes("RETURNING id")) return Promise.resolve([{ id: ITEM }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  patient = { status: "active", admitted_on: "2026-09-01" };
  visit = { patient_id: PATIENT, status: "in_progress" };
  visitIsPatients = true;
  code = { code: "03", category: "goals_met" };
  current = null;
  event = { kind: "fall", occurred_on: "2026-10-01", voided_at: null };
  eventRows = [];
  dischargeRows = [];
  triageRows = [];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const wrote = (fragment: string) => calls.some((c) => c.sql.includes(fragment));
const find = (fragment: string) => calls.find((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const who = { orgId: ORG, userId: USER, patientId: PATIENT };

describe("acuity at a visit", () => {
  it("records the NP's acuity once per visit and makes it the patient's", async () => {
    await setVisitAcuity({ orgId: ORG, userId: USER, visitId: VISIT, acuity: "critical" });
    const ins = find("INSERT INTO patient_acuity_event")!;
    expect(ins.sql).toContain("'visit'");
    expect(ins.sql).toContain("ON CONFLICT (visit_id)");
    expect(ins.values).toEqual(expect.arrayContaining(["critical", VISIT, PATIENT]));
    expect(find("UPDATE patient SET acuity")!.values).toEqual(expect.arrayContaining(["critical", PATIENT]));
    expect(audited()[0]).toMatchObject({
      action: "acuity_change", targetType: "visit", targetId: VISIT, payload: { source: "visit", acuity: "critical" },
    });
  });

  it("CONTROL: refuses a signed visit, writing nothing", async () => {
    visit = { patient_id: PATIENT, status: "documented" };
    await expect(setVisitAcuity({ orgId: ORG, userId: USER, visitId: VISIT, acuity: "low" })).rejects.toThrow(/signed or closed/);
    expect(wrote("INSERT INTO patient_acuity_event")).toBe(false);
    expect(wrote("UPDATE patient")).toBe(false);
    expect(audited()).toHaveLength(0);
  });
});

describe("hospice eligibility", () => {
  it("records yes or no with its day, and audits no basis", async () => {
    await addHospiceAssessment({ ...who, payload: { eligible: true, assessedOn: "2026-10-27", basis: "PPS 30%, weight loss" } });
    const ins = find("INSERT INTO hospice_eligibility_assessment")!;
    expect(ins.values).toEqual(expect.arrayContaining([true, "2026-10-27", "PPS 30%, weight loss"]));
    expect(audited()[0]).toMatchObject({ action: "hospice_assessment", payload: { assessmentId: ITEM, eligible: true } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/PPS|weight/);
  });

  it("CONTROL: refuses a day after today, and another patient's visit", async () => {
    await expect(addHospiceAssessment({ ...who, payload: { eligible: false, assessedOn: "2026-10-29" } })).rejects.toThrow(/after today/);
    visitIsPatients = false;
    await expect(
      addHospiceAssessment({ ...who, payload: { eligible: false, assessedOn: "2026-10-27", visitId: VISIT } }),
    ).rejects.toThrow(/not this patient's/);
    expect(wrote("INSERT INTO hospice_eligibility_assessment")).toBe(false);
  });
});

describe("significant events", () => {
  it("records an admission with its discharge day, and audits only the kind", async () => {
    await addEvent({
      ...who,
      payload: { kind: "hospital_admission", occurredOn: "2026-10-01", endedOn: "2026-10-05", facility: "Mercy General", description: "CHF exacerbation" },
    });
    expect(find("INSERT INTO patient_event")!.values).toEqual(
      expect.arrayContaining(["hospital_admission", "2026-10-01", "2026-10-05", "Mercy General", "CHF exacerbation"]),
    );
    expect(audited()[0]).toMatchObject({ action: "patient_event_change", payload: { op: "add", kind: "hospital_admission", eventId: ITEM } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Mercy|CHF/);
  });

  it("CONTROL: the schema refuses a discharge day off an admission, an injury off a fall, and a discharge before the admission", () => {
    expect(AddEventSchema.safeParse({ kind: "fall", occurredOn: "2026-10-01", endedOn: "2026-10-02" }).success).toBe(false);
    expect(AddEventSchema.safeParse({ kind: "ed_visit", occurredOn: "2026-10-01", injury: true }).success).toBe(false);
    expect(AddEventSchema.safeParse({ kind: "hospital_admission", occurredOn: "2026-10-05", endedOn: "2026-10-01" }).success).toBe(false);
    expect(AddEventSchema.safeParse({ kind: "fall", occurredOn: "2026-10-01", injury: true }).success).toBe(true);
  });

  it("takes a hospice discussion and a hospice referral to a named hospice (doc:92), and nothing an admission or a fall has", () => {
    expect(AddEventSchema.safeParse({ kind: "hospice_discussion", occurredOn: "2026-10-01", description: "With daughter" }).success).toBe(true);
    expect(AddEventSchema.safeParse({ kind: "hospice_referral", occurredOn: "2026-10-01", facility: "Partner Hospice" }).success).toBe(true);
    // CONTROL
    expect(AddEventSchema.safeParse({ kind: "hospice_referral", occurredOn: "2026-10-01", endedOn: "2026-10-02" }).success).toBe(false);
    expect(AddEventSchema.safeParse({ kind: "hospice_discussion", occurredOn: "2026-10-01", injury: false }).success).toBe(false);
    expect(AddEventSchema.safeParse({ kind: "hospice_visit", occurredOn: "2026-10-01" }).success).toBe(false);
  });

  it("CONTROL: refuses an event after today", async () => {
    await expect(addEvent({ ...who, payload: { kind: "fall", occurredOn: "2026-10-29" } })).rejects.toThrow(/after today/);
    expect(wrote("INSERT INTO patient_event")).toBe(false);
  });

  it("voids an event with a reason, keeping the row", async () => {
    await updateEvent({ ...who, eventId: ITEM, payload: { void: { reason: "Wrong patient" } } });
    expect(find("UPDATE patient_event SET voided_at")!.values).toContain("Wrong patient");
    expect(wrote("DELETE")).toBe(false);
    expect(audited()[0]).toMatchObject({ payload: { op: "void", kind: "fall", eventId: ITEM } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Wrong/);
  });

  it("CONTROL: a voided event takes no change, and a fall takes no discharge day", async () => {
    event = { kind: "fall", occurred_on: "2026-10-01", voided_at: new Date("2026-10-02T00:00:00Z") };
    await expect(updateEvent({ ...who, eventId: ITEM, payload: { description: "x" } })).rejects.toThrow(/voided/);
    event = { kind: "fall", occurred_on: "2026-10-01", voided_at: null };
    await expect(updateEvent({ ...who, eventId: ITEM, payload: { endedOn: "2026-10-02" } })).rejects.toThrow(/Only an admission/);
    expect(wrote("UPDATE patient_event")).toBe(false);
  });
});

describe("readmissions", () => {
  const adm = (id: string, occurredOn: string, endedOn: string | null, voidedAt: string | null = null) => ({
    id, kind: "hospital_admission" as const, occurredOn, endedOn, voidedAt,
  });

  it("tags an admission within 30 days of the last one's discharge", () => {
    const ids = readmissionIds([adm("a", "2026-09-01", "2026-09-05"), adm("b", "2026-09-20", null), adm("c", "2026-11-30", null)]);
    expect([...ids]).toEqual(["b"]);
  });

  it("CONTROL: a voided admission counts for nothing, and an ED visit is not an admission", () => {
    expect(readmissionIds([adm("a", "2026-09-01", "2026-09-05", "2026-09-06T00:00:00Z"), adm("b", "2026-09-20", null)]).size).toBe(0);
    expect(
      readmissionIds([{ id: "e", kind: "ed_visit", occurredOn: "2026-09-02", endedOn: null, voidedAt: null }, adm("b", "2026-09-20", null)]).size,
    ).toBe(0);
  });
});

describe("the discharge", () => {
  const discharge = (payload: Partial<Parameters<typeof dischargePatient>[0]["payload"]> = {}) =>
    dischargePatient({ ...who, payload: { dischargedOn: "2026-10-27", reasonCodeId: CODE, ...payload } });

  it("discharges to hospice with the practice's code, and writes discharged_at", async () => {
    code = { code: "01", category: "hospice_partner" };
    expect(await discharge({ hospiceName: "Partner Hospice", hospiceAdmittedOn: "2026-10-28" })).toEqual({ id: ITEM, status: "discharged" });
    expect(find("INSERT INTO patient_discharge")!.values).toEqual(
      expect.arrayContaining(["2026-09-01", "2026-10-27", CODE, "Partner Hospice", "2026-10-28"]),
    );
    const upd = find("UPDATE patient SET status")!;
    expect(upd.sql).toContain("discharged_at = now()");
    expect(upd.values).toContain("discharged");
    expect(audited()[0]).toMatchObject({
      action: "patient_discharge", payload: { op: "discharge", reasonCode: "01", category: "hospice_partner", status: "discharged" },
    });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Partner Hospice/);
  });

  it("a death code makes the patient deceased, on the discharge day unless another is given", async () => {
    code = { code: "08", category: "death" };
    expect((await discharge()).status).toBe("deceased");
    // The discharge day, and the death day it stands in for.
    expect(find("INSERT INTO patient_discharge")!.values.filter((v) => v === "2026-10-27")).toHaveLength(2);
    expect(find("UPDATE patient SET status")!.values).toContain("deceased");
  });

  it("CONTROL: refuses a patient not under care, a code not the practice's, hospice details or a death day the code does not take, and a day outside the episode", async () => {
    patient = { status: "discharged", admitted_on: "2026-09-01" };
    await expect(discharge()).rejects.toThrow(/under care/);
    patient = { status: "active", admitted_on: "2026-09-01" };
    code = null;
    await expect(discharge()).rejects.toThrow(/discharge reasons/);
    code = { code: "03", category: "goals_met" };
    await expect(discharge({ hospiceName: "Partner Hospice" })).rejects.toThrow(/discharge to hospice/);
    await expect(discharge({ diedOn: "2026-10-27" })).rejects.toThrow(/death discharge code/);
    await expect(discharge({ dischargedOn: "2026-08-31" })).rejects.toThrow(/Care began on 2026-09-01/);
    await expect(discharge({ dischargedOn: "2026-10-29" })).rejects.toThrow(/after today/);
    expect(wrote("INSERT INTO patient_discharge")).toBe(false);
    expect(wrote("UPDATE patient SET status")).toBe(false);
  });

  it("locks the patient first, so two discharges take turns", async () => {
    await discharge();
    expect(calls[0]!.sql).toContain("FOR NO KEY UPDATE");
  });
});

describe("the hospice stay", () => {
  beforeEach(() => {
    patient = { status: "discharged", admitted_on: "2026-09-01" };
    current = {
      id: DISCHARGE, category: "hospice_partner", discharged_on: "2026-10-01", hospice_admitted_on: "2026-10-02", hospice_ended_on: null,
    };
  });
  const stay = (payload: HospiceStay) => recordHospiceStay({ ...who, payload });

  it("takes the hospice and its admission day on their own, keeping what is stored, and leaves the status alone", async () => {
    current = { ...current!, hospice_admitted_on: null };
    await stay({ hospiceName: "Partner Hospice", hospiceAdmittedOn: "2026-10-03" });
    const upd = find("UPDATE patient_discharge SET")!;
    expect(upd.values).toEqual(expect.arrayContaining(["Partner Hospice", "2026-10-03"]));
    expect(upd.sql).toContain("COALESCE(");
    expect(find("UPDATE patient SET status")).toBeUndefined();
    expect(audited()[0]).toMatchObject({
      payload: { op: "hospice_details", dischargeId: DISCHARGE, fields: ["hospiceName", "hospiceAdmittedOn"] },
    });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Partner/);
  });

  it("a death in hospice records the death and makes the patient deceased", async () => {
    await stay({ hospiceEndedOn: "2026-10-20", hospiceEndReason: "death" });
    const upd = find("UPDATE patient_discharge SET")!;
    expect(upd.values).toEqual(expect.arrayContaining(["death", DISCHARGE]));
    // The stay's end, and the death on it.
    expect(upd.values.filter((v) => v === "2026-10-20")).toHaveLength(2);
    expect(find("UPDATE patient SET status")!.values).toContain("deceased");
    expect(audited()[0]).toMatchObject({ payload: { op: "hospice_outcome", dischargeId: DISCHARGE, endReason: "death" } });
  });

  it("correcting a death to a live discharge clears the death, and the patient is discharged again", async () => {
    current = { ...current!, hospice_ended_on: "2026-10-20" };
    await stay({ hospiceEndedOn: "2026-10-20", hospiceEndReason: "live_discharge" });
    const upd = find("UPDATE patient_discharge SET")!;
    // The end day only: no death day goes with it.
    expect(upd.values.filter((v) => v === "2026-10-20")).toHaveLength(1);
    const status = find("UPDATE patient SET status")!;
    expect(status.values).toContain("discharged");
    // Never a chart archived since, nor one back under care.
    expect(status.sql).toContain("status IN ('discharged', 'deceased')");
  });

  it("CONTROL: refuses a patient not discharged to hospice, an ending with no admission day or before it, and a day after today", async () => {
    current = { ...current!, category: "goals_met" };
    await expect(stay({ hospiceAdmittedOn: "2026-10-02" })).rejects.toThrow(/not discharged to hospice/);
    current = { id: DISCHARGE, category: "hospice_other", discharged_on: "2026-10-01", hospice_admitted_on: null, hospice_ended_on: null };
    await expect(stay({ hospiceEndedOn: "2026-10-05", hospiceEndReason: "revocation" })).rejects.toThrow(/Say when the hospice admitted/);
    current = { ...current, hospice_admitted_on: "2026-10-10" };
    await expect(stay({ hospiceEndedOn: "2026-10-05", hospiceEndReason: "revocation" })).rejects.toThrow(/ended before it began/);
    // An admission day moved past the ending already stored.
    current = { ...current, hospice_admitted_on: "2026-10-02", hospice_ended_on: "2026-10-05" };
    await expect(stay({ hospiceAdmittedOn: "2026-10-06" })).rejects.toThrow(/ended before it began/);
    await expect(stay({ hospiceAdmittedOn: "2026-10-29" })).rejects.toThrow(/after today/);
    expect(wrote("UPDATE patient_discharge")).toBe(false);
    expect(wrote("UPDATE patient SET")).toBe(false);
  });

  it("CONTROL: the schema takes the end day and how it ended only together, and refuses an empty change", () => {
    expect(HospiceStaySchema.safeParse({ hospiceEndedOn: "2026-10-20" }).success).toBe(false);
    expect(HospiceStaySchema.safeParse({ hospiceEndReason: "death" }).success).toBe(false);
    expect(HospiceStaySchema.safeParse({}).success).toBe(false);
    expect(HospiceStaySchema.safeParse({ hospiceAdmittedOn: "2026-10-02" }).success).toBe(true);
  });

  it("locks the patient before the discharge, the order a readmission takes", async () => {
    await stay({ hospiceEndedOn: "2026-10-20", hospiceEndReason: "transfer" });
    const patientLock = calls.findIndex((c) => c.sql.includes("FOR NO KEY UPDATE"));
    const dischargeLock = calls.findIndex((c) => c.sql.includes("FOR UPDATE OF d"));
    expect(patientLock).toBeGreaterThanOrEqual(0);
    expect(patientLock).toBeLessThan(dischargeLock);
  });
});

describe("readmission", () => {
  beforeEach(() => {
    patient = { status: "discharged", admitted_on: "2026-09-01" };
    current = { id: DISCHARGE, category: "goals_met", discharged_on: "2026-10-01", hospice_admitted_on: null, hospice_ended_on: null };
  });

  it("keeps the discharge, marked reversed, and starts a new episode on the readmission day", async () => {
    await readmitPatient({ ...who, payload: { readmittedOn: "2026-10-20", reason: "Back under care" } });
    expect(find("UPDATE patient_discharge SET reversed_at = now()")!.values).toEqual(
      expect.arrayContaining(["Back under care", DISCHARGE]),
    );
    const upd = find("UPDATE patient SET status = 'active'")!;
    expect(upd.sql).toContain("discharged_at = NULL");
    expect(upd.values).toContain("2026-10-20");
    expect(wrote("DELETE")).toBe(false);
    expect(audited()[0]).toMatchObject({ payload: { op: "readmit", dischargeId: DISCHARGE } });
    expect(JSON.stringify(audited()[0]!.payload)).not.toMatch(/Back under care/);
  });

  it("CONTROL: refuses a patient under care, and a readmission before the discharge", async () => {
    patient = { status: "active", admitted_on: "2026-09-01" };
    await expect(readmitPatient({ ...who, payload: { readmittedOn: "2026-10-20", reason: "x" } })).rejects.toThrow(/not discharged/);
    patient = { status: "discharged", admitted_on: "2026-09-01" };
    await expect(readmitPatient({ ...who, payload: { readmittedOn: "2026-09-30", reason: "x" } })).rejects.toThrow(
      /discharge was on 2026-10-01/,
    );
    expect(wrote("UPDATE patient")).toBe(false);
  });
});

describe("reading the course", () => {
  const evRow = (id: string, occurred_on: string, ended_on: string | null) => ({
    id, kind: "hospital_admission" as PatientEventView["kind"], occurred_on, ended_on, facility: null, injury: null,
    description: null, recorded_by_name: null, recorded_at: new Date("2026-10-01T12:00:00Z"), voided_at: null, void_reason: null,
  });

  it("counts the days on service and in hospice, and tags the readmission", async () => {
    patient = { status: "deceased", admitted_on: "2026-09-01" };
    eventRows = [evRow("b", "2026-09-20", null), evRow("a", "2026-09-01", "2026-09-05")];
    dischargeRows = [
      {
        id: DISCHARGE, admitted_on: "2026-09-01", discharged_on: "2026-10-01", code: "01", label: "Hospice - partner hospice",
        category: "hospice_partner", note: null, hospice_name: null, hospice_admitted_on: "2026-10-02",
        hospice_ended_on: "2026-10-20", hospice_end_reason: "death", died_on: "2026-10-20", recorded_by_name: null,
        recorded_at: new Date("2026-10-01T12:00:00Z"), reversed_at: null, reversed_reason: null,
      },
    ];
    const c = await getClinicalCourse({ orgId: ORG, patientId: PATIENT });
    expect(c).toMatchObject({ status: "deceased", admittedOn: "2026-09-01", practiceToday: "2026-10-28" });
    expect(c.discharges[0]).toMatchObject({ lengthOfStayDays: 30, hospiceLengthOfStayDays: 18, reversedAt: null });
    expect(c.events.find((e) => e.id === "b")!.readmission).toBe(true);
    expect(c.events.find((e) => e.id === "a")!.readmission).toBe(false);
  });

  it("shows the triage's acuity from the referral, which a chart admitted before the history began has no event for", async () => {
    triageRows = [{ preliminary_acuity: "medium", triaged_on: "2026-08-01" }];
    const c = await getClinicalCourse({ orgId: ORG, patientId: PATIENT });
    expect(c.acuity).toMatchObject({ current: "high", triage: { acuity: "medium", on: "2026-08-01" } });
    // The practice's day, as every other day on the card.
    expect(find("t.preliminary_acuity IS NOT NULL")!.sql).toContain("AT TIME ZONE o.timezone");
    // CONTROL: no referral triage, no triage acuity.
    triageRows = [];
    expect((await getClinicalCourse({ orgId: ORG, patientId: PATIENT })).acuity.triage).toBeNull();
  });
});
