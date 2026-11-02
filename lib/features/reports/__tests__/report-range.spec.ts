/**
 * The Reports page's windows (Level-1 doc:75): presets counted back from the
 * practice's today, the custom window's checks, and when the trend switches
 * from a bar a day to a bar a month.
 */
import { describe, expect, it } from "vitest";

import {
  DAILY_TREND_MAX_DAYS,
  MAX_REPORT_DAYS,
  REPORT_PRESETS,
  presetFor,
  presetRange,
  rangeDays,
  rangeFromParams,
  rangeLabel,
  rangeProblem,
  trendBucket,
  trendLabel,
} from "../report-range";

describe("presetRange", () => {
  const TODAY = "2026-10-27";

  it("counts the rolling windows back from today, today included", () => {
    expect(presetRange("30d", TODAY)).toEqual({ fromDate: "2026-09-28", toDate: TODAY });
    expect(presetRange("90d", TODAY)).toEqual({ fromDate: "2026-07-30", toDate: TODAY });
    expect(rangeDays(presetRange("30d", TODAY))).toBe(30);
    expect(rangeDays(presetRange("90d", TODAY))).toBe(90);
  });

  it("takes this month, last month and the year from the calendar", () => {
    expect(presetRange("this_month", TODAY)).toEqual({ fromDate: "2026-10-01", toDate: TODAY });
    expect(presetRange("last_month", TODAY)).toEqual({ fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(presetRange("ytd", TODAY)).toEqual({ fromDate: "2026-01-01", toDate: TODAY });
    expect(presetRange("12m", TODAY)).toEqual({ fromDate: "2025-11-01", toDate: TODAY });
  });

  it("crosses the year in January and ends February on its own last day", () => {
    expect(presetRange("last_month", "2027-01-15")).toEqual({ fromDate: "2026-12-01", toDate: "2026-12-31" });
    expect(presetRange("12m", "2027-01-15")).toEqual({ fromDate: "2026-02-01", toDate: "2027-01-15" });
    expect(presetRange("last_month", "2028-03-02")).toEqual({ fromDate: "2028-02-01", toDate: "2028-02-29" });
    expect(presetRange("this_month", "2026-11-01")).toEqual({ fromDate: "2026-11-01", toDate: "2026-11-01" });
  });

  it("CONTROL: every preset is a window the API accepts", () => {
    for (const p of REPORT_PRESETS) expect(rangeProblem(presetRange(p, "2026-01-01")), p).toBeNull();
  });

  it("names the preset a window is, and none for a custom one", () => {
    expect(presetFor(presetRange("ytd", "2026-10-27"), "2026-10-27")).toBe("ytd");
    expect(presetFor({ fromDate: "2026-10-02", toDate: "2026-10-27" }, "2026-10-27")).toBeNull();
  });
});

describe("rangeProblem", () => {
  it("refuses a window that starts after it ends, and one past five years", () => {
    expect(rangeProblem({ fromDate: "2026-10-27", toDate: "2026-10-01" })).toBe("The range starts after it ends.");
    expect(rangeProblem({ fromDate: "2020-01-01", toDate: "2026-10-27" })).toBe("Pick a range of five years or less.");
    expect(rangeProblem({ fromDate: "", toDate: "2026-10-27" })).toBe("Pick both dates.");
  });

  it("CONTROL: takes a one-day window and one of exactly the longest length", () => {
    expect(rangeProblem({ fromDate: "2026-10-27", toDate: "2026-10-27" })).toBeNull();
    const longest = { fromDate: "2021-10-26", toDate: "2026-10-27" };
    expect(rangeDays(longest)).toBeLessThanOrEqual(MAX_REPORT_DAYS);
    expect(rangeProblem(longest)).toBeNull();
  });
});

describe("rangeFromParams — the Dashboard's ?from=&to=", () => {
  it("takes a window both ends name, and none when the URL names none", () => {
    expect(rangeFromParams({ from: "2026-08-01", to: "2026-08-31" })).toEqual({
      range: { fromDate: "2026-08-01", toDate: "2026-08-31" },
      problem: null,
    });
    expect(rangeFromParams({})).toEqual({ range: null, problem: null });
  });

  it("CONTROL: says why it cannot show a window, and shows none", () => {
    expect(rangeFromParams({ from: "2026-08-31", to: "2026-08-01" })).toEqual({
      range: null,
      problem: "The range starts after it ends.",
    });
    expect(rangeFromParams({ from: "2026-08-01" }).problem).toBe("Pick both dates.");
    expect(rangeFromParams({ from: "2026-02-30", to: "2026-03-01" }).problem).toBe("Pick both dates.");
    // ?from=a&from=b arrives as an array: not a day.
    expect(rangeFromParams({ from: ["2026-08-01", "2026-08-02"], to: "2026-08-31" }).range).toBeNull();
  });

  it("labels a window by its preset, else by its days; a month key reads as a month", () => {
    expect(rangeLabel({ fromDate: "2026-01-01", toDate: "2026-10-27" }, "2026-10-27")).toBe("Year to date");
    // August is not "Last month" in October.
    expect(rangeLabel({ fromDate: "2026-08-01", toDate: "2026-08-31" }, "2026-10-27")).toBe("2026-08-01 → 2026-08-31");
    expect(rangeLabel({ fromDate: "2026-09-01", toDate: "2026-09-30" }, "2026-10-27")).toBe("Last month");
    expect(trendLabel("2026-10-27")).toBe("2026-10-27");
    expect(trendLabel("2026-10")).toMatch(/2026/);
  });
});

describe("trendBucket", () => {
  it("draws days up to 92 of them, months beyond", () => {
    const days = (n: number) => ({ fromDate: "2026-01-01", toDate: new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10) });
    expect(rangeDays(days(DAILY_TREND_MAX_DAYS))).toBe(92);
    expect(trendBucket(days(92))).toBe("day");
    expect(trendBucket(days(93))).toBe("month");
  });
});
