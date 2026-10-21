/**
 * GET /api/reports/overview — which days a report window covers.
 *
 * The route turned ?fromDate=2026-09-01&toDate=2026-09-13 into the instants
 * 2026-09-01T00:00:00Z and 2026-09-13T23:59:59Z and the service bound those
 * JS Dates into `date_of_service BETWEEN ...::date AND ...::date`. A Date is
 * bound as a timestamptz, and timestamptz::date is its day in the database
 * SESSION's time zone:
 *
 *   - in a UTC session (CI) the window is right, which is why no test saw it;
 *   - in Asia/Karachi (this machine's database) 23:59:59Z is already the
 *     14th, so the window took in the 14th's bills;
 *   - in America/New_York 00:00Z is still the 31st, so it took in August's.
 *
 * The visit volume was windowed on UTC instants, not on the practice's days,
 * so a 9 pm visit on the last day fell out and a 10 pm visit the evening
 * before the first day fell in, whatever the session zone.
 *
 * The practice's days are its own zone's: the same window read for a practice
 * in Los Angeles takes in a visit at 9:30 pm on the 13th that New York already
 * calls the 14th, and its today is New York's yesterday until 9 pm.
 *
 * A day that does not exist (2026-09-31) is refused as a bad request. Passed
 * through as a string, Postgres refuses it and the route answered 500; as a
 * Date it had rolled over into October.
 *
 * The fake database below holds ROWS and answers each statement as a
 * Postgres session in the zone under test would: a Date bound into ::date is
 * its calendar day in that session zone, a 'YYYY-MM-DD' string is itself (and
 * one that is not a real day is refused, as Postgres refuses it), and
 * `ts AT TIME ZONE z` is the wall-clock day in z. A statement it does not
 * model throws, rather than being answered.
 */
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { GET } from "@/app/api/reports/overview/route";
import type { Session } from "@/lib/auth";
import { requireAuth } from "@/lib/auth";
import { withOrgContext } from "@/lib/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYER = "a0000000-0000-4000-8000-000000000302";
const NURSE_A = "d0000000-0000-4000-8000-0000000000a1";
const NURSE_B = "d0000000-0000-4000-8000-0000000000b2";

const session: Session = {
  userId: USER,
  orgId: ORG,
  role: "billing_agent",
  permissions: ["reports.view"],
  email: "biller@design-partner.test",
};

/** A DATE column as Prisma returns it: the day at UTC midnight. */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** The org row; a test may move the practice to another zone. */
let org: { id: string; name: string; timezone: string };

/** Submitted bills either side of 1–13 Sep, each amount distinct. */
const BILLS = [
  { id: "sb-0831", payer_id: PAYER, status: "submitted", billed_amount_cents: BigInt(1000), paid_amount_cents: null, date_of_service: day("2026-08-31") },
  { id: "sb-0901", payer_id: PAYER, status: "submitted", billed_amount_cents: BigInt(2000), paid_amount_cents: null, date_of_service: day("2026-09-01") },
  { id: "sb-0913", payer_id: PAYER, status: "submitted", billed_amount_cents: BigInt(4000), paid_amount_cents: null, date_of_service: day("2026-09-13") },
  { id: "sb-0914", payer_id: PAYER, status: "submitted", billed_amount_cents: BigInt(8000), paid_amount_cents: null, date_of_service: day("2026-09-14") },
];

/**
 * One denial on a bill inside the window and one on each bill either side of
 * it: a window that slips a day either way, in whichever session zone moves
 * it, counts one denial too many.
 */
