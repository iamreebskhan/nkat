/**
 * The daily-capacity guard counts the visits on the PRACTICE's day of the new
 * visit (0107).
 *
 * It took the UTC slice of the new visit's start and each visit's day in the
 * database session's zone. On localhost, with the cap set to one, a 9 pm EDT
 * visit was booked beside the same day's 9 am visit: 9 pm EDT on the 29th is
 * the 30th in UTC, where the 9 am visit is not.
 *
 * The count is answered by working out each day in the zone the statement
 * BINDS, with the same Intl rule orgLocalDate is (org-date.spec.ts pins that
 * against DST and every practice zone). A statement that compares days some
 * other way, as the old one did, cannot be answered and fails here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {}, withOrgContext: vi.fn() }));

import { withOrgContext } from "@/lib/db";
import { orgLocalDate } from "@/lib/features/org/org-date";

import { getDailyCapacityStatus } from "../visit.service";

const ORG = "11111111-1111-4111-8111-111111111111";
const HELEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NINE_AM = "e0000000-0000-4000-8000-000000000929";

let capacity: number;
let zone: string;
let visits: { id: string; clinician_user_id: string; org_id: string; status: string; scheduled_start: Date | null; start_time: Date | null }[];
let calls: { sql: string; values: unknown[] }[];

/** The statement's two days, as Postgres works them out: in the bound zone. */
const DAY_PREDICATE =
  /\(COALESCE\(scheduled_start, start_time\) AT TIME ZONE ¶\)::date\s*=\s*\(¶::timestamptz AT TIME ZONE ¶\)::date/;

function fakeTx() {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("¶");
    calls.push({ sql, values });
    if (sql.includes("FROM org WHERE id =")) {
      return Promise.resolve([{ daily_visit_capacity: capacity, timezone: zone }]);
    }
    if (sql.includes("COUNT(*)::bigint AS n FROM visit")) {
      const m = DAY_PREDICATE.exec(sql);
      if (!m) throw new Error("the capacity count compares days in a way this fake cannot evaluate");
      const first = sql.slice(0, m.index + m[0].indexOf("¶")).split("¶").length - 1;
      const [visitZone, at, atZone] = [values[first], values[first + 1], values[first + 2]] as [string, string, string];
      const clinician = values[0];
      // Each value by the place it is bound in the statement.
      const boundAfter = (marker: string) => {
        const at = sql.indexOf(marker);
        return at < 0 ? undefined : values[sql.slice(0, at + marker.length - 1).split("¶").length - 1];
      };
      const org = boundAfter("AND org_id = ¶");
      // The visit being moved, which the count leaves out: `id <> ¶`.
      const excluded = boundAfter("id <> ¶") ?? null;
      const day = orgLocalDate(at, atZone);
      const n = visits.filter(
        (v) =>
          v.clinician_user_id === clinician &&
          v.org_id === org &&
          (excluded === null || v.id !== excluded) &&
          !["cancelled", "no_show"].includes(v.status) &&
          (v.scheduled_start ?? v.start_time) !== null &&
          orgLocalDate((v.scheduled_start ?? v.start_time)!, visitZone) === day,
      ).length;
      return Promise.resolve([{ n: BigInt(n) }]);
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { $queryRaw: run, $executeRaw: run };
}

beforeEach(() => {
  capacity = 1;
  zone = "America/New_York";
  calls = [];
  // Helen's 9 am EDT visit on Thu 29 Oct.
  visits = [
    { id: NINE_AM, clinician_user_id: HELEN, org_id: ORG, status: "scheduled", scheduled_start: new Date("2026-10-29T13:00:00Z"), start_time: null },
  ];
  vi.mocked(withOrgContext).mockImplementation(async (_o, fn) =>
    (fn as (tx: unknown) => Promise<unknown>)(fakeTx()),
  );
});

const check = (at: string) => getDailyCapacityStatus({ orgId: ORG, clinicianUserId: HELEN, at });

describe("getDailyCapacityStatus — the practice's day", () => {
  it("counts a 9 pm EDT visit against the same Ohio day as the 9 am one", async () => {
    // 01:00 UTC on the 30th is 9 pm EDT on the 29th.
    expect(await check("2026-10-30T01:00:00.000Z")).toEqual({ count: 1, capacity: 1, over: true });
  });

  it("CONTROL: the next morning is a new day", async () => {
    expect(await check("2026-10-30T13:00:00.000Z")).toEqual({ count: 0, capacity: 1, over: false });
  });

  it("works both days out in the org's own zone, read with its cap", async () => {
    // In Honolulu (UTC-10) the 9 am EDT visit is 3 am on the 29th, and 01:00
    // UTC on the 30th is 3 pm on the 29th: the same day there too.
    zone = "Pacific/Honolulu";
    expect((await check("2026-10-30T01:00:00.000Z")).count).toBe(1);
    // 11:00 UTC on the 30th is 1 am on the 30th in Honolulu.
    expect((await check("2026-10-30T11:00:00.000Z")).count).toBe(0);
    const count = calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.values).toContain("Pacific/Honolulu");
  });

  it("does not count cancelled or no-show visits", async () => {
    visits = visits.map((v) => ({ ...v, status: "cancelled" }));
    expect((await check("2026-10-30T01:00:00.000Z")).over).toBe(false);
  });

  it("leaves out the visit being moved: moving the 9 am visit to 9 pm the same day is not over the cap", async () => {
    expect(
      await getDailyCapacityStatus({
        orgId: ORG, clinicianUserId: HELEN, at: "2026-10-30T01:00:00.000Z", excludeVisitId: NINE_AM,
      }),
    ).toEqual({ count: 0, capacity: 1, over: false });
  });

  it("CONTROL: another visit moved onto that day still finds the 9 am one", async () => {
    expect(
      await getDailyCapacityStatus({
        orgId: ORG, clinicianUserId: HELEN, at: "2026-10-30T01:00:00.000Z",
        excludeVisitId: "e0000000-0000-4000-8000-000000000999",
      }),
    ).toEqual({ count: 1, capacity: 1, over: true });
  });

  it("takes the new visit's start as sent, an instant, not its first ten characters", async () => {
    await check("2026-10-30T01:00:00.000Z");
    const count = calls.find((c) => c.sql.includes("COUNT(*)"))!;
    expect(count.values).toContain("2026-10-30T01:00:00.000Z");
    expect(count.values).not.toContain("2026-10-30");
  });
});
