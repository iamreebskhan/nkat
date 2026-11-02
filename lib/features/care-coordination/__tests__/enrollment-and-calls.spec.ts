/**
 * PCM/CCM enrolment and telephone encounters (0116; doc:38, :52, :101). lib/db
 * is mocked with a fake tx; the practice's today is 2026-10-28.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/org/org-time-zone", () => ({ readOrgTimeZone: vi.fn(async () => "America/New_York") }));
vi.mock("@/lib/features/org/org-date", async (orig) => ({
  ...(await orig<typeof import("@/lib/features/org/org-date")>()),
  orgToday: vi.fn(() => "2026-10-28"),
}));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("../escalation.service", () => ({ raiseForReadings: vi.fn(), withdrawForSource: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { CreatePhoneEncounterSchema, EnrollSchema } from "../care-coordination.types";
import { endEnrollment, enroll } from "../enrollment.service";
import { raiseForReadings, withdrawForSource } from "../escalation.service";
import { createPhoneEncounter, voidPhoneEncounter } from "../phone-encounter.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ROW = "c1000000-0000-4000-8000-000000000001";

let calls: { sql: string; values: unknown[] }[];
let status: string;
let enrolledAlready: boolean;
let enrollment: { program: string; enrolled_on: string; ended_on: string | null } | null;
let callRow: { voided_at: Date | null } | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT status FROM patient")) return Promise.resolve([{ status }]);
    if (sql.includes("SELECT id FROM patient")) return Promise.resolve([{ id: PATIENT }]);
    if (sql.includes("SELECT id FROM care_program_enrollment")) return Promise.resolve(enrolledAlready ? [{ id: ROW }] : []);
    if (sql.includes("FROM care_program_enrollment") && sql.includes("FOR UPDATE")) return Promise.resolve(enrollment ? [enrollment] : []);
    if (sql.includes("FROM phone_encounter") && sql.includes("FOR UPDATE")) return Promise.resolve(callRow ? [callRow] : []);
    if (sql.includes("RETURNING id")) return Promise.resolve([{ id: ROW }]);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  status = "active";
  enrolledAlready = false;
  enrollment = { program: "pcm", enrolled_on: "2026-10-01", ended_on: null };
  callRow = { voided_at: null };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const find = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1].payload);
const enrol = (over: Partial<Parameters<typeof enroll>[0]["payload"]> = {}) =>
  enroll({
    orgId: ORG, userId: USER, patientId: PATIENT,
    payload: { program: "pcm", enrolledOn: "2026-10-28", consentOn: "2026-10-27", consentMethod: "verbal", ...over },
  });

describe("PCM/CCM enrolment", () => {
  it("enrols with the consent's day and how it was given, and audits the program", async () => {
    await enrol();
    expect(find("INSERT INTO care_program_enrollment")[0]!.values).toEqual(
      expect.arrayContaining(["pcm", "2026-10-28", "2026-10-27", "verbal"]),
    );
    expect(audited()[0]).toMatchObject({ op: "enroll", program: "pcm", consentMethod: "verbal" });
  });

  it("CONTROL: refuses a patient not under care, a second enrolment in force, and a day after today", async () => {
    status = "discharged";
    await expect(enrol()).rejects.toThrow(/under care/);
    status = "active";
    enrolledAlready = true;
    await expect(enrol()).rejects.toThrow(/Already enrolled/);
    enrolledAlready = false;
    await expect(enrol({ enrolledOn: "2026-10-29" })).rejects.toThrow(/after today/);
    expect(find("INSERT INTO care_program_enrollment")).toHaveLength(0);
  });

  it("CONTROL: the schema puts consent first", () => {
    expect(
      EnrollSchema.safeParse({ program: "ccm", enrolledOn: "2026-10-01", consentOn: "2026-10-02", consentMethod: "written" }).success,
    ).toBe(false);
  });

  it("ends with a day and a reason; not before it began, not twice", async () => {
    await endEnrollment({ orgId: ORG, userId: USER, patientId: PATIENT, enrollmentId: ROW, endedOn: "2026-10-28", reason: "Declined" });
    expect(find("UPDATE care_program_enrollment SET ended_on")[0]!.values).toEqual(expect.arrayContaining(["2026-10-28", "Declined"]));
    await expect(
      endEnrollment({ orgId: ORG, userId: USER, patientId: PATIENT, enrollmentId: ROW, endedOn: "2026-09-30", reason: "x" }),
    ).rejects.toThrow(/cannot end earlier/);
    enrollment = { ...enrollment!, ended_on: "2026-10-20" };
    await expect(
      endEnrollment({ orgId: ORG, userId: USER, patientId: PATIENT, enrollmentId: ROW, endedOn: "2026-10-28", reason: "x" }),
    ).rejects.toThrow(/ended on 2026-10-20/);
  });
});

describe("telephone encounters", () => {
  const call = (over: Partial<Parameters<typeof createPhoneEncounter>[0]["payload"]> = {}) =>
    createPhoneEncounter({
      orgId: ORG, userId: USER, patientId: PATIENT,
      payload: { direction: "outbound", spokeWith: "patient", minutes: 15, painScore: 8, summary: "Weekly check-in", ...over },
    });

  it("records the call and hands its scores to the escalation check, in the same transaction", async () => {
    await call();
    expect(find("INSERT INTO phone_encounter")[0]!.values).toEqual(expect.arrayContaining(["outbound", "patient", 15, 8, "Weekly check-in"]));
    expect(vi.mocked(raiseForReadings).mock.calls[0]![1]).toMatchObject({
      patientId: PATIENT, source: { kind: "phone", phoneEncounterId: ROW }, readings: { pain: 8, dyspnea: null, nausea: null },
    });
    expect(audited()[0]).toEqual({ op: "add", encounterId: ROW, direction: "outbound" });
    expect(JSON.stringify(audited())).not.toContain("Weekly");
  });

  it("CONTROL: a call in the future is refused before anything is written; the schema wants a summary", async () => {
    await expect(call({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/future/);
    expect(calls).toHaveLength(0);
    expect(CreatePhoneEncounterSchema.safeParse({ direction: "inbound", spokeWith: "family", summary: "  " }).success).toBe(false);
    expect(CreatePhoneEncounterSchema.safeParse({ direction: "inbound", spokeWith: "family", summary: "x", painScore: 11 }).success).toBe(false);
  });

  it("voiding keeps the call, marked, and withdraws its alerts; not twice", async () => {
    await voidPhoneEncounter({ orgId: ORG, userId: USER, patientId: PATIENT, encounterId: ROW, reason: "Wrong patient" });
    expect(find("UPDATE phone_encounter SET voided_at")[0]!.values).toContain("Wrong patient");
    expect(find("DELETE")).toHaveLength(0);
    expect(vi.mocked(withdrawForSource).mock.calls[0]![1]).toMatchObject({ source: { kind: "phone", phoneEncounterId: ROW } });
    callRow = { voided_at: new Date() };
    await expect(voidPhoneEncounter({ orgId: ORG, userId: USER, patientId: PATIENT, encounterId: ROW, reason: "x" })).rejects.toThrow(
      /already voided/,
    );
  });
});
