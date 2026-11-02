/**
 * The practice's year-over-year table (its monthly Trend Report's YoY sheet): a
 * period beside the same period a year before, the same fourteen rows in the
 * same order.
 *
 * Pure, and computed: every figure comes from the two KPI reports, so a total
 * cannot drift from its months and a per-month figure cannot keep last month's
 * divisor. The census is the count at the period's end, not a sum.
 *
 * "Per month" divides by the months the period covers: a whole month counts 1
 * and a part of one its share of the month's days, so six whole months divide
 * by exactly 6.
 */
import { isCalendarDay } from "@/lib/features/org/org-date";

import { findKpiRow, monthEnd, percentOf, type KpiMonth, type KpiReport, type KpiUnit } from "./kpi-report";
import type { ReportRange } from "./report-range";

export interface KpiYearRow {
  key: string;
  label: string;
  unit: KpiUnit;
  definition: string;
  prior: number | null;
  current: number | null;
}

export interface KpiYearOverYear {
  current: ReportRange;
  prior: ReportRange;
  /** The months the periods cover, the divisor of the per-month rows. */
  months: number;
  rows: KpiYearRow[];
}

const dayBack = (day: string): string => {
  const y = Number(day.slice(0, 4)) - 1;
  // A month's last day stays its last day: February's is not always the 28th.
  if (day === monthEnd(day.slice(0, 7))) return monthEnd(`${y}${day.slice(4, 7)}`);
  const same = `${y}${day.slice(4)}`;
  return isCalendarDay(same) ? same : monthEnd(`${y}${day.slice(4, 7)}`);
};

/** The same days a year before. */
export const priorYearRange = (r: ReportRange): ReportRange => ({ fromDate: dayBack(r.fromDate), toDate: dayBack(r.toDate) });

const daysOf = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** The months a report's window covers: 1 for a whole month, its share of the days for a part. */
export function monthsCovered(months: KpiMonth[]): number {
  return months.reduce((sum, m) => sum + daysOf(m.from, m.to) / daysOf(`${m.key}-01`, monthEnd(m.key)), 0);
}

const totalOf = (r: KpiReport, key: string) => findKpiRow(r, key)?.total ?? null;

const onePlace = (x: number) => Math.round(x * 10) / 10;

const perMonth = (v: number | null, months: number) => (v === null || months <= 0 ? null : onePlace(v / months));

/** Other ÷ (partner + other): the month columns' reading of "% to Other Hospices". */
function shareToOther(r: KpiReport): number | null {
  const partner = totalOf(r, "transitions:partner");
  const other = totalOf(r, "transitions:other");
  return partner === null || other === null ? null : percentOf(other, partner + other);
}

export function buildYearOverYear(current: KpiReport, prior: KpiReport): KpiYearOverYear {
  const months = monthsCovered(current.months);
  const priorMonths = monthsCovered(prior.months);
  const both = (read: (r: KpiReport, months: number) => number | null) => ({ prior: read(prior, priorMonths), current: read(current, months) });
  const total = (key: string) => both((r) => totalOf(r, key));
  const average = (key: string) => both((r, n) => perMonth(totalOf(r, key), n));
  const line = (key: string, label: string, unit: KpiUnit, definition: string, values: { prior: number | null; current: number | null }): KpiYearRow => ({ key, label, unit, definition, ...values });
  return {
    current: current.range,
    prior: prior.range,
    months,
    rows: [
      line("census", "Palliative census", "count", "Patients under care at the end of the period.", total("census")),
      line("referrals", "Referrals", "count", "Referrals received in the period.", total("referrals")),
      line("admissions", "Total admissions", "count", "Of the referrals received in the period, those admitted.", total("referrals:admitted")),
      line("admissions_per_month", "Admissions per month", "average", "Total admissions ÷ the months the period covers.", average("referrals:admitted")),
      line("admitted_share", "% of referrals admitted", "percent", "Total admissions ÷ referrals.", both((r) => {
        const referrals = totalOf(r, "referrals");
        const admitted = totalOf(r, "referrals:admitted");
        return referrals === null || admitted === null ? null : percentOf(admitted, referrals);
      })),
      line("visits", "Total NP visits", "count", "New patient and follow-up visits.", total("visits_new_followup")),
      line("visits_per_month", "NP visits per month", "average", "Total NP visits ÷ the months the period covers.", average("visits_new_followup")),
      line("acp", "Advance care plans / goals of care", "count", "Visits with advance care planning billed.", total("visits_acp")),
      line("acp_per_month", "Advance care plans / goals of care per month", "average", "The above ÷ the months the period covers.", average("visits_acp")),
      line("to_partner", "Discharges to hospice: partner", "count", "Discharged with a partner-hospice reason code.", total("transitions:partner")),
      line("to_other", "Discharges to hospice: other", "count", "Discharged with another-hospice reason code.", total("transitions:other")),
      line("other_share", "% to other hospices", "percent", "Other ÷ (partner + other).", both(shareToOther)),
      line("deaths", "Deaths on palliative care", "count", "Discharges with a death reason code.", total("deaths")),
      line("deaths_per_month", "Deaths per month", "average", "Deaths ÷ the months the period covers.", average("deaths")),
    ],
  };
}

/** How the row moved: percentage points for a percent, the percent change otherwise; null with nothing to compare. */
export function yearChange(row: KpiYearRow): string {
  if (row.prior === null || row.current === null) return "—";
  const d = row.current - row.prior;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  if (row.unit === "percent") return `${sign}${Math.abs(d).toFixed(1)} pts`;
  if (row.prior === 0) return row.current === 0 ? "0%" : "—";
  return `${sign}${Math.abs((d / row.prior) * 100).toFixed(1)}%`;
}
