/**
 * The monthly board report: what the practice's Trend Report and its deck carry,
 * built by Pallio with no AI and no screenshots.
 *
 * Pure. The service reads four KPI reports; this turns them into one structure
 * that the workbook, the deck and the PDF are all written from, so the three can
 * never disagree. Everything is computed from the monthly rows. Ranges and
 * divisors come from the month reported, so a column cannot be missed and a
 * chart cannot run a month short.
 *
 * exceptions lists what a person should look at before the report goes
 * anywhere: rows with no reason, months that do not reconcile, months with
 * nothing in them. It never changes a figure.
 */
import { z } from "zod";

import { planFor, type KpiEntered, type KpiReason } from "./kpi-history";
import { findKpiRow, formatKpi, kpiMonthLabel, monthEnd, type KpiDifference, type KpiMonth, type KpiReport, type KpiRow, type KpiUnit } from "./kpi-report";
import type { KpiYearOverYear } from "./kpi-year-over-year";
import type { ReportRange } from "./report-range";

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Pick a month.");

export const BoardQuerySchema = z.object({ month: Month.optional() });

export const BOARD_FORMATS = ["xlsx", "pptx", "pdf"] as const;
export type BoardFormat = (typeof BOARD_FORMATS)[number];

export const BoardFileSchema = z.object({
  month: Month,
  format: z.enum(BOARD_FORMATS),
  /** Typed on the page: the highlights only a person knows. */
  celebrations: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
});

export interface BoardRow {
  label: string;
  unit: KpiUnit;
  /** One per column. */
  values: (number | null)[];
  /** Indexes of the columns entered by hand. */
  entered?: number[];
  total?: number | null;
  /** A heading between groups of rows; it has no values. */
  heading?: boolean;
}

export interface BoardTable {
  title: string;
  columns: string[];
  rows: BoardRow[];
}

export interface BoardChart {
  title: string;
  categories: string[];
  bars: { name: string; values: (number | null)[] }[];
  lines: { name: string; values: (number | null)[] }[];
}

export interface BoardSource {
  label: string;
  referrals: number;
  admitted: number;
}

export interface BoardException {
  /** 'YYYY-MM', or null for one about the report as a whole. */
  month: string | null;
  text: string;
}

export interface BoardReport {
  orgName: string;
  month: string;
  /** "June 2026" */
  monthLabel: string;
  today: string;
  celebrations: string[];
  /** The figures slide 2 has always carried. */
  highlights: string[];
  planVsActual: BoardTable;
  billing: BoardChart;
  census: BoardChart;
  year: KpiYearOverYear;
  pipeline: BoardChart;
  sources: BoardSource[];
  ntuc: BoardTable;
  discharges: BoardTable;
  exceptions: BoardException[];
}

export interface BoardInputs {
  orgName: string;
  month: string;
  today: string;
  /** January two years back, to the month: the charts' span. */
  span: KpiReport;
  /** January to the month. */
  yearReport: KpiReport;
  /** The twelve months to the month. */
  twelve: KpiReport;
  year: KpiYearOverYear;
  plan: KpiEntered[];
  reasons: KpiReason[];
  /** Patients both closed as not taken under care and discharged in the month. */
  onBothLists: number;
  celebrations: string[];
}

export const boardMonthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** "Jun-26", as the Trend Report heads its columns. */
export const boardShortMonth = (month: string) =>
  `${new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}-${month.slice(2, 4)}`;

export interface BoardWindows {
  span: ReportRange;
  year: ReportRange;
  twelve: ReportRange;
}

/** The windows a month's report reads, all ending with the month. */
export function boardWindows(month: string): BoardWindows {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const toDate = monthEnd(month);
  const back = m - 11;
  const twelveFrom = back >= 1 ? `${y}-${String(back).padStart(2, "0")}-01` : `${y - 1}-${String(back + 12).padStart(2, "0")}-01`;
  return {
    span: { fromDate: `${y - 2}-01-01`, toDate },
    year: { fromDate: `${y}-01-01`, toDate },
    twelve: { fromDate: twelveFrom, toDate },
  };
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);

const rowOf = (r: KpiReport, key: string): KpiRow | null => findKpiRow(r, key);

function values(r: KpiReport, key: string): (number | null)[] {
  return rowOf(r, key)?.months ?? zeros(r.months.length);
}

function line(r: KpiReport, label: string, key: string): BoardRow {
  const row = rowOf(r, key);
  return { label, unit: row?.unit ?? "count", values: values(r, key), entered: row?.entered };
}

function planRow(months: KpiMonth[], plan: KpiEntered[], label: string, measure: string, unit: KpiUnit): BoardRow {
  return {
    label, unit,
    values: months.map((m) => {
      const v = planFor(plan, measure, m.key);
      return v === null ? null : unit === "money" ? Math.round(v * 100) : v;
    }),
  };
}