const DENIALS = [
  { superbill_id: "sb-0831", carc_code: "CO-16", payer_id: PAYER, cpt_code: "99349", denied_amount_cents: BigInt(1000), decision: "refile", outcome: "pending", denied_at: new Date("2026-09-10T12:00:00Z") },
  { superbill_id: "sb-0913", carc_code: "CO-50", payer_id: PAYER, cpt_code: "99350", denied_amount_cents: BigInt(4000), decision: "appeal", outcome: "pending", denied_at: new Date("2026-09-20T12:00:00Z") },
  { superbill_id: "sb-0914", carc_code: "CO-97", payer_id: PAYER, cpt_code: "99349", denied_amount_cents: BigInt(8000), decision: "appeal", outcome: "pending", denied_at: new Date("2026-09-21T12:00:00Z") },
];

/** Visits at the two edges, in New York time, plus one plainly inside. */
const VISITS = [
  // 10 pm EDT on Mon 31 Aug: before the window.
  { visit_type: "established_patient_home", status: "documented", clinician_user_id: NURSE_A, scheduled_start: null, start_time: new Date("2026-09-01T02:00:00Z"), created_at: new Date("2026-08-25T12:00:00Z") },
  // 11 am EDT on 5 Sep.
  { visit_type: "established_patient_home", status: "documented", clinician_user_id: NURSE_A, scheduled_start: null, start_time: new Date("2026-09-05T15:00:00Z"), created_at: new Date("2026-08-25T12:00:00Z") },
  // 9 pm EDT on Sun 13 Sep: the window's last day.
  { visit_type: "established_patient_home", status: "documented", clinician_user_id: NURSE_B, scheduled_start: null, start_time: new Date("2026-09-14T01:00:00Z"), created_at: new Date("2026-08-25T12:00:00Z") },
  // 9:30 pm PDT on Sun 13 Sep, already 12:30 am on the 14th in New York: in
  // the window for a practice in Los Angeles, out of it for one in New York.
  { visit_type: "established_patient_home", status: "documented", clinician_user_id: NURSE_B, scheduled_start: null, start_time: new Date("2026-09-14T04:30:00Z"), created_at: new Date("2026-08-25T12:00:00Z") },
];

