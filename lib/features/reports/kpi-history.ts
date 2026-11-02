/**
 * Monthly history (0125): the figures a practice reported for months Pallio has
 * no data for, and its plan.
 *
 * Pure. The measures are the Trend Report's rows and the reason codes' counts.
 * applyKpiHistory lays what was entered over a built report, so the page, the
 * CSV, the workbook, the year-over-year table and the board report all read one
 * set of figures, and anything worked out from an entered figure (conversion,
 * total visits, transitions) is worked out again from it.
 *
 * A figure is for a whole month, so it is left out of a window that holds only
 * part of that month. Where a month was entered, what cannot be known from it
 * reads as not recorded rather than as a zero: a referral's outcome other than
 * admitted, and its source.
 */
import { z } from "zod";

import { findKpiRow, monthEnd, percentOf, type KpiDifference, type KpiReport, type KpiRow } from "./kpi-report";

export interface KpiHistoryMeasure {
  key: string;
  label: string;
  /** Money is typed in dollars. */
  unit: "count" | "money";
}

/** The measures a month can carry, with the report row each stands for. */
const ACTUALS: (KpiHistoryMeasure & { rowKey: string })[] = [
  { key: "referrals", label: "Referrals", unit: "count", rowKey: "referrals" },
  { key: "admitted", label: "Admissions", unit: "count", rowKey: "referrals:admitted" },
  { key: "census", label: "Palliative census", unit: "count", rowKey: "census" },
  { key: "billed", label: "Billing", unit: "money", rowKey: "billed" },
  { key: "visits_new", label: "New patient visits", unit: "count", rowKey: "visits:type:New patient" },
  { key: "visits_followup", label: "Follow-up visits", unit: "count", rowKey: "visits:type:Follow-up" },
  { key: "visits_acp", label: "Goals of care discussions (ACP)", unit: "count", rowKey: "visits_acp" },
  { key: "to_partner", label: "Transitions to the partner hospice", unit: "count", rowKey: "transitions:partner" },
  { key: "to_other", label: "Transitions to other hospices", unit: "count", rowKey: "transitions:other" },
  { key: "deaths", label: "Deaths on palliative care", unit: "count", rowKey: "deaths" },
];

export const PLAN_MEASURES: KpiHistoryMeasure[] = [
  { key: "plan:admissions", label: "Admissions goal", unit: "count" },
  { key: "plan:census", label: "Census goal", unit: "count" },
  { key: "plan:nps", label: "Nurse practitioners", unit: "count" },
  { key: "plan:billing", label: "Billing plan", unit: "money" },
];

export const ACTUAL_MEASURES: KpiHistoryMeasure[] = ACTUALS.map(({ key, label, unit }) => ({ key, label, unit }));

export interface KpiReason {
  kind: "discharge" | "ntuc";
  code: string;
  label: string;
  category: string;
}

export const reasonMeasure = (r: Pick<KpiReason, "kind" | "code">) => `${r.kind}:${r.code}`;

/** One figure, as typed: dollars for money. */
export interface KpiEntered {
  /** 'YYYY-MM' */
  month: string;
  measure: string;
  value: number;
}


const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "A month is YYYY-MM.");

export const HISTORY_CHANGES_MAX = 2000;

/** What a save sends: value null clears the figure. */
export const SaveKpiHistorySchema = z.object({
  changes: z
    .array(
      z.object({
        month: Month,
        measure: z.string().min(1).max(40),
        value: z.number().min(0).max(999_999_999).nullable(),
      }),
    )
    .min(1, "Nothing has changed.")
    .max(HISTORY_CHANGES_MAX),
});

export const KpiHistoryQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });


const blankRow = (months: number, key: string, label: string, like: KpiRow): KpiRow => ({
  key, label, unit: "count", source: like.source, definition: "Entered on Monthly history.", months: Array.from({ length: months }, () => 0), total: 0,
});

function mark(row: KpiRow, at: number): void {
  if (!row.entered?.includes(at)) row.entered = [...(row.entered ?? []), at].sort((a, b) => a - b);
}

function put(row: KpiRow, at: number, value: number | null): void {
  row.months[at] = value;
  mark(row, at);
}

/** The window's figure: nothing when no month has one. */
const sumMonths = (row: KpiRow) => {
  row.total = row.months.every((v) => v === null) ? null : row.months.reduce<number>((n, v) => n + (v ?? 0), 0);
};

