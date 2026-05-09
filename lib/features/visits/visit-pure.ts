/**
 * Visit pure helpers — time math and status-transition rules.
 *
 * No DB, no env, no fetch. Lifted into its own module so unit tests
 * never need a fixture or container.
 */
import type { VisitStatus } from "./visit.types";

/**
 * Compute total minutes from start/stop. Rounds DOWN to whole minutes
 * so a 29:59 visit is 29 minutes (not 30) — Mark's clinicians document
 * to the literal stop time.
 *
 * Returns null when either timestamp is missing or stop precedes start.
 */
export function computeTotalMinutes(
  startTime: Date | null | undefined,
  stopTime: Date | null | undefined,
): number | null {
  if (!startTime || !stopTime) return null;
  const ms = stopTime.getTime() - startTime.getTime();
  if (ms < 0) return null;
  return Math.floor(ms / 60_000);
}

/** Allowed status transitions. Anything else throws. */
const TRANSITIONS: Record<VisitStatus, VisitStatus[]> = {
  scheduled: ["in_progress", "cancelled", "no_show"],
  in_progress: ["documented", "cancelled"],
  documented: ["pending_billing"],
  pending_billing: ["billed"],
  billed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: VisitStatus, to: VisitStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatuses(from: VisitStatus): VisitStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * Medicare 11-day billing window per §5.2: 3 days before DOS + DOS + 7
 * days after = 11 days. Returns true if `today` is inside the window.
 *
 * Used by the FE to render a "submit before X" hint on documented
 * visits + by the billing dashboard alert system.
 */
export function isInsideMedicareWindow(
  dos: Date,
  today: Date = new Date(),
): boolean {
  const dosMid = startOfDay(dos);
  const todayMid = startOfDay(today);
  const dayMs = 86_400_000;
  const days = (todayMid.getTime() - dosMid.getTime()) / dayMs;
  return days >= -3 && days <= 7;
}

/**
 * Days remaining in the 11-day Medicare billing window. Returns 0 when
 * outside the window (caller should warn).
 */
export function daysRemainingInMedicareWindow(
  dos: Date,
  today: Date = new Date(),
): number {
  const dosMid = startOfDay(dos);
  const todayMid = startOfDay(today);
  const dayMs = 86_400_000;
  const days = (todayMid.getTime() - dosMid.getTime()) / dayMs;
  if (days < -3 || days > 7) return 0;
  return Math.max(0, 7 - Math.floor(days));
}

function startOfDay(d: Date): Date {
  // UTC-anchored — `setHours()` would use the runtime's local timezone,
  // which makes the day-count math drift across CI and dev machines.
  // Tests + production both interpret the Medicare window in UTC.
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
