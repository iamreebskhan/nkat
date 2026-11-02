/**
 * PCM/CCM time and the month's charge (0117): what each write checks, what it
 * writes, and what it audits. lib/db is mocked with a fake tx that answers by
 * statement; the practice's today is 2026-10-28 in New York.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/org/org-time-zone", () => ({ readOrgTimeZone: vi.fn(async () => "America/New_York") }));
vi.mock("@/lib/features/org/org-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/org/org-date")>()),
  orgToday: vi.fn(() => "2026-10-28"),
}));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/features/superbills/auto-draft", () => ({
  autoDraftSuperbill: vi.fn(async () => ({ superbillId: "5b000000-0000-4000-8000-000000000001", reason: null })),
}));
vi.mock("../escalation.service", () => ({ raiseForReadings: vi.fn(), withdrawForSource: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";
import { autoDraftSuperbill } from "@/lib/features/superbills/auto-draft";

import { logTime, raiseCharge, voidTime } from "../care-management.service";
import { createPhoneEncounter, voidPhoneEncounter } from "../phone-encounter.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_NP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LPN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ENROLMENT = "e1000000-0000-4000-8000-000000000001";
const ENTRY = "70000000-0000-4000-8000-000000000001";
const CALL = "ca000000-0000-4000-8000-000000000001";
const VISIT = "0e000000-0000-4000-8000-000000000001";
const CHARGE = "c4000000-0000-4000-8000-000000000001";

interface Entry {
  id: string; enrollment_id: string; service_on: string; minutes: number; activity: string; note: string | null;
  performed_by_user_id: string; performed_by_name: string; performer_kind: "qhp" | "clinical_staff";
  phone_encounter_id: string | null; voided_at: Date | null; void_reason: string | null;
}

let calls: { sql: string; values: unknown[] }[];
let enrollment: { id: string; program: "pcm" | "ccm"; enrolled_on: string; ended_on: string | null; consent_on: string; consent_method: string };
let credential: string | null;
let charged: boolean;
let hasPlan: boolean;
let problems: string[];
let entries: Entry[];
let entryRow: { service_on: string; voided_at: Date | null; phone_encounter_id: string | null };
let callTime: boolean;

const entry = (over: Partial<Entry>): Entry => ({
  id: ENTRY, enrollment_id: ENROLMENT, service_on: "2026-10-03", minutes: 10, activity: "care_coordination", note: null,
  performed_by_user_id: LPN, performed_by_name: "Lena Park", performer_kind: "clinical_staff", phone_encounter_id: null,
  voided_at: null, void_reason: null, ...over,
});

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM care_program_enrollment") && sql.includes("FOR NO KEY UPDATE")) return Promise.resolve([enrollment]);
    if (sql.includes("SELECT credential FROM clinician_profile")) return Promise.resolve(credential ? [{ credential }] : []);
    if (sql.includes("FROM care_management_charge c") && sql.includes("JOIN org o")) {
      return Promise.resolve(charged ? [{ raised_on: "2026-10-20" }] : []);
    }
    if (sql.includes("INSERT INTO care_management_time")) return Promise.resolve([{ id: ENTRY }]);
    if (sql.includes("SELECT enrollment_id FROM care_management_time")) return Promise.resolve([{ enrollment_id: ENROLMENT }]);
    if (sql.includes("SELECT id, enrollment_id FROM care_management_time")) {
      return Promise.resolve(callTime ? [{ id: ENTRY, enrollment_id: ENROLMENT }] : []);
    }
    if (sql.includes("FROM care_management_time") && sql.includes("FOR UPDATE")) return Promise.resolve([entryRow]);
    if (sql.includes("FROM care_management_time t")) return Promise.resolve(entries);
    if (sql.includes("FROM care_plan")) return Promise.resolve(hasPlan ? [{ ok: 1 }] : []);
    if (sql.includes("SELECT icd10 FROM patient_problem")) return Promise.resolve(problems.map((icd10) => ({ icd10 })));
    if (sql.includes("INSERT INTO org_visit_type")) return Promise.resolve(1);
    if (sql.includes("SELECT coding_basis FROM org_visit_type")) return Promise.resolve([{ coding_basis: "care_management" }]);
    if (sql.includes("FROM app_user")) return Promise.resolve([{ name: "Helen Okafor" }]);
    if (sql.includes("INSERT INTO visit")) return Promise.resolve([{ id: VISIT }]);
    if (sql.includes("INSERT INTO care_management_charge")) return Promise.resolve([{ id: CHARGE }]);
    if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("INSERT INTO phone_encounter")) return Promise.resolve([{ id: CALL }]);
    if (sql.includes("FROM phone_encounter") && sql.includes("FOR UPDATE")) return Promise.resolve([{ voided_at: null }]);
    return Promise.resolve(sql.trimStart().startsWith("UPDATE") ? 1 : []);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  enrollment = { id: ENROLMENT, program: "ccm", enrolled_on: "2026-10-01", ended_on: null, consent_on: "2026-09-30", consent_method: "verbal" };
  credential = "NP";
  charged = false;
  hasPlan = true;
  problems = ["C34.12", "I50.9"];
  entries = [];
  entryRow = { service_on: "2026-10-03", voided_at: null, phone_encounter_id: null };
  callTime = false;
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const find = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1]);
const log = (over: Partial<Parameters<typeof logTime>[0]["payload"]> = {}) =>
  logTime({
    orgId: ORG, userId: ME, patientId: PATIENT,
    payload: { enrollmentId: ENROLMENT, serviceOn: "2026-10-27", minutes: 15, activity: "care_coordination", note: "Spoke to the pharmacy", ...over },
  });

describe("logging time", () => {
  it("logs a practitioner's minutes as theirs and a nurse's as clinical staff, by the credential", async () => {
    await log();
    expect(find("INSERT INTO care_management_time")[0]!.values).toEqual(
      expect.arrayContaining([ENROLMENT, ME, "qhp", "2026-10-27", 15, "care_coordination", "Spoke to the pharmacy"]),
    );
    credential = "LPN";
    await log();
    expect(find("INSERT INTO care_management_time")[1]!.values).toContain("clinical_staff");
  });

  it("audits the program, whose time, the minutes and the activity — never the note", async () => {
    await log();
    expect(audited()[0]).toMatchObject({
      action: "care_management_time", targetType: "patient", targetId: PATIENT,
      payload: { op: "log", entryId: ENTRY, program: "ccm", kind: "qhp", minutes: 15, activity: "care_coordination", fromCall: false },
    });
    expect(JSON.stringify(audited())).not.toContain("pharmacy");
  });

  it("locks the enrolment before anything is read, so a charge and a time entry never pass each other", async () => {
    await log();
    expect(calls[0]!.sql).toContain("FOR NO KEY UPDATE");
    expect(calls[0]!.sql).toContain("FROM care_program_enrollment");
  });

  it("CONTROL: refuses a day after today, before the enrolment, after its end, in a charged month, and time with no credential", async () => {
    await expect(log({ serviceOn: "2026-10-29" })).rejects.toThrow(/after today/);
    await expect(log({ serviceOn: "2026-09-30" })).rejects.toThrow(/Enrolled in CCM on 2026-10-01/);
    enrollment = { ...enrollment, ended_on: "2026-10-20" };
    await expect(log({ serviceOn: "2026-10-21" })).rejects.toThrow(/ended on 2026-10-20/);
    enrollment = { ...enrollment, ended_on: null };
    charged = true;
    await expect(log()).rejects.toThrow(/October 2026 is already charged for CCM \(raised on 2026-10-20\)/);
    charged = false;
    credential = null;
    await expect(log()).rejects.toThrow(/credential isn't recorded/);
    expect(find("INSERT INTO care_management_time")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("voiding time", () => {
  const voidIt = () => voidTime({ orgId: ORG, userId: ME, patientId: PATIENT, entryId: ENTRY, reason: "Wrong patient" });

  it("keeps the entry, marked with the reason", async () => {
    await voidIt();
    expect(find("UPDATE care_management_time")[0]!.values).toContain("Wrong patient");
    expect(find("DELETE")).toHaveLength(0);
    expect(audited()[0]!.payload).toMatchObject({ op: "void", entryId: ENTRY, program: "ccm", fromCall: false });
  });

  it("CONTROL: refuses time its month's charge stands on, and time already voided", async () => {
    charged = true;
    await expect(voidIt()).rejects.toThrow(/charge \(raised on 2026-10-20\) is billed on this time/);
    charged = false;
    entryRow = { ...entryRow, voided_at: new Date() };
    await expect(voidIt()).rejects.toThrow(/already voided/);
    expect(find("UPDATE care_management_time")).toHaveLength(0);
  });
});

describe("raising the month's charge", () => {
  const raise = (over: Partial<Parameters<typeof raiseCharge>[0]["payload"]> = {}) =>
    raiseCharge({
      orgId: ORG, userId: ME, patientId: PATIENT,
      payload: { enrollmentId: ENROLMENT, month: "2026-10", basis: "staff", placeOfService: "12", diagnoses: ["C34.12", "I50.9"], ...over },
    });

  beforeEach(() => {
    entries = [
      entry({ service_on: "2026-10-03", minutes: 15 }),
      entry({ id: "70000000-0000-4000-8000-000000000002", service_on: "2026-10-09", minutes: 10, performed_by_user_id: ME, performer_kind: "qhp" }),
      entry({ id: "70000000-0000-4000-8000-000000000003", service_on: "2026-10-10", minutes: 30, voided_at: new Date(), void_reason: "x" }),
    ];
  });

  it("carries the month on a signed visit, submitted for billing, dated noon of the day the time was reached where the practice is", async () => {
    const r = await raise();
    const visit = find("INSERT INTO visit")[0]!;
    expect(visit.values).toEqual(
      expect.arrayContaining([PATIENT, ME, "pcm_ccm_month", "2026-10-09", "America/New_York", 25, "NP", "12"]),
    );
    expect(visit.values).toContainEqual(["99490"]);
    expect(visit.values).toContainEqual(["C34.12", "I50.9"]);
    expect(visit.sql.replace(/\s+/g, " ")).toContain("::date + time '12:00') AT TIME ZONE");
    expect(visit.sql).toContain("'pending_billing', now()");
    // The voided entry is not counted.
    expect(find("INSERT INTO care_management_charge")[0]!.values).toEqual(
      expect.arrayContaining([ENROLMENT, "2026-10-01", VISIT, "staff", "2026-10-09", 10, 15, ME]),
    );
    expect(vi.mocked(autoDraftSuperbill)).toHaveBeenCalledWith({ orgId: ORG, visitId: VISIT, actorUserId: ME });
    expect(r).toEqual({ chargeId: CHARGE, visitId: VISIT, superbillId: "5b000000-0000-4000-8000-000000000001", autoDraftError: null });
  });

  it("writes the reserved type inactive, and audits codes, the set and counts — never the diagnoses", async () => {
    await raise();
    expect(find("INSERT INTO org_visit_type")[0]!.sql).toContain("ON CONFLICT (org_id, lower(slug)) DO NOTHING");
    expect(find("INSERT INTO org_visit_type")[0]!.sql).toContain("'care_management', false");
    const a = audited().find((x) => x.action === "care_management_charge")!;
    expect(a.payload).toMatchObject({ op: "raise", chargeId: CHARGE, visitId: VISIT, program: "ccm", basis: "staff", cptCodes: ["99490"], addOnUnits: 0, diagnosisCount: 2 });
    expect(JSON.stringify(a)).not.toContain("C34");
  });

  it("bills the practitioner's set on the raiser's own time only", async () => {
    entries = [
      entry({ service_on: "2026-10-05", minutes: 20, performed_by_user_id: ME, performer_kind: "qhp" }),
      entry({ id: "70000000-0000-4000-8000-000000000002", service_on: "2026-10-06", minutes: 15, performed_by_user_id: OTHER_NP, performer_kind: "qhp" }),
    ];
    // CONTROL: 20 of my own minutes and 15 of a colleague's are not 30 of mine.
    await expect(raise({ basis: "qhp" })).rejects.toThrow(/Your own CCM time in October 2026 is 20 minutes; 99491 needs 30/);
    entries.push(entry({ id: "70000000-0000-4000-8000-000000000004", service_on: "2026-10-12", minutes: 10, performed_by_user_id: ME, performer_kind: "qhp" }));
    await raise({ basis: "qhp" });
    expect(find("INSERT INTO visit")[0]!.values).toContainEqual(["99491"]);
    // Only my 30 minutes, as the practitioner's; no staff minutes.
    expect(find("INSERT INTO care_management_charge")[0]!.values).toEqual(expect.arrayContaining(["qhp", "2026-10-12", 30, 0]));
  });

  it("CONTROL: refuses a nurse, no care plan, a diagnosis off the problem list, one diagnosis for CCM, and time that falls short", async () => {
    credential = "LPN";
    await expect(raise()).rejects.toThrow(/billed by a practitioner.*Your credential on the Team page is LPN/);
    credential = "NP";
    hasPlan = false;
    await expect(raise()).rejects.toThrow(/Write the care plan first/);
    hasPlan = true;
    await expect(raise({ diagnoses: ["C34.12", "J44.1"] })).rejects.toThrow(/Not on the active problem list: J44\.1/);
    await expect(raise({ diagnoses: ["C34.12"] })).rejects.toThrow(/two or more chronic conditions/);
    entries = [entry({ minutes: 19 })];
    await expect(raise()).rejects.toThrow(/October 2026's CCM time is 19 minutes; 99490 needs 20/);
    entries = [entry({ minutes: 25 })];
    await expect(raise({ addOnUnits: 1 })).rejects.toThrow(/supports 99490 alone/);
    expect(find("INSERT INTO visit")).toHaveLength(0);
    expect(find("INSERT INTO care_management_charge")).toHaveLength(0);
  });

  it("CONTROL: refuses a month not yet begun, one the enrolment was not in force in, and one already charged", async () => {
    await expect(raise({ month: "2026-11" })).rejects.toThrow(/November 2026 hasn't started/);
    enrollment = { ...enrollment, enrolled_on: "2026-10-01", ended_on: null };
    await expect(raise({ month: "2026-09" })).rejects.toThrow(/was not in force in September 2026/);
    charged = true;
    await expect(raise()).rejects.toThrow(/already charged for CCM/);
    expect(find("INSERT INTO visit")).toHaveLength(0);
  });

  it("returns the draft's failure rather than hiding it", async () => {
    vi.mocked(autoDraftSuperbill).mockResolvedValueOnce({ superbillId: null, reason: "No NPI on file." });
    const r = await raise();
    expect(r).toMatchObject({ visitId: VISIT, superbillId: null, autoDraftError: "No NPI on file." });
  });
});

describe("a call's minutes", () => {
  it("count toward the enrolment on the call's day where the practice is, in the call's transaction", async () => {
    // 10:30 pm on the 27th in New York is 02:30 UTC on the 28th.
    await createPhoneEncounter({
      orgId: ORG, userId: ME, patientId: PATIENT,
      payload: {
        occurredAt: "2026-10-28T02:30:00.000Z", direction: "outbound", spokeWith: "patient", minutes: 12, summary: "Check-in",
        countForEnrollmentId: ENROLMENT,
      },
    });
    expect(find("INSERT INTO care_management_time")[0]!.values).toEqual(
      expect.arrayContaining([ENROLMENT, "2026-10-27", 12, "phone", CALL]),
    );
    expect(audited().find((a) => a.action === "care_management_time")!.payload).toMatchObject({ fromCall: true, minutes: 12 });
  });

  it("CONTROL: a call that cannot count its minutes is refused whole, not saved without them", async () => {
    charged = true;
    await expect(
      createPhoneEncounter({
        orgId: ORG, userId: ME, patientId: PATIENT,
        // A time inside the mocked today, not the clock: without it the call
        // fell on the machine's day, and after midnight in New York it was
        // refused as after today before the charged month was ever reached.
        payload: {
          occurredAt: "2026-10-27T15:00:00.000Z", direction: "outbound", spokeWith: "patient", minutes: 12,
          summary: "Check-in", countForEnrollmentId: ENROLMENT,
        },
      }),
    ).rejects.toThrow(/already charged/);
    // The call's own insert is in the transaction the throw rolls back; the
    // time never got as far as one.
    expect(find("INSERT INTO care_management_time")).toHaveLength(0);
  });

  it("are voided with the call; a call whose month is charged is not voided", async () => {
    callTime = true;
    entryRow = { service_on: "2026-10-27", voided_at: null, phone_encounter_id: CALL };
    await voidPhoneEncounter({ orgId: ORG, userId: ME, patientId: PATIENT, encounterId: CALL, reason: "Wrong patient" });
    expect(find("UPDATE care_management_time")[0]!.values).toContain("Wrong patient");
    expect(find("UPDATE phone_encounter SET voided_at")).toHaveLength(1);
    calls = [];
    charged = true;
    await expect(
      voidPhoneEncounter({ orgId: ORG, userId: ME, patientId: PATIENT, encounterId: CALL, reason: "Wrong patient" }),
    ).rejects.toThrow(/billed on this time/);
    expect(find("UPDATE phone_encounter SET voided_at")).toHaveLength(0);
    expect(find("UPDATE care_management_time")).toHaveLength(0);
  });
});