function planVsActual(i: BoardInputs): BoardTable {
  const r = i.span;
  const heading = (label: string): BoardRow => ({ label, unit: "count", values: [], heading: true });
  return {
    title: "Plan vs actual",
    columns: r.months.map((m) => boardShortMonth(m.key)),
    rows: [
      heading("Admissions"),
      planRow(r.months, i.plan, "Goal", "plan:admissions", "count"),
      line(r, "Actual", "referrals:admitted"),
      line(r, "Referrals", "referrals"),
      heading("Palliative census"),
      planRow(r.months, i.plan, "Goal", "plan:census", "count"),
      line(r, "Actual", "census"),
      planRow(r.months, i.plan, "Nurse practitioners", "plan:nps", "count"),
      heading("Revenue"),
      planRow(r.months, i.plan, "Plan", "plan:billing", "money"),
      line(r, "Billing", "billed"),
      heading("Visits"),
      line(r, "New patient visits", "visits:type:New patient"),
      line(r, "Follow-up visits", "visits:type:Follow-up"),
      line(r, "Total", "visits_new_followup"),
      line(r, "Goals of care discussions (ACP)", "visits_acp"),
      heading("Transitions to hospice"),
      line(r, "To the partner hospice", "transitions:partner"),
      line(r, "To other hospices", "transitions:other"),
      line(r, "Total", "transitions"),
      line(r, "% to the partner hospice", "transitions_partner_share"),
      heading("Deaths"),
      line(r, "Deaths on palliative care", "deaths"),
    ],
  };
}

/** A table of a reason's counts: every code the practice has, in its order, then anything else. */
function reasonTable(i: BoardInputs, kind: KpiReason["kind"], title: string, parentKey: string): BoardTable {
  const r = i.yearReport;
  const parent = rowOf(r, parentKey);
  const parts = parent?.children ?? [];
  const codes = i.reasons.filter((x) => x.kind === kind).map((x) => `${x.code} ${x.label}`);
  const others = parts.filter((c) => !codes.includes(c.label)).map((c) => c.label);
  const rows: BoardRow[] = [...codes, ...others].map((label) => {
    const part = parts.find((c) => c.label === label);
    return { label, unit: "count", values: part?.months ?? zeros(r.months.length), entered: part?.entered, total: part?.total ?? 0 };
  });
  rows.push({ label: "Total", unit: "count", values: parent?.months ?? zeros(r.months.length), total: parent?.total ?? 0 });
  return { title, columns: r.months.map((m) => boardShortMonth(m.key)), rows };
}

const inDollars = (xs: (number | null)[]) => xs.map((v) => (v === null ? null : v / 100));

/** From the first month with a figure: the months before a practice began say nothing. */
function fromFirstFigure(c: BoardChart): BoardChart {
  const first = c.bars[0]!.values.findIndex((v) => v);
  if (first <= 0) return c;
  const cut = <T,>(xs: T[]) => xs.slice(first);
  return {
    ...c,
    categories: cut(c.categories),
    bars: c.bars.map((s) => ({ ...s, values: cut(s.values) })),
    lines: c.lines.map((s) => ({ ...s, values: cut(s.values) })),
  };
}

function charts(i: BoardInputs) {
  const r = i.span;
  const categories = r.months.map((m) => boardShortMonth(m.key));
  const billingPlan = planRow(r.months, i.plan, "Plan", "plan:billing", "money").values;
  const censusGoal = planRow(r.months, i.plan, "Goal", "plan:census", "count").values;
  const hasAny = (xs: (number | null)[]) => xs.some((v) => v !== null);
  const billing = fromFirstFigure({
    title: "Billing",
    categories,
    bars: [{ name: "Billing", values: inDollars(values(r, "billed")) }],
    lines: hasAny(billingPlan) ? [{ name: "Plan", values: inDollars(billingPlan) }] : [],
  });
  const census = fromFirstFigure({
    title: "Palliative census",
    categories,
    bars: [{ name: "Census", values: values(r, "census") }],
    lines: hasAny(censusGoal) ? [{ name: "Goal", values: censusGoal }] : [],
  });
  const t = i.twelve;
  const received = values(t, "referrals");
  const admitted = values(t, "referrals:admitted");
  const pipeline: BoardChart = {
    title: "Referrals by outcome",
    categories: t.months.map((m) => boardShortMonth(m.key)),
    bars: [
      { name: "Admitted", values: admitted },
      { name: "Not admitted or still open", values: received.map((v, k) => Math.max(0, (v ?? 0) - (admitted[k] ?? 0))) },
    ],
    lines: [],
  };
  return { billing, census, pipeline };
}