/** The report with the entered figures in it; a window with none comes back as it was. */
export function applyKpiHistory(report: KpiReport, entered: KpiEntered[], reasons: KpiReason[] = []): KpiReport {
  const r = structuredClone(report);
  const size = r.months.length;
  const wholeMonths = new Map(
    r.months.flatMap((m, at): [string, number][] => (m.from === `${m.key}-01` && m.to === monthEnd(m.key) ? [[m.key, at]] : [])),
  );
  const usable = entered.flatMap((e) => {
    const at = wholeMonths.get(e.month);
    return at === undefined ? [] : [{ ...e, at }];
  });
  if (usable.length === 0) return report;
  const differences: KpiDifference[] = [];
  const need = (key: string) => {
    const row = findKpiRow(r, key);
    if (!row) throw new Error(`The KPI report has no row ${key}.`);
    return row;
  };

  // What the new-patient and follow-up rows held before, to correct "Visits made".
  const visits = need("visits");
  const madeBefore = (key: string, label: string) => {
    let row = findKpiRow(r, key);
    if (!row && usable.some((e) => e.measure === (label === "New patient" ? "visits_new" : "visits_followup"))) {
      row = { ...blankRow(size, key, label, visits), definition: "Visits made of this kind (the visit type's coding)." };
      visits.children = [...(visits.children ?? []), row];
    }
    return row ? [...row.months] : null;
  };
  const newBefore = madeBefore("visits:type:New patient", "New patient");
  const followBefore = madeBefore("visits:type:Follow-up", "Follow-up");

  for (const m of ACTUALS) {
    const figures = usable.filter((e) => e.measure === m.key);
    if (figures.length === 0) continue;
    const row = need(m.rowKey);
    for (const e of figures) {
      const value = m.unit === "money" ? Math.round(e.value * 100) : e.value;
      const pallio = row.months[e.at] ?? 0;
      if (pallio !== 0 && pallio !== value) differences.push({ month: e.month, label: m.label, unit: m.unit, entered: value, pallio });
      put(row, e.at, value);
    }
    if (m.key !== "census") sumMonths(row);
    else if (row.entered!.includes(size - 1)) row.total = row.months[size - 1] ?? null;
  }

  // Referrals: admitted of received, and what an entered month cannot say.
  const referrals = need("referrals");
  const admitted = need("referrals:admitted");
  const conversion = need("conversion");
  const months = (row: KpiRow) => row.entered ?? [];
  for (const at of new Set([...months(referrals), ...months(admitted)])) {
    put(conversion, at, percentOf(admitted.months[at] ?? 0, referrals.months[at] ?? 0));
  }
  if (conversion.entered) conversion.total = percentOf(admitted.total ?? 0, referrals.total ?? 0);
  for (const at of months(referrals)) {
    for (const key of ["referrals:ntuc", "referrals:transitioned", "referrals:open"]) need(key).months[at] = null;
    for (const top of r.sections.find((s) => s.key === "sources")?.rows ?? []) {
      for (const row of [top, ...(top.children ?? [])]) row.months[at] = null;
    }
  }
  for (const key of ["referrals:ntuc", "referrals:transitioned", "referrals:open"]) sumMonths(need(key));

  // Visits: the Trend Report's total, and "Visits made" with its other kinds kept.
  const newRow = findKpiRow(r, "visits:type:New patient");
  const followRow = findKpiRow(r, "visits:type:Follow-up");
  const total = need("visits_new_followup");
  for (const at of new Set([...(newRow?.entered ?? []), ...(followRow?.entered ?? [])])) {
    const nowNew = newRow?.months[at] ?? 0;
    const nowFollow = followRow?.months[at] ?? 0;
    put(total, at, nowNew + nowFollow);
    put(visits, at, (visits.months[at] ?? 0) + nowNew - (newBefore?.[at] ?? 0) + nowFollow - (followBefore?.[at] ?? 0));
  }
  if (total.entered) {
    sumMonths(total);
    sumMonths(visits);
  }

  // Transitions: the sum and the partner's share.
  const partner = need("transitions:partner");
  const other = need("transitions:other");
  const transitions = need("transitions");
  const share = need("transitions_partner_share");
  for (const at of new Set([...months(partner), ...months(other)])) {
    const p = partner.months[at] ?? 0;
    const o = other.months[at] ?? 0;
    put(transitions, at, p + o);
    put(share, at, percentOf(p, p + o));
  }
  if (transitions.entered) {
    sumMonths(transitions);
    share.total = percentOf(partner.total ?? 0, (partner.total ?? 0) + (other.total ?? 0));
  }

  // Counts by reason: the month's parts, and the month's total of them.
  for (const [kind, parentKey] of [["discharge", "discharges"], ["ntuc", "ntuc"]] as const) {
    const parent = need(parentKey);
    const figures = usable.filter((e) => e.measure.startsWith(`${kind}:`));
    if (figures.length === 0) continue;
    const parts = (parent.children = parent.children ?? []);
    for (const e of figures) {
      const code = e.measure.slice(kind.length + 1);
      const reason = reasons.find((x) => x.kind === kind && x.code === code);
      const label = reason ? `${reason.code} ${reason.label}` : code;
      const key = `${parentKey}:${label}`;
      let part = parts.find((c) => c.key === key);
      if (!part) {
        part = blankRow(size, key, label, parent);
        parts.push(part);
      }
      put(part, e.at, e.value);
    }
    parts.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    for (const part of parts) if (part.entered) sumMonths(part);
    for (const at of new Set(figures.map((e) => e.at))) {
      put(parent, at, parts.reduce((n, c) => n + (c.months[at] ?? 0), 0));
    }
    sumMonths(parent);
  }

  r.differences = differences;
  return r;
}

/** The plan in force for a month: the latest entered at or before it. */
export function planFor(entered: KpiEntered[], measure: string, month: string): number | null {
  const found = entered.filter((e) => e.measure === measure && e.month <= month).sort((a, b) => a.month.localeCompare(b.month)).at(-1);
  return found?.value ?? null;
}
