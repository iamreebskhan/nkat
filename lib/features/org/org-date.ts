/**
 * Calendar days for a practice: the one rule for turning an instant into a
 * date of service, and the practice time zones the org can be set to (0107).
 *
 * A claim's date of service (CMS-1500 24A, 837P DTP*472) is a calendar date
 * with no time and no zone: the local day the service was furnished. So:
 *
 *   - an INSTANT (a timestamptz: start_time, scheduled_start, signed_at, now)
 *     becomes a day only through orgLocalDate(at, org.timezone), or in SQL
 *     through (ts AT TIME ZONE org.timezone)::date;
 *   - a DATE column (date_of_service, date_of_birth, effective_date) is
 *     already a day. Prisma returns it as a Date at UTC midnight, so it is
 *     read with dateColumnIso (toISOString().slice(0, 10)), never through
 *     orgLocalDate, which would move it back a day west of UTC;
 *   - a day bound into ::date is a 'YYYY-MM-DD' string, never a JS Date: a
 *     Date binds as a timestamptz, and timestamptz::date is its day in the
 *     database SESSION's zone (UTC in CI, Asia/Karachi on the dev machine,
 *     unknown in prod), which is not the practice's;
 *   - never a Date getter (getDate, getHours) or localDateKey on the server:
 *     those give the Node process's zone.
 *
 * Pure, so the server and the browser can both use it.
 *
 * Bills dated before this rule are not re-dated: a submitted claim's date is
 * what the payer holds and echoes in the 835 (DTM*472), so changing it here
 * alone would hold every payment for review (remittance.service.ts). A draft
 * or ready_to_submit bill is corrected by a reviewed one-off update with a
 * superbill_activity row, then repriced; a submitted, paid, partially paid or
 * denied one only together with a corrected claim (frequency code 7).
 *
 * Finder, READ-ONLY. Bills whose stored date of service is not the org-local
 * day of their visit. Run it as the migration role, or per org inside a
 * transaction under SET LOCAL app.current_org_id (under RLS the app role sees
 * one org). Before 0107, put 'America/New_York' in place of o.timezone.
 *
 *   SELECT o.name AS org, s.id AS superbill_id, s.status, s.submitted_at,
 *          to_char(s.date_of_service, 'YYYY-MM-DD') AS billed_dos,
 *          to_char((COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date,
 *                  'YYYY-MM-DD') AS local_dos,
 *          COALESCE(v.start_time, v.scheduled_start) AS visit_at
 *     FROM superbill s
 *     JOIN visit v ON v.id = s.visit_id
 *     JOIN org o ON o.id = s.org_id
 *    WHERE COALESCE(v.start_time, v.scheduled_start) IS NOT NULL
 *      AND s.date_of_service <> (COALESCE(v.start_time, v.scheduled_start) AT TIME ZONE o.timezone)::date
 *    ORDER BY o.name, s.date_of_service;
 *
 * Payments already held over a date-of-service mismatch (READ-ONLY; the
 * prefix is the hold note remittance.service.ts writes):
 *
 *   SELECT r.superbill_id, r.service_dos, r.posting_note
 *     FROM era_835_record r
 *    WHERE r.posting = 'needs_review'
 *      AND r.posting_note LIKE 'The remittance''s date of service is not this bill''s%';
 */

/**
 * The zones org.timezone may hold: the CHECK in 0107_org_timezone.sql, in the
 * same order (org-date.spec.ts keeps the two lists equal).
 */
export const PRACTICE_TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
] as const;
export type PracticeTimeZone = (typeof PRACTICE_TIME_ZONES)[number];

/** The column default: the payer roster is Ohio and the Carolinas. */
export const DEFAULT_ORG_TIME_ZONE: PracticeTimeZone = "America/New_York";

export function isPracticeTimeZone(value: unknown): value is PracticeTimeZone {
  return typeof value === "string" && (PRACTICE_TIME_ZONES as readonly string[]).includes(value);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** One formatter per zone; building one is the expensive part. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for a zone Intl does not know.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/**
 * The calendar day ('YYYY-MM-DD') of an instant in the practice's zone.
 *
 * Throws on an empty or missing zone: Intl.DateTimeFormat with timeZone
 * undefined silently formats in the host's zone, which is how a query that
 * forgot to select org.timezone would otherwise pass unnoticed. Throws
 * RangeError on an invalid instant or an unknown zone, and on a bare
 * 'YYYY-MM-DD', which is already a day (see dateColumnIso).
 */
export function orgLocalDate(at: Date | string, timeZone: string): string {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new TypeError(
      "orgLocalDate needs the org's time zone; without one Intl would use the server's.",
    );
  }
  if (typeof at === "string" && DAY.test(at)) {
    throw new RangeError(`${at} is already a calendar day, not an instant.`);
  }
  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) throw new RangeError(`Invalid instant: ${String(at)}`);
  const parts = formatterFor(timeZone).formatToParts(instant);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Today where the practice is. */
export function orgToday(timeZone: string, now: Date = new Date()): string {
  return orgLocalDate(now, timeZone);
}

/** One minute-precision formatter per zone, as for days above. */
const minuteFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant as the practice reads it: 'YYYY-MM-DD HH:MM' on a 24-hour clock
 * in the practice's zone, then that zone's abbreviation ('EDT', 'CST'), so a
 * printed time says which clock it is on. For a time beside a date of
 * service: in UTC, an Ohio signature at 6 pm read "22:10 UTC", and after 8 pm
 * it fell on the next day. Throws as orgLocalDate does.
 */
export function orgLocalMinute(at: Date | string, timeZone: string): string {
  const day = orgLocalDate(at, timeZone);
  let f = minuteFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    minuteFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at instanceof Date ? at : new Date(at));
  const part = (type: "hour" | "minute" | "timeZoneName") => parts.find((p) => p.type === type)?.value ?? "";
  return `${day} ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}

/**
 * Is this a 'YYYY-MM-DD' day that exists? Check a day from a request with it
 * before binding it into ::date: Postgres refuses 2026-09-31 ("date/time field
 * value out of range"), which is a 500, where Date quietly rolls it over.
 */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to 2 March; a day that does not read
  // back as itself was not a day.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

/**
 * A calendar day plus n days ('YYYY-MM-DD' in and out). Calendar arithmetic
 * on UTC midnights, where every day is 24 hours, so no zone's DST moves it.
 */
export function addDaysIso(day: string, n: number): string {
  if (!isCalendarDay(day)) throw new RangeError(`Not a calendar day: ${day}`);
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * A DATE column's day. Prisma returns a DATE as a Date at UTC midnight, so its
 * UTC day IS the stored day. Never pass one through orgLocalDate: west of UTC
 * that gives the day before.
 */
export function dateColumnIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