function topSources(t: KpiReport): BoardSource[] {
  const referrals = rowOf(t, "source_referrals")?.children ?? [];
  const admitted = rowOf(t, "source_admitted")?.children ?? [];
  return referrals
    .filter((c) => c.label !== "Source not recorded")
    .slice(0, 10)
    .map((c) => ({ label: c.label, referrals: c.total ?? 0, admitted: admitted.find((a) => a.label === c.label)?.total ?? 0 }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function differenceText(d: KpiDifference): BoardException {
  const say = (v: number) => formatKpi(v, d.unit);
  return { month: d.month, text: `${boardMonthLabel(d.month)}: ${d.label} was entered as ${say(d.entered)}; Pallio counts ${say(d.pallio)}. The entered figure is used.` };
}

function exceptions(i: BoardInputs): BoardException[] {
  const r = i.yearReport;
  const out: BoardException[] = [];
  const monthOf = (at: number) => r.months[at]!.key;
  const label = (at: number) => kpiMonthLabel(r.months[at]!);

  if (i.month >= i.today.slice(0, 7)) {
    out.push({ month: i.month, text: `${boardMonthLabel(i.month)} is still under way: its figures run to ${i.today}.` });
  }

  // A month with nothing in it is more likely missing than quiet.
  r.months.forEach((m, at) => {
    const blank = ["referrals", "census", "visits_new_followup", "billed"].every((key) => !values(r, key)[at]);
    if (blank) out.push({ month: m.key, text: `Nothing is recorded for ${label(at)}: no referrals, census, visits or billing.` });
  });

  // In the total but on no reason's row.
  for (const [key, one, many] of [
    ["discharges:No reason recorded", "discharge", "discharges"],
    ["ntuc:No reason recorded", "referral not taken under care", "referrals not taken under care"],
  ] as const) {
    values(r, key).forEach((n, at) => {
      if (n) out.push({ month: monthOf(at), text: `${label(at)}: ${plural(n, one, many)} with no reason recorded, in the total but on no reason's row.` });
    });
  }

  // The same count read two ways: they agree unless a figure was entered.
  const category = (categories: string[]) => (rowOf(r, "discharges")?.children ?? []).filter((c) => i.reasons.some((x) => x.kind === "discharge" && categories.includes(x.category) && `${x.code} ${x.label}` === c.label));
  for (const [key, name, categories] of [
    ["transitions:partner", "transitions to the partner hospice", ["hospice_partner"]],
    ["transitions:other", "transitions to other hospices", ["hospice_other"]],
    ["deaths", "deaths", ["death"]],
  ] as const) {
    const parts = category([...categories]);
    const row = values(r, key);
    row.forEach((n, at) => {
      const byReason = parts.reduce((sum, c) => sum + (c.months[at] ?? 0), 0);
      // Only months that have a figure by reason: without one there is nothing to compare.
      if (parts.some((c) => c.entered?.includes(at)) && (n ?? 0) !== byReason) {
        out.push({ month: monthOf(at), text: `${label(at)}: ${n ?? 0} ${name} on the plan sheet, ${byReason} by discharge reason.` });
      }
    });
  }

  values(r, "referrals").forEach((n, at) => {
    const admitted = values(r, "referrals:admitted")[at] ?? 0;
    if ((n ?? 0) < admitted) out.push({ month: monthOf(at), text: `${label(at)}: ${admitted} admitted of ${n ?? 0} referrals.` });
  });

  // Visits the Trend Report's total leaves out.
  const made = values(r, "visits").at(-1) ?? 0;
  const total = values(r, "visits_new_followup").at(-1) ?? 0;
  if (made > total) {
    out.push({ month: i.month, text: `${boardMonthLabel(i.month)}: ${plural(made - total, "visit")} of other kinds (consults, not billed) ${made - total === 1 ? "is" : "are"} not in the ${total} new patient and follow-up visits.` });
  }

  if (i.onBothLists > 0) {
    out.push({ month: i.month, text: `${boardMonthLabel(i.month)}: ${plural(i.onBothLists, "patient")} ${i.onBothLists === 1 ? "is" : "are"} on both the not taken under care and the discharges lists.` });
  }

  for (const d of i.span.differences ?? []) out.push(differenceText(d));

  for (const [measure, name] of [["plan:billing", "billing plan"], ["plan:census", "census goal"], ["plan:admissions", "admissions goal"]] as const) {
    if (planFor(i.plan, measure, i.month) === null) out.push({ month: null, text: `No ${name} is entered, so the report has no line to measure it against. Add it on Monthly history.` });
  }

  return out;
}

export function buildBoardReport(i: BoardInputs): BoardReport {
  const visits = i.year.rows.find((r) => r.key === "visits")?.current ?? 0;
  return {
    orgName: i.orgName,
    month: i.month,
    monthLabel: boardMonthLabel(i.month),
    today: i.today,
    celebrations: i.celebrations,
    highlights: [`${visits.toLocaleString("en-US")} YTD patient visits`],
    planVsActual: planVsActual(i),
    ...charts(i),
    year: i.year,
    sources: topSources(i.twelve),
    ntuc: reasonTable(i, "ntuc", "Not taken under care", "ntuc"),
    discharges: reasonTable(i, "discharge", "Discharges from palliative care", "discharges"),
    exceptions: exceptions(i),
  };
}
