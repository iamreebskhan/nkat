/**
 * An instant becomes a calendar day in the practice's time zone; a DATE
 * column is already a day.
 *
 * The expected days below are what Postgres gives for the same instants with
 * (ts AT TIME ZONE zone)::date, checked on the local database (Intl and
 * AT TIME ZONE agreed on every case, the DST edges included). None of them
 * may depend on the zone this process runs in: this machine runs in
 * Asia/Karachi, CI in UTC.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORG_TIME_ZONE,
  PRACTICE_TIME_ZONES,
  addDaysIso,
  dateColumnIso,
  isCalendarDay,
  isPracticeTimeZone,
  orgLocalDate,
  orgLocalMinute,
  orgToday,
} from "../org-date";

describe("orgLocalDate — the day of an instant where the practice is", () => {
  it.each([
    // 8:30 pm EDT on Tue 22 Sep: the evening visit billed as the 23rd.
    ["2026-09-23T00:30:00Z", "America/New_York", "2026-09-22"],
    ["2026-09-22T23:59:00Z", "America/New_York", "2026-09-22"],
    // UTC midnight is 8 pm EDT, still the 22nd.
    ["2026-09-23T00:00:00Z", "America/New_York", "2026-09-22"],
    // Midnight EDT: the last second of the 22nd, then the first of the 23rd.
    ["2026-09-23T03:59:59Z", "America/New_York", "2026-09-22"],
    ["2026-09-23T04:00:00Z", "America/New_York", "2026-09-23"],
    // Winter: EST is UTC-5.
    ["2026-01-15T00:30:00Z", "America/New_York", "2026-01-14"],
    // Either side of the spring-forward night (2 am EST on 8 Mar becomes 3 am
    // EDT): 11:30 pm EST on the 7th, then 12:30 am EDT on the 9th, which a
    // fixed EST offset would put on the 8th.
    ["2026-03-08T04:30:00Z", "America/New_York", "2026-03-07"],
    ["2026-03-09T04:30:00Z", "America/New_York", "2026-03-09"],
    // The fall-back night (2 am EDT on 1 Nov becomes 1 am EST).
    ["2026-11-02T04:30:00Z", "America/New_York", "2026-11-01"],
    ["2026-11-02T05:00:00Z", "America/New_York", "2026-11-02"],
    ["2026-09-23T04:30:00Z", "America/Chicago", "2026-09-22"],
    ["2026-09-23T06:30:00Z", "America/Los_Angeles", "2026-09-22"],
    // Arizona keeps MST all year.
    ["2026-09-23T06:30:00Z", "America/Phoenix", "2026-09-22"],
    ["2026-09-23T09:30:00Z", "Pacific/Honolulu", "2026-09-22"],
    // Atlantic time, no DST.
    ["2026-09-23T03:30:00Z", "America/Puerto_Rico", "2026-09-22"],
  ])("%s in %s is %s", (at, zone, day) => {
    expect(orgLocalDate(new Date(at), zone)).toBe(day);
    // An instant given as its ISO string reads the same.
    expect(orgLocalDate(at, zone)).toBe(day);
  });

  it("is not a blanket shift: a daytime visit keeps its UTC day", () => {
    expect(orgLocalDate(new Date("2026-09-22T15:00:00Z"), "America/New_York")).toBe("2026-09-22");
  });

  it("refuses an empty or missing zone instead of quietly using the host's", () => {
    // Intl.DateTimeFormat with timeZone undefined formats in the process zone
    // (Asia/Karachi here, so 2026-09-23T00:30Z would read as the 23rd). A row
    // that forgot to select the org's zone must fail loudly.
    const at = new Date("2026-09-23T00:30:00Z");
    expect(() => orgLocalDate(at, "")).toThrow(/time zone/);
    expect(() => orgLocalDate(at, undefined as unknown as string)).toThrow(/time zone/);
    expect(() => orgLocalDate(at, null as unknown as string)).toThrow(/time zone/);
  });

  it("refuses a zone that is not one", () => {
    expect(() => orgLocalDate(new Date("2026-09-23T00:30:00Z"), "Mars/Olympus_Mons")).toThrow(RangeError);
  });

  it("refuses an invalid instant", () => {
    expect(() => orgLocalDate(new Date("not a date"), "America/New_York")).toThrow(RangeError);
  });

  it("refuses a bare calendar day, which is already a day", () => {
    // '2026-09-22' parses as UTC midnight, which is the 21st in New York.
    expect(() => orgLocalDate("2026-09-22", "America/New_York")).toThrow(/already a calendar day/);
  });
});

describe("dateColumnIso — a DATE column is read as it is", () => {
  it("keeps the stored day, where orgLocalDate would move it back west of UTC", () => {
    // Prisma returns a DATE as a Date at UTC midnight. That is a day, not an
    // instant: through orgLocalDate it would become the day before.
    const stored = new Date("2026-09-22T00:00:00Z");
    expect(dateColumnIso(stored)).toBe("2026-09-22");
    expect(orgLocalDate(stored, "America/New_York")).toBe("2026-09-21");
  });
});

describe("orgLocalMinute — a time as the practice reads it", () => {
  it.each([
    // Shirley Tanaka's note was signed at 22:10 UTC: 6:10 pm in Ohio.
    ["2026-09-23T22:10:35Z", "America/New_York", "2026-09-23 18:10 EDT"],
    // After 8 pm in Ohio the UTC time is on the next day; the practice's is not.
    ["2026-09-24T01:30:00Z", "America/New_York", "2026-09-23 21:30 EDT"],
    ["2026-01-15T00:30:00Z", "America/New_York", "2026-01-14 19:30 EST"],
    ["2026-09-23T04:30:00Z", "America/Chicago", "2026-09-22 23:30 CDT"],
    ["2026-09-23T06:30:00Z", "America/Phoenix", "2026-09-22 23:30 MST"],
    ["2026-09-23T09:30:00Z", "Pacific/Honolulu", "2026-09-22 23:30 HST"],
    ["2026-09-23T03:30:00Z", "America/Puerto_Rico", "2026-09-22 23:30 AST"],
  ])("%s in %s reads %s", (at, zone, text) => {
    expect(orgLocalMinute(new Date(at), zone)).toBe(text);
    expect(orgLocalMinute(at, zone)).toBe(text);
  });

  it("writes midnight as 00, on a 24-hour clock", () => {
    expect(orgLocalMinute(new Date("2026-09-23T04:00:00Z"), "America/New_York")).toBe("2026-09-23 00:00 EDT");
    expect(orgLocalMinute(new Date("2026-09-23T17:05:00Z"), "America/New_York")).toBe("2026-09-23 13:05 EDT");
  });

  it("refuses a missing zone, as orgLocalDate does", () => {
    expect(() => orgLocalMinute(new Date("2026-09-23T00:30:00Z"), "")).toThrow(/time zone/);
  });
});

describe("orgToday", () => {
  it("is today where the practice is, not in UTC", () => {
    // 10 pm EDT on 22 Sep; UTC is already on the 23rd.
    expect(orgToday("America/New_York", new Date("2026-09-23T02:00:00Z"))).toBe("2026-09-22");
    expect(orgToday("Pacific/Honolulu", new Date("2026-09-23T02:00:00Z"))).toBe("2026-09-22");
  });

  it("refuses a missing zone too", () => {
    expect(() => orgToday("")).toThrow(/time zone/);
  });
});

describe("addDaysIso", () => {
  it.each([
    ["2026-09-22", -29, "2026-08-24"],
    ["2026-09-30", 1, "2026-10-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-01-01", -1, "2026-12-31"],
    // Across the DST changes: calendar days, not 24-hour steps in a zone.
    ["2026-03-07", 2, "2026-03-09"],
    ["2026-11-01", 1, "2026-11-02"],
    ["2026-09-22", 0, "2026-09-22"],
  ])("%s plus %i days is %s", (day, n, out) => {
    expect(addDaysIso(day, n)).toBe(out);
  });

  it("refuses anything that is not a YYYY-MM-DD day", () => {
    expect(() => addDaysIso("2026-09-22T00:00:00Z", 1)).toThrow(RangeError);
    expect(() => addDaysIso("2026-02-30", 1)).toThrow(RangeError);
  });
});

describe("isCalendarDay — a 'YYYY-MM-DD' that exists", () => {
  // What a route checks a day against before binding it into ::date. Postgres
  // refuses a day that does not exist ("date/time field value out of range"),
  // which was a 500; Date would quietly roll it into the next month.
  it("accepts a day that exists, a leap day included", () => {
    for (const d of ["2026-09-30", "2026-02-28", "2028-02-29", "2026-12-31", "2027-01-01"]) {
      expect(isCalendarDay(d), d).toBe(true);
    }
  });

  it("refuses one that does not, which Date would roll over", () => {
    // new Date("2026-02-30T00:00:00Z") is 2 March.
    for (const d of ["2026-09-31", "2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-09-00"]) {
      expect(isCalendarDay(d), d).toBe(false);
    }
  });

  it("refuses anything that is not YYYY-MM-DD", () => {
    for (const d of ["2026-9-1", "2026-09-22T00:00:00Z", "", " 2026-09-22", undefined, null, 20260922, new Date("2026-09-22")]) {
      expect(isCalendarDay(d), String(d)).toBe(false);
    }
  });
});

describe("PRACTICE_TIME_ZONES", () => {
  it("is exactly the list the org.timezone CHECK allows (0107)", () => {
    // The database refuses any other zone, and the app offers this list. A
    // zone added to one and not the other is either unselectable or refused
    // on save.
    const sql = readFileSync(
      new URL("../../../../db/migrations/0107_org_timezone.sql", import.meta.url),
      "utf8",
    );
    const list = sql.match(/CHECK \(timezone IN \(([\s\S]*?)\)\)/)?.[1];
    expect(list).toBeDefined();
    const allowed = [...list!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual([...PRACTICE_TIME_ZONES]);
    // And the column default is the app's default.
    expect(sql).toContain(`DEFAULT '${DEFAULT_ORG_TIME_ZONE}'`);
  });

  it("names only zones Intl knows", () => {
    for (const zone of PRACTICE_TIME_ZONES) {
      expect(orgLocalDate(new Date("2026-09-22T15:00:00Z"), zone)).toMatch(/^2026-09-2[12]$/);
    }
  });

  it("isPracticeTimeZone accepts the list and nothing else", () => {
    expect(isPracticeTimeZone("America/New_York")).toBe(true);
    expect(isPracticeTimeZone("Asia/Karachi")).toBe(false);
    expect(isPracticeTimeZone("UTC")).toBe(false);
    expect(isPracticeTimeZone(undefined)).toBe(false);
  });
});
