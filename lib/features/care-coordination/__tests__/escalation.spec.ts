/**
 * Escalation alerts (0116; doc:55-57): raised in the reading's transaction for
 * the primary NP, updated or withdrawn as the reading is corrected, withdrawn
 * with a voided source, acknowledged once. lib/db is mocked with a fake tx
 * that records every statement and answers the reads each test sets up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { acknowledgeAlert, raiseForEvent, raiseForReadings, withdrawForSource } from "../escalation.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const VISIT = "55555555-5555-4555-8555-555555555555";
const EVENT = "66666666-6666-4666-8666-666666666666";
const NEW = "c1000000-0000-4000-8000-000000000001";
const OLD = "c1000000-0000-4000-8000-000000000002";

let calls: { sql: string; values: unknown[] }[];
let rules: unknown;
let np: string | null;
let existing: { id: string; measure: string; status: string }[];
let inserted: boolean;
let current: { patient_id: string; status: string; measure: string } | null;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT escalation FROM care_plan")) return Promise.resolve(rules === undefined ? [] : [{ escalation: rules }]);
    if (sql.includes("primary_np_user_id AS np")) return Promise.resolve([{ np }]);
    if (sql.includes("SELECT id, measure, status FROM escalation_alert")) return Promise.resolve(existing);
    if (sql.includes("SELECT patient_id, status, measure FROM escalation_alert")) return Promise.resolve(current ? [current] : []);
    if (sql.includes("INSERT INTO escalation_alert")) return Promise.resolve(inserted ? [{ id: NEW }] : []);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  rules = [
    { measure: "pain", threshold: 7 },
    { measure: "fall", threshold: null },
  ];
  np = NP;
  existing = [];
  inserted = true;
  current = { patient_id: PATIENT, status: "open", measure: "pain" };
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
});

const tx = () => fakeTx() as never;
const find = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));
const audited = () => vi.mocked(writeAudit).mock.calls.map((c) => c[1].payload);
const vitals = (pain: number | null) =>
  raiseForReadings(tx(), {
    orgId: ORG, userId: USER, patientId: PATIENT, source: { kind: "vitals", visitId: VISIT }, readings: { pain },
  });

describe("a reading against the NP's limits", () => {
  it("raises an alert for the primary NP and tells them, naming the measure, never the reading", async () => {
    await vitals(8);
    const ins = find("INSERT INTO escalation_alert")[0]!;
    expect(ins.values).toEqual(expect.arrayContaining(["pain", 8, 7, "vitals", VISIT, NP]));
    const bell = find("INSERT INTO notification")[0]!;
    expect(bell.sql).toContain("'escalation_alert'");
    expect(JSON.parse(bell.values.find((v) => typeof v === "string" && v.startsWith("{")) as string)).toEqual({
      patientId: PATIENT, alertId: NEW, measure: "pain",
    });
    expect(audited()).toEqual([{ op: "raise", alertId: NEW, measure: "pain", source: "vitals" }]);
  });

  it("CONTROL: under the limit raises nothing, tells nobody", async () => {
    await vitals(6);
    expect(find("INSERT INTO escalation_alert")).toHaveLength(0);
    expect(find("INSERT INTO notification")).toHaveLength(0);
    expect(audited()).toHaveLength(0);
  });

  it("CONTROL: a plan with no escalation parameters raises nothing", async () => {
    rules = undefined;
    await vitals(10);
    expect(find("INSERT INTO escalation_alert")).toHaveLength(0);
  });

  it("a corrected reading still over the limit updates the alert it raised, without telling again", async () => {
    existing = [{ id: OLD, measure: "pain", status: "open" }];
    await vitals(9);
    expect(find("INSERT INTO escalation_alert")).toHaveLength(0);
    expect(find("UPDATE escalation_alert SET value")[0]!.values).toEqual(expect.arrayContaining([9, 7, OLD]));
    expect(find("INSERT INTO notification")).toHaveLength(0);
  });

  it("a reading corrected below the limit withdraws its open alert and clears the bell", async () => {
    existing = [{ id: OLD, measure: "pain", status: "open" }];
    await vitals(3);
    expect(find("SET status = 'withdrawn'")[0]!.values).toContain(OLD);
    expect(find("UPDATE notification SET read_at")[0]!.values).toContain(OLD);
    expect(audited()).toEqual([{ op: "withdraw", alertId: OLD, measure: "pain", source: "vitals" }]);
  });

  it("CONTROL: an alert the NP has acknowledged stays as it was when the reading is corrected", async () => {
    existing = [{ id: OLD, measure: "pain", status: "acknowledged" }];
    await vitals(3);
    expect(find("SET status = 'withdrawn'")).toHaveLength(0);
    expect(audited()).toHaveLength(0);
  });

  it("corrected back over the limit, a withdrawn alert is raised again and said again", async () => {
    existing = [{ id: OLD, measure: "pain", status: "withdrawn" }];
    await vitals(8);
    expect(find("SET status = 'open'")[0]!.values).toEqual(expect.arrayContaining([8, 7, NP, OLD]));
    expect(find("INSERT INTO notification")).toHaveLength(1);
    expect(audited()).toEqual([{ op: "raise", alertId: OLD, measure: "pain", source: "vitals" }]);
  });

  it("with no primary NP, the alert is kept and nobody is told", async () => {
    np = null;
    await vitals(8);
    expect(find("INSERT INTO escalation_alert")[0]!.values).toContain(null);
    expect(find("INSERT INTO notification")).toHaveLength(0);
  });
});

describe("an event the NP asked to hear of", () => {
  const event = (kind: string) => raiseForEvent(tx(), { orgId: ORG, userId: USER, patientId: PATIENT, eventId: EVENT, kind });

  it("a fall raises one alert, once", async () => {
    await event("fall");
    const ins = find("INSERT INTO escalation_alert")[0]!;
    expect(ins.sql).toContain("ON CONFLICT (event_id)");
    expect(ins.values).toEqual(expect.arrayContaining(["fall", EVENT, NP]));
    expect(find("INSERT INTO notification")).toHaveLength(1);
  });

  it("CONTROL: an event the plan does not ask about raises nothing; a repeat tells nobody", async () => {
    await event("ed_visit");
    expect(find("INSERT INTO escalation_alert")).toHaveLength(0);
    inserted = false;
    await event("fall");
    expect(find("INSERT INTO notification")).toHaveLength(0);
  });

  it("a voided event withdraws its open alert and clears the bell", async () => {
    existing = [{ id: OLD, measure: "fall", status: "open" }];
    await withdrawForSource(tx(), { orgId: ORG, userId: USER, patientId: PATIENT, source: { kind: "event", eventId: EVENT } });
    expect(find("SET status = 'withdrawn'")[0]!.values).toContain(OLD);
    expect(find("UPDATE notification SET read_at")).toHaveLength(1);
  });
});

describe("acknowledging", () => {
  it("records who and when, reads the bell entries, audits the measure", async () => {
    expect(await acknowledgeAlert({ orgId: ORG, userId: USER, alertId: OLD, note: "Called back" })).toEqual({ patientId: PATIENT });
    expect(find("SET status = 'acknowledged'")[0]!.values).toEqual(expect.arrayContaining([USER, "Called back", OLD]));
    expect(find("UPDATE notification SET read_at")).toHaveLength(1);
    expect(audited()).toEqual([{ op: "acknowledge", alertId: OLD, measure: "pain" }]);
    expect(JSON.stringify(audited())).not.toContain("Called back");
  });

  it("CONTROL: an alert already acknowledged, or withdrawn, or not there, is refused", async () => {
    current = { patient_id: PATIENT, status: "acknowledged", measure: "pain" };
    await expect(acknowledgeAlert({ orgId: ORG, userId: USER, alertId: OLD })).rejects.toThrow(/already acknowledged/);
    current = { patient_id: PATIENT, status: "withdrawn", measure: "pain" };
    await expect(acknowledgeAlert({ orgId: ORG, userId: USER, alertId: OLD })).rejects.toThrow(/withdrawn/);
    current = null;
    await expect(acknowledgeAlert({ orgId: ORG, userId: USER, alertId: OLD })).rejects.toMatchObject({ name: "NotFoundError" });
    expect(find("SET status = 'acknowledged'")).toHaveLength(0);
  });
});