/** The calendar day of an instant in a zone, as Postgres computes it. */
function pgDay(at: Date, zone: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const part = (t: string) => p.find((x) => x.type === t)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** What `bind::date` is in a session whose TimeZone is `sessionZone`. */
function asDate(bind: unknown, sessionZone: string): string {
  if (bind instanceof Date) return pgDay(bind, sessionZone);
  if (typeof bind === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bind)) {
    // Postgres refuses a day that does not exist (SQLSTATE 22008), where
    // Date would roll 2026-09-31 over to 1 October.
    const t = Date.parse(`${bind}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== bind) {
      throw new Error(`date/time field value out of range: "${bind}"`);
    }
    return bind;
  }
  throw new Error(`the fake cannot cast ${String(bind)} to a date`);
}

const DATE_WINDOW = /date_of_service BETWEEN \$(\d+)::date AND \$(\d+)::date/;
const VISIT_LOCAL_WINDOW =
  /\(COALESCE\(start_time, scheduled_start, created_at\) AT TIME ZONE \$(\d+)\)::date\s+BETWEEN \$(\d+)::date AND \$(\d+)::date/;
const VISIT_INSTANT_WINDOW =
  /COALESCE\(start_time, scheduled_start, created_at\)\s+BETWEEN \$(\d+)::timestamptz AND \$(\d+)::timestamptz/;

function fakeTx(sessionZone: string) {
  const run = (strings: TemplateStringsArray, ...binds: unknown[]) => {
    // The statement as the database sees it, binds numbered in place.
    const sql = strings.reduce((acc, part, i) => `${acc}$${i - 1}${part}`);
    const inDateWindow = (d: Date) => {
      const m = DATE_WINDOW.exec(sql)!;
      const k = d.toISOString().slice(0, 10); // a DATE column's own day
      return asDate(binds[Number(m[1])], sessionZone) <= k && k <= asDate(binds[Number(m[2])], sessionZone);
    };

    const orgRead = /SELECT ([\w, ]+) FROM org WHERE id = \$(\d+)::uuid/.exec(sql);
    if (orgRead) {
      const cols = orgRead[1]!.split(",").map((c) => c.trim());
      return Promise.resolve(
        [org].filter((o) => o.id === binds[Number(orgRead[2])]).map((o) =>
          Object.fromEntries(cols.map((c) => {
            if (!(c in o)) throw new Error(`org has no column ${c}`);
            return [c, o[c as keyof typeof o]];
          })),
        ),
      );
    }
    if (sql.includes("FROM superbill_denial d")) {
      if (!DATE_WINDOW.test(sql)) throw new Error("the denials read is not windowed on the claim's date of service");
      return Promise.resolve(
        DENIALS.flatMap((dn) => {
          const s = BILLS.find((b) => b.id === dn.superbill_id)!;
          return inDateWindow(s.date_of_service) ? [{ ...dn, claim_dos: s.date_of_service }] : [];
        }),
      );
    }
    if (/FROM superbill\s+WHERE/.test(sql)) {
      if (!DATE_WINDOW.test(sql)) throw new Error("the bills read is not windowed on the date of service");
      return Promise.resolve(BILLS.filter((b) => inDateWindow(b.date_of_service)));
    }
    if (/FROM visit\s+WHERE/.test(sql)) {
      const at = (v: (typeof VISITS)[number]) => v.start_time ?? v.scheduled_start ?? v.created_at;
      const local = VISIT_LOCAL_WINDOW.exec(sql);
      if (local) {
        const zone = binds[Number(local[1])];
        if (typeof zone !== "string" || !zone) throw new Error("AT TIME ZONE was given no zone");
        const lo = asDate(binds[Number(local[2])], sessionZone);
        const hi = asDate(binds[Number(local[3])], sessionZone);
        return Promise.resolve(VISITS.filter((v) => lo <= pgDay(at(v), zone) && pgDay(at(v), zone) <= hi));
      }
      const instant = VISIT_INSTANT_WINDOW.exec(sql);
      if (instant) {
        const lo = binds[Number(instant[1])];
        const hi = binds[Number(instant[2])];
        if (!(lo instanceof Date) || !(hi instanceof Date)) throw new Error("the fake models only Date timestamptz binds");
        return Promise.resolve(VISITS.filter((v) => lo <= at(v) && at(v) <= hi));
      }
      throw new Error(`the fake cannot evaluate the visit window: ${sql}`);
    }
    if (sql.includes("FROM org_rulebook_row")) return Promise.resolve([]);
    if (sql.includes("FROM payer WHERE id = ANY")) {
      return Promise.resolve([{ id: PAYER, name: "UnitedHealthcare Community Plan Ohio" }]);
    }
    if (sql.includes("FROM app_user WHERE id = ANY")) {
      return Promise.resolve([
        { id: NURSE_A, name: "Nurse A" },
        { id: NURSE_B, name: "Nurse B" },
      ]);
    }
    throw new Error(`the fake models no such statement: ${sql}`);
  };
  return { $queryRaw: run, $executeRaw: run };
}

const get = (query = "") =>
  GET(new Request(`http://localhost/api/reports/overview${query}`) as unknown as NextRequest);

async function overview(query?: string) {
  const res = await get(query);
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data as {
    range: { fromDate: string; toDate: string };
    revenue: { billedCents: number };
    denialsByPayer: { payerId: string | null; count: number; deniedCents: number }[];
    denialRateTrend: { date: string; value: number }[];
    visitVolume: { clinicianUserId: string; count: number }[];
  };
}

beforeEach(() => {
  org = { id: ORG, name: "Design Partner", timezone: "America/New_York" };
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(["UTC", "Asia/Karachi", "America/New_York"])(
  "report windows, database session in %s",
  (sessionZone) => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(requireAuth).mockResolvedValue(session);
      vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
        (fn as (tx: unknown) => Promise<unknown>)(fakeTx(sessionZone)),
      );
    });

    const WINDOW = "?fromDate=2026-09-01&toDate=2026-09-13";

    it("CONTROL: bills 1–13 Sep are the 1st's and the 13th's, never the 31st's or the 14th's", async () => {
      const o = await overview(WINDOW);
      expect(o.revenue.billedCents).toBe(2000 + 4000);
      expect(o.range).toEqual({ fromDate: "2026-09-01", toDate: "2026-09-13" });
    });

    it("CONTROL: denials are those of the window's claims only", async () => {
      const o = await overview(WINDOW);
      expect(o.denialsByPayer.reduce((n, p) => n + p.count, 0)).toBe(1);
      expect(o.denialsByPayer[0]!.deniedCents).toBe(4000);
    });

    it("CONTROL: visits are counted on the practice's days, the 13th's 9 pm visit in and the 31st's out", async () => {
      const o = await overview(WINDOW);
      const byNurse = Object.fromEntries(o.visitVolume.map((v) => [v.clinicianUserId, v.count]));
      expect(byNurse).toEqual({ [NURSE_A]: 1, [NURSE_B]: 1 });
    });

    it("draws one trend point per day of the window", async () => {
      const o = await overview(WINDOW);
      expect(o.denialRateTrend.map((p) => p.date)).toEqual(
        Array.from({ length: 13 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
      );
    });

    it("CONTROL: with no window, the last 30 days end on the practice's today", async () => {
      // 10 pm EDT on 22 Sep; UTC is already on the 23rd.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-23T02:00:00Z"));
      const o = await overview();
      expect(o.range).toEqual({ fromDate: "2026-08-24", toDate: "2026-09-22" });
      expect(o.denialRateTrend).toHaveLength(30);
      expect(o.denialRateTrend.at(-1)!.date).toBe("2026-09-22");
      // Every bill from 31 Aug to 14 Sep is inside 24 Aug – 22 Sep.
      expect(o.revenue.billedCents).toBe(1000 + 2000 + 4000 + 8000);
    });

    it("CONTROL: a practice in Los Angeles counts visits on its own days, 9:30 pm PDT on the 13th in", async () => {
      // 7 pm PDT on 31 Aug is still out; 6 pm and 9:30 pm PDT on the 13th are
      // both in, though New York already calls the second one the 14th.
      org = { ...org, timezone: "America/Los_Angeles" };
      const o = await overview(WINDOW);
      const byNurse = Object.fromEntries(o.visitVolume.map((v) => [v.clinicianUserId, v.count]));
      expect(byNurse).toEqual({ [NURSE_A]: 1, [NURSE_B]: 2 });
    });

    it("CONTROL: a practice in Los Angeles ends the default window on its own today", async () => {
      // 9 pm PDT on 22 Sep; New York is already on the 23rd.
      org = { ...org, timezone: "America/Los_Angeles" };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-23T04:00:00Z"));
      const o = await overview();
      expect(o.range).toEqual({ fromDate: "2026-08-24", toDate: "2026-09-22" });
    });
  },
);

describe("report windows, a day that does not exist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAuth).mockResolvedValue(session);
    vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
      (fn as (tx: unknown) => Promise<unknown>)(fakeTx("UTC")),
    );
  });

  it.each([
    "?toDate=2026-09-31",
    "?fromDate=2026-09-01&toDate=2026-09-31",
    "?fromDate=2026-02-30&toDate=2026-03-05",
  ])("CONTROL: %s is refused as a bad request before anything is read, not a 500", async (query) => {
    const res = await get(query);
    // The repo answers a request its schema refuses with 422 (lib/api.ts).
    expect(res.status).toBe(422);
    expect((await res.json()).success).toBe(false);
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("twin: the last day of a month is a day", async () => {
    const o = await overview("?fromDate=2026-09-01&toDate=2026-09-30");
    expect(o.range).toEqual({ fromDate: "2026-09-01", toDate: "2026-09-30" });
  });
});
