/**
 * Booking and changing a repeating series (0126). lib/db is a fake answering by
 * statement. What matters: one transaction books every occurrence or none, each
 * at the practice's wall clock; and "this and later" reaches only the visits
 * still booked, from this one on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));
vi.mock("@/lib/features/audit/audit-write", () => ({ writeAudit: vi.fn() }));
vi.mock("../visit.service", async (original) => ({
  ...(await original<typeof import("../visit.service")>()),
  rescheduleVisit: vi.fn(),
  transitionVisit: vi.fn(),
}));

import { withOrgContext } from "@/lib/db";
import { writeAudit } from "@/lib/features/audit/audit-write";

import { cancelSeriesFrom, moveSeriesFrom, scheduleVisitSeries } from "../visit-series.service";
import { rescheduleVisit, transitionVisit } from "../visit.service";
import type { ScheduleSeries } from "../visit.types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const VISIT = "33333333-3333-4333-8333-333333333333";
const NEXT = "44444444-4444-4444-8444-444444444444";
const SERIES = "55555555-5555-4555-8555-555555555555";

let calls: { sql: string; values: unknown[] }[];
let capacity: number;
let busy: { day: string; n: number }[];
let timeOff: { startDate: string; endDate: string }[];
let me: { series_id: string | null; scheduled_start: Date | null; status: string } | null;
let rest: { id: string; clinician_user_id: string; scheduled_start: Date }[];

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("SELECT timezone FROM org")) return Promise.resolve([{ timezone: "America/New_York" }]);
    if (sql.includes("FROM org_visit_type")) return Promise.resolve([{ slug: "established_patient_home", is_telehealth: false }]);
    if (sql.includes("FROM org_member")) return Promise.resolve([{ ok: 1 }]);
    if (sql.includes("SELECT status FROM patient")) return Promise.resolve([{ status: "active" }]);
    if (sql.includes("GROUP BY 1")) return Promise.resolve(busy);
    if (sql.includes("daily_visit_capacity")) return Promise.resolve([{ daily_visit_capacity: capacity }]);
    if (sql.includes("FROM time_off")) return Promise.resolve(timeOff);
    if (sql.includes("INSERT INTO visit_series")) return Promise.resolve([{ id: SERIES }]);
    if (sql.includes("INSERT INTO visit (")) {
      const starts = values.find((v) => Array.isArray(v)) as string[];
      return Promise.resolve(starts.map((start, i) => ({ id: `v${i}`, start })));
    }
    if (sql.includes("SELECT series_id, scheduled_start, status FROM visit")) return Promise.resolve(me ? [me] : []);
    if (sql.includes("SELECT id, clinician_user_id, scheduled_start FROM visit")) return Promise.resolve(rest);
    return Promise.resolve([]);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  capacity = 6;
  busy = [];
  timeOff = [];
  me = { series_id: SERIES, scheduled_start: new Date("2026-11-03T15:00:00Z"), status: "scheduled" };
  rest = [
    { id: VISIT, clinician_user_id: USER, scheduled_start: new Date("2026-11-03T15:00:00Z") },
    { id: NEXT, clinician_user_id: USER, scheduled_start: new Date("2026-11-17T15:00:00Z") },
  ];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) => (fn as (tx: unknown) => Promise<unknown>)(fakeTx()));
  vi.mocked(rescheduleVisit).mockImplementation(async (a) => ({
    updated: true,
    moved: { clinicianUserId: USER, patientId: "p", visitType: "established_patient_home", start: a.scheduledStart, end: null },
  }));
});

const payload = (over: Partial<ScheduleSeries> = {}): ScheduleSeries => ({
  patientId: "66666666-6666-4666-8666-666666666666",
  clinicianUserId: USER,
  visitType: "established_patient_home",
  startLocal: "2026-11-03T10:00",
  isTelehealth: false,
  every: 2,
  unit: "week",
  count: 3,
  ...over,
});
const book = (over: Partial<ScheduleSeries> = {}) => scheduleVisitSeries({ orgId: ORG, userId: USER, payload: payload(over) });
const wrote = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));

describe("booking a series", () => {
  it("books one visit an occurrence, under the series, and audits how many, never a date", async () => {
    const r = await book();
    expect(r.booked.map((b) => b.start)).toEqual(["2026-11-03T15:00:00.000Z", "2026-11-17T15:00:00.000Z", "2026-12-01T15:00:00.000Z"]);
    expect(wrote("INSERT INTO visit_series")).toHaveLength(1);
    expect(wrote("INSERT INTO visit (")[0]!.values).toContain(SERIES);
    const audit = vi.mocked(writeAudit).mock.calls[0]![1];
    expect(audit).toMatchObject({ action: "visit_series_create", payload: { seriesId: SERIES, visits: 3, every: 2, unit: "week" } });
    expect(JSON.stringify(audit.payload)).not.toContain("2026");
  });

  it("keeps the practice's 10:00 across the spring clock change", async () => {
    const r = await book({ startLocal: "2027-02-01T10:00", every: 1, unit: "month", count: 3 });
    expect(r.booked.map((b) => b.start)).toEqual(["2027-02-01T15:00:00.000Z", "2027-03-01T15:00:00.000Z", "2027-04-01T14:00:00.000Z"]);
  });

  it("CONTROL: a full day or a day off books nothing at all, and says which", async () => {
    capacity = 1;
    busy = [{ day: "2026-11-03", n: 1 }];
    timeOff = [{ startDate: "2026-11-16", endDate: "2026-11-18" }];
    const r = await book();
    expect(r.conflicts.map((c) => [c.day, c.kind])).toEqual([["2026-11-03", "capacity"], ["2026-11-17", "time_off"]]);
    expect(r.booked).toEqual([]);
    expect(wrote("INSERT INTO")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("leaves out the days asked, and checks only the rest", async () => {
    capacity = 1;
    busy = [{ day: "2026-11-03", n: 1 }];
    const r = await book({ skipDays: ["2026-11-03"] });
    expect(r.conflicts).toEqual([]);
    expect(r.booked.map((b) => b.start.slice(0, 10))).toEqual(["2026-11-17", "2026-12-01"]);
  });

  it("books anyway when confirmed, without asking again", async () => {
    capacity = 1;
    busy = [{ day: "2026-11-03", n: 1 }];
    const r = await book({ confirmDoubleBook: true });
    expect(r.booked).toHaveLength(3);
    expect(wrote("GROUP BY 1")).toHaveLength(0);
  });

  it("refuses too many, too few, and every day left out", async () => {
    await expect(book({ count: undefined, until: "2030-01-01", every: 1 })).rejects.toThrow("more than 52");
    await expect(book({ count: undefined, until: "2026-11-05" })).rejects.toThrow("at least two");
    await expect(book({ count: 2, skipDays: ["2026-11-03", "2026-11-17"] })).rejects.toThrow("Every day");
    expect(wrote("INSERT INTO")).toHaveLength(0);
  });
});

describe("this and later", () => {
  it("cancels each as one visit is cancelled, the actor recorded", async () => {
    expect(await cancelSeriesFrom({ orgId: ORG, visitId: VISIT, actorUserId: USER })).toEqual({ cancelled: 2 });
    expect(vi.mocked(transitionVisit).mock.calls.map((c) => [c[0].id, c[0].to, c[0].signedByUserId])).toEqual([
      [VISIT, "cancelled", USER],
      [NEXT, "cancelled", USER],
    ]);
  });

  it("reads only the series' visits still booked, from this one on", async () => {
    await cancelSeriesFrom({ orgId: ORG, visitId: VISIT, actorUserId: USER });
    const q = wrote("SELECT id, clinician_user_id, scheduled_start FROM visit")[0]!;
    expect(q.sql).toContain("status = 'scheduled'");
    expect(q.sql).toContain("scheduled_start >=");
    expect(q.values).toEqual(expect.arrayContaining([ORG, SERIES]));
  });

  it("CONTROL: refuses a visit outside a series, one not booked, and one not found", async () => {
    me = { series_id: null, scheduled_start: new Date(), status: "scheduled" };
    await expect(cancelSeriesFrom({ orgId: ORG, visitId: VISIT, actorUserId: USER })).rejects.toThrow("not part of a repeating series");
    me = { series_id: SERIES, scheduled_start: new Date(), status: "documented" };
    await expect(cancelSeriesFrom({ orgId: ORG, visitId: VISIT, actorUserId: USER })).rejects.toThrow("still booked");
    me = null;
    await expect(cancelSeriesFrom({ orgId: ORG, visitId: VISIT, actorUserId: USER })).rejects.toThrow("not found");
    expect(transitionVisit).not.toHaveBeenCalled();
  });

  it("moves each by the same days, to the new time on the practice's clock", async () => {
    const r = await moveSeriesFrom({ orgId: ORG, visitId: VISIT, startLocal: "2026-11-08T14:00", actorUserId: USER });
    expect(r.moved.map((m) => m.start)).toEqual(["2026-11-08T19:00:00.000Z", "2026-11-22T19:00:00.000Z"]);
    expect(vi.mocked(rescheduleVisit).mock.calls.map((c) => c[0].id)).toEqual([VISIT, NEXT]);
  });

  it("does not count the visits being moved against the days they land on", async () => {
    await moveSeriesFrom({ orgId: ORG, visitId: VISIT, startLocal: "2026-11-08T14:00", actorUserId: USER });
    expect(wrote("GROUP BY 1")[0]!.values).toContainEqual([VISIT, NEXT]);
  });

  it("CONTROL: a day that needs a look moves nothing, until confirmed", async () => {
    capacity = 1;
    busy = [{ day: "2026-11-08", n: 1 }];
    const r = await moveSeriesFrom({ orgId: ORG, visitId: VISIT, startLocal: "2026-11-08T14:00", actorUserId: USER });
    expect(r.conflicts.map((c) => c.day)).toEqual(["2026-11-08"]);
    expect(rescheduleVisit).not.toHaveBeenCalled();
    const sure = await moveSeriesFrom({ orgId: ORG, visitId: VISIT, startLocal: "2026-11-08T14:00", confirmDoubleBook: true, actorUserId: USER });
    expect(sure.moved).toHaveLength(2);
  });
});
