/**
 * Repeating visits (0126): the days a series falls on, and what stands in the
 * way of one. Pure, so the booking form can preview exactly what the server will
 * book. Days are the practice's.
 */
import { addDaysIso, isCalendarDay } from "@/lib/features/org/org-date";

import { SERIES_MAX_VISITS, type SeriesUnit } from "./visit.types";

/** A month on from a day: the same day of the month, or the month's last when it has no such day. */
function addMonths(day: string, n: number): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const date = Math.min(Number(day.slice(8, 10)), last);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
}

/**
 * The days of a series, starting on `first`. Stops one past the most a series
 * may hold, so a caller can tell "exactly the most" from "too many".
 */
export function seriesDays(a: { first: string; every: number; unit: SeriesUnit; until?: string | null; count?: number | null }): string[] {
  if (!isCalendarDay(a.first)) return [];
  const out: string[] = [];
  for (let k = 0; k <= SERIES_MAX_VISITS; k++) {
    if (a.count != null && k >= a.count) break;
    const day = a.unit === "week" ? addDaysIso(a.first, 7 * a.every * k) : addMonths(a.first, a.every * k);
    if (a.until && day > a.until) break;
    out.push(day);
  }
  return out;
}

/** Why a series as asked cannot be booked, or null. */
export function seriesProblem(days: string[]): string | null {
  if (days.length > SERIES_MAX_VISITS) return `That is more than ${SERIES_MAX_VISITS} visits. End it sooner.`;
  if (days.length < 2) return "A repeating visit needs at least two visits. Check the end date.";
  return null;
}

export interface SeriesConflict {
  day: string;
  kind: "capacity" | "time_off";
  detail: string;
}

/**
 * The days that need a person's eye: the clinician is off, or the day is full.
 * One line a day, time off first: a full day does not matter on a day off.
 */
export function seriesConflicts(a: {
  days: string[];
  visitsByDay: Map<string, number>;
  capacity: number;
  timeOff: { startDate: string; endDate: string }[];
}): SeriesConflict[] {
  const out: SeriesConflict[] = [];
  for (const day of a.days) {
    if (a.timeOff.some((t) => t.startDate <= day && day <= t.endDate)) {
      out.push({ day, kind: "time_off", detail: "The clinician is on time off." });
      continue;
    }
    const n = a.visitsByDay.get(day) ?? 0;
    if (n >= a.capacity) out.push({ day, kind: "capacity", detail: `The clinician already has ${n} visit${n === 1 ? "" : "s"} that day (cap ${a.capacity}).` });
  }
  return out;
}
