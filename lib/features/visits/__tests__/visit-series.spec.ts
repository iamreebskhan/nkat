/**
 * Repeating visits (0126) and the practice's clock they run on: the days a
 * series falls on, what stands in its way, and a time typed anywhere in the
 * world landing on the practice's wall clock.
 */
import { describe, expect, it } from "vitest";

import { orgClockTime, orgInstant, orgLocalDate, orgLocalInput, orgZoneName } from "@/lib/features/org/org-date";

import { seriesConflicts, seriesDays, seriesProblem } from "../visit-series";
import { ScheduleSeriesSchema, SERIES_MAX_VISITS, SeriesActionSchema } from "../visit.types";

const NY = "America/New_York";

describe("the practice's clock", () => {
  it("reads 10:00 typed for a New York practice as 10:00 there, in summer and winter", () => {
    expect(orgInstant("2026-11-03T10:00", NY).toISOString()).toBe("2026-11-03T15:00:00.000Z");
    expect(orgInstant("2026-07-03T10:00", NY).toISOString()).toBe("2026-07-03T14:00:00.000Z");
    expect(orgInstant("2026-11-03T10:00", "America/Los_Angeles").toISOString()).toBe("2026-11-03T18:00:00.000Z");
  });

  it("CONTROL: the bug it replaces: read in Karachi's zone, 10:00 is 05:00 UTC, 01:00 in New York", () => {
    const wrong = new Date("2026-11-03T10:00:00+05:00");
    expect(orgLocalInput(wrong, NY)).toBe("2026-11-03T00:00");
    expect(orgLocalInput(orgInstant("2026-11-03T10:00", NY), NY)).toBe("2026-11-03T10:00");
  });

  it("round-trips, and keeps the day on the practice's calendar", () => {
    // Either side of both clock changes, where one pass at the offset lands an hour out.
    for (const local of ["2026-01-15T00:00", "2026-03-08T01:59", "2026-03-08T03:30", "2026-06-30T23:59", "2026-10-31T23:30", "2026-11-01T02:30", "2026-11-01T12:00"]) {
      expect(orgLocalInput(orgInstant(local, NY), NY)).toBe(local);
    }
    expect(orgLocalDate(orgInstant("2026-06-30T23:30", NY), NY)).toBe("2026-06-30");
  });

  it("gives a time the clocks skip an hour on, and one they pass twice the first", () => {
    expect(orgLocalInput(orgInstant("2026-03-08T02:30", NY), NY)).toBe("2026-03-08T03:30");
    expect(orgInstant("2026-11-01T01:30", NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("says the time and the zone", () => {
    expect(orgClockTime("2026-11-03T15:00:00Z", NY)).toBe("10:00 AM");
    expect(orgZoneName(NY)).toBe("ET");
    expect(orgZoneName("America/Chicago")).toBe("CT");
  });

  it("refuses what is not a time, and a missing zone", () => {
    expect(() => orgInstant("2026-11-03", NY)).toThrow(RangeError);
    expect(() => orgInstant("2026-11-03T10:00", "")).toThrow(TypeError);
  });
});

describe("the days of a series", () => {
  it("runs every N weeks, for a number of visits", () => {
    expect(seriesDays({ first: "2026-11-03", every: 2, unit: "week", count: 4 })).toEqual(["2026-11-03", "2026-11-17", "2026-12-01", "2026-12-15"]);
  });

  it("runs to a last day, that day included", () => {
    expect(seriesDays({ first: "2026-11-03", every: 1, unit: "week", until: "2026-11-17" })).toEqual(["2026-11-03", "2026-11-10", "2026-11-17"]);
    expect(seriesDays({ first: "2026-11-03", every: 1, unit: "week", until: "2026-11-16" })).toHaveLength(2);
  });

  it("keeps the day of the month, and takes the month's last when it has none", () => {
    expect(seriesDays({ first: "2026-01-31", every: 1, unit: "month", count: 4 })).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(seriesDays({ first: "2028-01-31", every: 1, unit: "month", count: 2 })[1]).toBe("2028-02-29");
  });

  it("crosses a year", () => {
    expect(seriesDays({ first: "2026-11-15", every: 2, unit: "month", count: 3 })).toEqual(["2026-11-15", "2027-01-15", "2027-03-15"]);
  });

  it("stops one past the most a series may hold, so too many can be told from exactly the most", () => {
    const most = seriesDays({ first: "2026-01-01", every: 1, unit: "week", count: SERIES_MAX_VISITS });
    expect(most).toHaveLength(SERIES_MAX_VISITS);
    expect(seriesProblem(most)).toBeNull();
    const tooMany = seriesDays({ first: "2026-01-01", every: 1, unit: "week", until: "2030-01-01" });
    expect(tooMany).toHaveLength(SERIES_MAX_VISITS + 1);
    expect(seriesProblem(tooMany)).toBe(`That is more than ${SERIES_MAX_VISITS} visits. End it sooner.`);
  });

  it("CONTROL: a last day before the second visit is not a series", () => {
    expect(seriesProblem(seriesDays({ first: "2026-11-03", every: 1, unit: "week", until: "2026-11-05" }))).toContain("at least two");
  });

  it("gives nothing for a day that does not exist", () => {
    expect(seriesDays({ first: "2026-02-30", every: 1, unit: "week", count: 3 })).toEqual([]);
  });
});

describe("what stands in the way", () => {
  const days = ["2026-11-03", "2026-11-10", "2026-11-17"];

  it("says which day is full and which the clinician is off", () => {
    const c = seriesConflicts({
      days,
      visitsByDay: new Map([["2026-11-10", 8], ["2026-11-03", 7]]),
      capacity: 8,
      timeOff: [{ startDate: "2026-11-16", endDate: "2026-11-20" }],
    });
    expect(c).toEqual([
      { day: "2026-11-10", kind: "capacity", detail: "The clinician already has 8 visits that day (cap 8)." },
      { day: "2026-11-17", kind: "time_off", detail: "The clinician is on time off." },
    ]);
  });

  it("names time off once on a full day that is also a day off", () => {
    const c = seriesConflicts({ days: ["2026-11-10"], visitsByDay: new Map([["2026-11-10", 8]]), capacity: 8, timeOff: [{ startDate: "2026-11-10", endDate: "2026-11-10" }] });
    expect(c.map((x) => x.kind)).toEqual(["time_off"]);
  });

  it("CONTROL: says nothing with room on every day", () => {
    expect(seriesConflicts({ days, visitsByDay: new Map([["2026-11-03", 7]]), capacity: 8, timeOff: [] })).toEqual([]);
  });
});

describe("what a booking takes", () => {
  const good = {
    patientId: "11111111-1111-4111-8111-111111111111",
    clinicianUserId: "22222222-2222-4222-8222-222222222222",
    visitType: "established_patient_home",
    startLocal: "2026-11-03T10:00",
    isTelehealth: false,
    every: 2,
    unit: "week",
  };

  it("ends on a date or after a number of visits, not both and not neither", () => {
    expect(ScheduleSeriesSchema.safeParse({ ...good, count: 6 }).success).toBe(true);
    expect(ScheduleSeriesSchema.safeParse({ ...good, until: "2027-01-01" }).success).toBe(true);
    expect(ScheduleSeriesSchema.safeParse(good).success).toBe(false);
    expect(ScheduleSeriesSchema.safeParse({ ...good, count: 6, until: "2027-01-01" }).success).toBe(false);
  });

  it("refuses a series of one, of too many, and a time with no minutes", () => {
    expect(ScheduleSeriesSchema.safeParse({ ...good, count: 1 }).success).toBe(false);
    expect(ScheduleSeriesSchema.safeParse({ ...good, count: SERIES_MAX_VISITS + 1 }).success).toBe(false);
    expect(ScheduleSeriesSchema.safeParse({ ...good, count: 6, startLocal: "2026-11-03" }).success).toBe(false);
  });

  it("takes the two things that can be done to the rest of a series", () => {
    expect(SeriesActionSchema.safeParse({ action: "cancel" }).success).toBe(true);
    expect(SeriesActionSchema.safeParse({ action: "move", startLocal: "2026-11-05T09:00" }).success).toBe(true);
    expect(SeriesActionSchema.safeParse({ action: "move" }).success).toBe(false);
    expect(SeriesActionSchema.safeParse({ action: "delete" }).success).toBe(false);
  });
});
