/**
 * The windows the Reports page offers (Level-1 doc:75, reports by date range).
 *
 * The page always showed the last 30 days, though the API took any window.
 * Pure: the page works the presets out from the practice's today, which the
 * API returns, so "This month" is the practice's month and not the browser's.
 */
import { addDaysIso, isCalendarDay } from "@/lib/features/org/org-date";

export const REPORT_PRESETS = ["30d", "90d", "this_month", "last_month", "ytd", "12m"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  this_month: "This month",
  last_month: "Last month",
  ytd: "Year to date",
  "12m": "Last 12 months",
};

export interface ReportRange {
  fromDate: string;
  toDate: string;
}

/** The longest window a report takes: five years. */
export const MAX_REPORT_DAYS = 5 * 366;

/**
 * Up to this many days the trend is drawn a bar a day; longer, a bar a month.
 * A year of daily bars is 365 slivers, unreadable at any width.
 */
export const DAILY_TREND_MAX_DAYS = 92;

const firstOfMonth = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`;

/** The window a preset names, ending on the practice's today. */
export function presetRange(preset: ReportPreset, today: string): ReportRange {
  if (!isCalendarDay(today)) throw new RangeError(`Not a calendar day: ${today}`);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  switch (preset) {
    case "30d":
      return { fromDate: addDaysIso(today, -29), toDate: today };
    case "90d":
      return { fromDate: addDaysIso(today, -89), toDate: today };
    case "this_month":
      return { fromDate: firstOfMonth(y, m), toDate: today };
    case "last_month": {
      const first = m === 1 ? firstOfMonth(y - 1, 12) : firstOfMonth(y, m - 1);
      return { fromDate: first, toDate: addDaysIso(firstOfMonth(y, m), -1) };
    }
    case "ytd":
      return { fromDate: `${y}-01-01`, toDate: today };
    case "12m": {
      // Twelve calendar months, this one included: a monthly trend of twelve
      // bars, the last one the month so far.
      const back = m - 11;
      return { fromDate: back >= 1 ? firstOfMonth(y, back) : firstOfMonth(y - 1, back + 12), toDate: today };
    }
  }
}

/** Days in a window, both ends included. */
export function rangeDays(r: ReportRange): number {
  return Math.round((Date.parse(`${r.toDate}T00:00:00Z`) - Date.parse(`${r.fromDate}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Why a window cannot be reported on, or null. */
export function rangeProblem(r: ReportRange): string | null {
  if (!isCalendarDay(r.fromDate) || !isCalendarDay(r.toDate)) return "Pick both dates.";
  if (r.fromDate > r.toDate) return "The range starts after it ends.";
  if (rangeDays(r) > MAX_REPORT_DAYS) return "Pick a range of five years or less.";
  return null;
}

export type TrendBucket = "day" | "month";

export function trendBucket(r: ReportRange): TrendBucket {
  return rangeDays(r) <= DAILY_TREND_MAX_DAYS ? "day" : "month";
}

/** The preset a window is, if it is one (so the page can mark it). */
export function presetFor(r: ReportRange, today: string): ReportPreset | null {
  return REPORT_PRESETS.find((p) => {
    const q = presetRange(p, today);
    return q.fromDate === r.fromDate && q.toDate === r.toDate;
  }) ?? null;
}

/** How a window reads in a heading: its preset's name, or its two days. */
export function rangeLabel(r: ReportRange, today: string): string {
  const preset = presetFor(r, today);
  return preset ? REPORT_PRESET_LABELS[preset] : `${r.fromDate} → ${r.toDate}`;
}

/** A trend point's key as a reader says it: 'YYYY-MM' → "Oct 2026"; a day stays as it is. */
export function trendLabel(key: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A window from a page's search params (?from=&to=), or null when they name
 * none; `problem` says why one that was named cannot be shown.
 */
export function rangeFromParams(params: {
  from?: string | string[];
  to?: string | string[];
}): { range: ReportRange | null; problem: string | null } {
  const from = typeof params.from === "string" ? params.from : undefined;
  const to = typeof params.to === "string" ? params.to : undefined;
  if (from === undefined && to === undefined) return { range: null, problem: null };
  const range = { fromDate: from ?? "", toDate: to ?? "" };
  const problem = rangeProblem(range);
  return problem ? { range: null, problem } : { range, problem: null };
}
