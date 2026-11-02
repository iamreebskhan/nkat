/**
 * The practice's KPI report (Level-1 doc:80-109; the practice's monthly Trend
 * Report): every measure the document names, by month across a window of the
 * practice's days, with the window's own figure beside them.
 *
 * Pure. The service reads the rows; this turns them into the table and its
 * CSV, so the definitions are one rule the page, the download and the specs
 * share. Where the document names a measure without defining it, the row
 * carries the definition used, and the CSV carries it too: a reader never has
 * to guess what was counted.
 *
 * A month's figure is for the month's days inside the window (the first and
 * last months may be partial). The window's figure is a sum for counts and
 * money, the rate or median over the whole window for rates and medians, a
 * distinct count for patients, and, for the census, the count at its end.
 *
 * Days are the practice's ('YYYY-MM-DD'); nothing here reads a clock.
 */
import { z } from "zod";

import {
  daysBetween,
  isHospiceCategory,
  readmissionIds,
  type EventKind,
} from "@/lib/features/clinical/clinical-course.types";
import { addDaysIso, isCalendarDay } from "@/lib/features/org/org-date";

// A day that does not exist (2026-09-31) is refused, as the overview's route
// does: bound into ::date, Postgres would refuse it with a 500.
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay, "Not a calendar day.");

/** ?fromDate=&toDate=, the practice's days; the last twelve months when neither. */
export const KpiQuerySchema = z.object({ fromDate: Day.optional(), toDate: Day.optional() });

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** How a value reads: money is in cents, a percent is 0-100. */
export type KpiUnit = "count" | "percent" | "money" | "days" | "score" | "ratio" | "minutes" | "average";

export interface KpiMonth {
  /** 'YYYY-MM' */
  key: string;
  /** The month's days inside the window. */
  from: string;
  to: string;
}

export interface KpiRow {
  /** Stable, for the CSV and the page's keys. */
  key: string;
  label: string;
  unit: KpiUnit;
  /** Where the measure is asked for: a Level-1 doc line, or the Trend Report's row. */
  source: string;
  definition: string;
  /** One per month of the window; null where there is nothing to divide by. */
  months: (number | null)[];
  /** The window's own figure. */
  total: number | null;
  /** Which months (indexes into `months`) were entered by hand, not counted (0125). */
  entered?: number[];
  /** The parts: by reason, by kind, by clinician. */
  children?: KpiRow[];
}

/** A month whose entered figure is not what Pallio itself counts (0125). */
export interface KpiDifference {
  month: string;
  label: string;
  unit: KpiUnit;
  entered: number;
  pallio: number;
}

export interface KpiSection {
  key: string;
  title: string;
  rows: KpiRow[];
}

export interface KpiReport {
  range: { fromDate: string; toDate: string };
  /** The practice's today: a month still under way is counted to it. */
  today: string;
  months: KpiMonth[];
  sections: KpiSection[];
  /** Set when a month's figures were entered: where they differ from Pallio's own. */
  differences?: KpiDifference[];
}

// ---------------------------------------------------------------------------
// What the service reads
// ---------------------------------------------------------------------------

export interface KpiReferral {
  receivedOn: string;
  stage: string;
  /** Where it came from, as the referral says (free text). */
  source: string | null;
  ntucOn: string | null;
  ntucReason: { code: string; label: string } | null;
  /** The patient's first visit made on or after the day the referral came in. */
  firstVisitOn: string | null;
}

/** A spell under the practice's care: from the day admitted to the day discharged. */
export interface KpiEpisode {
  patientId: string;
  from: string;
  /** Not under care at the end of this day; null while care goes on. */
  to: string | null;
}

/** A visit made: not scheduled, cancelled or a no-show, and never a PCM/CCM month. */
export interface KpiVisit {
  patientId: string;
  clinicianId: string;
  clinicianName: string | null;
  day: string;
  codingBasis: string | null;
  cptCodes: string[];
}

export interface KpiDischarge {
  dischargedOn: string;
  /** Null for a discharge recorded before reasons were (a status only). */
  reason: { code: string; label: string; category: string } | null;
  hospiceAdmittedOn: string | null;
  hospiceEndedOn: string | null;
}

/** A patient event, not voided. */
export interface KpiEvent {
  id: string;
  patientId: string;
  kind: string;
  occurredOn: string;
  endedOn: string | null;
  injury: boolean | null;
}

/** Symptom scores 0-10 from a visit's vitals or a call. */
export interface KpiScore {
  patientId: string;
  day: string;
  /** The instant, to order scores within a day. */
  at: string;
  pain: number | null;
  dyspnea: number | null;
  nausea: number | null;
}

export interface KpiAcuity {
  patientId: string;
  day: string;
  at: string;
  acuity: string;
}

export type CareProgram = "pcm" | "ccm";

export interface KpiBill {
  patientId: string;
  clinicianId: string | null;
  clinicianName: string | null;
  status: string;
  dos: string;
  billedCents: number;
  paidCents: number | null;
  submittedOn: string | null;
}

export interface KpiDenial {
  payerName: string | null;
  /** The denied claim's date of service. */
  dos: string;
  deniedCents: number;
}

export interface KpiInputs {
  range: { fromDate: string; toDate: string };
  today: string;
  referrals: KpiReferral[];
  episodes: KpiEpisode[];
  visits: KpiVisit[];
  discharges: KpiDischarge[];
  events: KpiEvent[];
  assessments: { patientId: string; assessedOn: string; eligible: boolean }[];
  scores: KpiScore[];
  acuity: KpiAcuity[];
  enrollments: { patientId: string; program: CareProgram; enrolledOn: string; endedOn: string | null }[];
  careTime: { program: CareProgram; serviceOn: string; minutes: number }[];
  /** A month charged: 'YYYY-MM'. */
  careCharges: { program: CareProgram; month: string }[];
  bills: KpiBill[];
  denials: KpiDenial[];
}

// ---------------------------------------------------------------------------
// Months and arithmetic
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** The last day of 'YYYY-MM'. */
export function monthEnd(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return `${key}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** Every month the window touches, each clipped to the window. */
export function kpiMonths(range: { fromDate: string; toDate: string }): KpiMonth[] {
  const out: KpiMonth[] = [];
  let key = range.fromDate.slice(0, 7);
  const last = range.toDate.slice(0, 7);
  while (key <= last) {
    const from = key === range.fromDate.slice(0, 7) ? range.fromDate : `${key}-01`;
    const to = key === last ? range.toDate : monthEnd(key);
    out.push({ key, from, to });
    const [y, m] = key.split("-").map(Number) as [number, number];
    key = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  return out;
}

const inDays = (day: string | null | undefined, from: string, to: string): day is string =>
  !!day && day >= from && day <= to;

/** Monday to Friday, both ends included. */
export function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** A share as a percent to one place; null with nothing to divide by. */
export const percentOf = (part: number, whole: number): number | null =>
  whole > 0 ? round(Math.min(100, (part / whole) * 100), 1) : null;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2, 1);
}

const mean = (xs: number[]): number | null => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** The window and each of its months, as [from, to] spans; the window is last. */
interface Spans {
  months: KpiMonth[];
  /** Each month, then the window. */
  all: { from: string; to: string }[];
}

function spansOf(range: { fromDate: string; toDate: string }): Spans {
  const months = kpiMonths(range);
  return { months, all: [...months.map((m) => ({ from: m.from, to: m.to })), { from: range.fromDate, to: range.toDate }] };
}

/** A row from one value per span: the months', then the window's. */
function row(
  spec: Omit<KpiRow, "months" | "total" | "children">,
  values: (number | null)[],
  children?: KpiRow[],
): KpiRow {
  return { ...spec, months: values.slice(0, -1), total: values.at(-1) ?? null, ...(children ? { children } : {}) };
}

/** Per span, the items whose day falls in it. */
function within<T>(sp: Spans, items: T[], dayOf: (t: T) => string | null): T[][] {
  return sp.all.map(({ from, to }) => items.filter((t) => inDays(dayOf(t), from, to)));
}

const countRow = <T>(sp: Spans, spec: Omit<KpiRow, "months" | "total" | "children" | "unit">, items: T[], dayOf: (t: T) => string | null, children?: KpiRow[]) =>
  row({ ...spec, unit: "count" }, within(sp, items, dayOf).map((xs) => xs.length), children);

/** Children by a label, sorted by it, each counted per span. */
function partsBy<T>(sp: Spans, keyPrefix: string, items: T[], dayOf: (t: T) => string | null, labelOf: (t: T) => string, definition: string, source: string): KpiRow[] {
  const labels = [...new Set(items.filter((t) => inDays(dayOf(t), sp.all.at(-1)!.from, sp.all.at(-1)!.to)).map(labelOf))].sort();
  return labels.map((label) =>
    countRow(sp, { key: `${keyPrefix}:${label}`, label, source, definition }, items.filter((t) => labelOf(t) === label), dayOf),
  );
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

/** Patients under care at the end of a day. */
export function censusOn(episodes: KpiEpisode[], day: string): number {
  const ids = new Set<string>();
  for (const e of episodes) if (e.from <= day && (e.to === null || e.to > day)) ids.add(e.patientId);
  return ids.size;
}

/** Under care on the day, as of the latest acuity recorded by then. */
function acuityOn(day: string, episodes: KpiEpisode[], acuity: KpiAcuity[]): Map<string, string | null> {
  const under = new Set<string>();
  for (const e of episodes) if (e.from <= day && (e.to === null || e.to > day)) under.add(e.patientId);
  const latest = new Map<string, KpiAcuity>();
  for (const a of acuity) {
    if (!under.has(a.patientId) || a.day > day) continue;
    const cur = latest.get(a.patientId);
    if (!cur || a.at > cur.at) latest.set(a.patientId, a);
  }
  return new Map([...under].map((id) => [id, latest.get(id)?.acuity ?? null]));
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

const VISIT_TYPE_PART: Record<string, string> = {
  new_patient_home: "New patient",
  established_patient_home: "Follow-up",
  advance_care_planning: "Advance care planning",
  inpatient_consult: "Inpatient consult",
  non_billable: "Not billed",
};

export const ACUITY_LEVELS = ["low", "medium", "high", "critical"] as const;
const ACUITY_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

const SYMPTOMS = [
  { key: "pain", label: "Pain", source: "doc:80" },
  { key: "dyspnea", label: "Shortness of breath", source: "doc:81" },
  { key: "nausea", label: "Nausea", source: "doc:82" },
] as const;

/** At or past this, a score is severe (the 0-10 scale's usual 7-10 band). */
export const SEVERE_SCORE = 7;

/** The day a span's census is taken: its last day, or today while it goes on. */
const censusDay = (to: string, today: string) => (to < today ? to : today);

function intakeSection(sp: Spans, i: KpiInputs): KpiSection {
  const received = within(sp, i.referrals, (r) => r.receivedOn);
  const outcome = (stage: string) => received.map((xs) => xs.filter((r) => r.stage === stage).length);
  const open = received.map((xs) => xs.filter((r) => r.stage === "pre_admission" || r.stage === "pending_long_term").length);
  const firstVisits = within(sp, i.referrals, (r) => r.firstVisitOn);
  const ntuc = i.referrals.filter((r) => r.stage === "ntuc" && r.ntucOn);
  const reasonOf = (r: KpiReferral) => (r.ntucReason ? `${r.ntucReason.code} ${r.ntucReason.label}` : "No reason recorded");
  const cohort = "Of the referrals received in the month, as they stand today.";
  return {
    key: "intake",
    title: "Referrals, admissions and census",
    rows: [
      row(
        { key: "referrals", label: "Referrals received", unit: "count", source: "doc:97 · Trend Report row 6", definition: "Referrals by the day they came in." },
        received.map((xs) => xs.length),
        [
          row({ key: "referrals:admitted", label: "Admitted", unit: "count", source: "Trend Report row 5", definition: cohort }, outcome("admitted")),
          row({ key: "referrals:ntuc", label: "Not taken under care", unit: "count", source: "doc:109", definition: cohort }, outcome("ntuc")),
          row({ key: "referrals:transitioned", label: "Transitioned", unit: "count", source: "doc:97", definition: cohort }, outcome("transitioned")),
          row({ key: "referrals:open", label: "Still open", unit: "count", source: "doc:97", definition: `${cohort} Pre-admission or pending long term.` }, open),
        ],
      ),
      row(
        {
          key: "conversion", label: "Referral conversion", unit: "percent", source: "doc:97 · Trend Report % admitted",
          definition: "Of the referrals received in the month, the share admitted (as the referral board counts it).",
        },
        received.map((xs) => percentOf(xs.filter((r) => r.stage === "admitted").length, xs.length)),
      ),
      row(
        {
          key: "referral_to_first_visit", label: "Days from referral to first visit (median)", unit: "days", source: "doc:98",
          definition: "For each admitted referral whose first visit was made in the month: days from the day the referral came in to that visit.",
        },
        firstVisits.map((xs) => median(xs.map((r) => daysBetween(r.receivedOn, r.firstVisitOn)!))),
        [row({ key: "referral_to_first_visit:n", label: "First visits made", unit: "count", source: "doc:98", definition: "The visits the median is over." }, firstVisits.map((xs) => xs.length))],
      ),
      countRow(
        sp,
        { key: "ntuc", label: "Not taken under care, by reason", source: "doc:109 · Trend Report D&N", definition: "Referrals closed as not taken under care, by the day they were closed." },
        ntuc,
        (r) => r.ntucOn,
        partsBy(sp, "ntuc", ntuc, (r) => r.ntucOn, reasonOf, "Closed as not taken under care with this reason.", "doc:109"),
      ),
      countRow(
        sp,
        { key: "admissions", label: "Admissions (care begun)", source: "doc:99", definition: "Spells of care begun in the month: first admissions and readmissions, by the day admitted." },
        i.episodes,
        (e) => e.from,
      ),
      row(
        {
          key: "census", label: "Patients under care (month end)", unit: "count", source: "doc:99 · Trend Report row 10",
          definition: "Patients admitted and not discharged at the end of the month's last day (today, for a month still under way). The window's figure is at its end.",
        },
        sp.all.map(({ from, to }) => (from > i.today ? null : censusOn(i.episodes, censusDay(to, i.today)))),
      ),
    ],
  };
}

/** One source however it was typed: spaces and capitals aside. "" when none was recorded. */
const sourceKey = (r: KpiReferral) => (r.source ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const NO_SOURCE = "Source not recorded";

/** The spelling most referrals used, the first of them alphabetically on a tie. */
function sourceLabel(rows: KpiReferral[]): string {
  const spellings = new Map<string, number>();
  for (const r of rows) {
    const s = (r.source ?? "").trim().replace(/\s+/g, " ");
    spellings.set(s, (spellings.get(s) ?? 0) + 1);
  }
  return [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0] || NO_SOURCE;
}

/**
 * Where referrals come from (doc:21; the Source Volume slide): each source's
 * referrals, those admitted and its conversion, busiest source first, the ones
 * with no source recorded last.
 */
function sourcesSection(sp: Spans, i: KpiInputs): KpiSection {
  const inWindow = within(sp, i.referrals, (r) => r.receivedOn).at(-1)!;
  const groups = new Map<string, KpiReferral[]>();
  for (const r of inWindow) groups.set(sourceKey(r), [...(groups.get(sourceKey(r)) ?? []), r]);
  const sources = [...groups.entries()]
    .map(([key, rows]) => ({ key, label: sourceLabel(rows), n: rows.length }))
    .sort((a, b) => Number(a.key === "") - Number(b.key === "") || b.n - a.n || a.label.localeCompare(b.label));
  const received = (key: string | null) => within(sp, key === null ? i.referrals : i.referrals.filter((r) => sourceKey(r) === key), (r) => r.receivedOn);
  const admitted = (rs: KpiReferral[]) => rs.filter((r) => r.stage === "admitted").length;
  const source = "doc:21 · Trend Report Source Volume";
  const parts = (keyPrefix: string, unit: KpiUnit, definition: string, value: (rs: KpiReferral[]) => number | null) =>
    sources.map((s) => row({ key: `${keyPrefix}:${s.key}`, label: s.label, unit, source, definition }, received(s.key).map(value)));
  const cohort = "Of the referrals received in the month, as they stand today.";
  return {
    key: "sources",
    title: "Referral sources",
    rows: [
      row(
        { key: "source_referrals", label: "Referrals, by source", unit: "count", source, definition: "Referrals by the day they came in, by the source on the referral. Spaces and capitals aside, one spelling is one source." },
        received(null).map((rs) => rs.length),
        parts("source_referrals", "count", "Referrals from this source.", (rs) => rs.length),
      ),
      row(
        { key: "source_admitted", label: "Admitted, by source", unit: "count", source, definition: cohort },
        received(null).map(admitted),
        parts("source_admitted", "count", `Admitted from this source. ${cohort}`, admitted),
      ),
      row(
        { key: "source_conversion", label: "Conversion, by source", unit: "percent", source, definition: `The share of a source's referrals admitted. ${cohort}` },
        received(null).map((rs) => percentOf(admitted(rs), rs.length)),
        parts("source_conversion", "percent", `Admitted ÷ referrals from this source. ${cohort}`, (rs) => percentOf(admitted(rs), rs.length)),
      ),
    ],
  };
}

function visitsSection(sp: Spans, i: KpiInputs): KpiSection {
  const made = within(sp, i.visits, (v) => v.day);
  const typeOf = (v: KpiVisit) => VISIT_TYPE_PART[v.codingBasis ?? ""] ?? "Other";
  // In the order the types are listed above, anything else last.
  const order = (t: string) => {
    const k = Object.values(VISIT_TYPE_PART).indexOf(t);
    return k === -1 ? Number.MAX_SAFE_INTEGER : k;
  };
  const types = [...new Set(made.at(-1)!.map(typeOf))].sort((a, b) => order(a) - order(b));
  const clinicians = [...new Map(made.at(-1)!.map((v) => [v.clinicianId, v.clinicianName ?? "A former team member"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const elapsed = sp.all.map(({ from, to }) => (from > i.today ? 0 : weekdaysBetween(from, censusDay(to, i.today))));
  const seen = made.map((xs) => new Set(xs.map((v) => v.patientId)).size);
  return {
    key: "visits",
    title: "Visits",
    rows: [
      row(
        { key: "visits", label: "Visits made", unit: "count", source: "doc:100", definition: "Visits started, documented or billed, by the day they were made (not scheduled, cancelled or no-shows)." },
        made.map((xs) => xs.length),
        types.map((t) =>
          row({ key: `visits:type:${t}`, label: t, unit: "count", source: "doc:100", definition: "Visits made of this kind (the visit type's coding)." }, made.map((xs) => xs.filter((v) => typeOf(v) === t).length)),
        ),
      ),
      row(
        {
          key: "visits_new_followup", label: "New patient and follow-up visits", unit: "count", source: "Trend Report rows 19-21",
          definition: "The Trend Report's total visits: new patient plus follow-up home visits.",
        },
        made.map((xs) => xs.filter((v) => v.codingBasis === "new_patient_home" || v.codingBasis === "established_patient_home").length),
      ),
      row(
        { key: "visits_acp", label: "Visits with advance care planning billed", unit: "count", source: "Trend Report row 23", definition: "Visits made with 99497 among their codes." },
        made.map((xs) => xs.filter((v) => v.cptCodes.includes("99497")).length),
      ),
      row({ key: "patients_seen", label: "Patients seen", unit: "count", source: "doc:100", definition: "Different patients with a visit made." }, seen),
      row(
        { key: "visit_frequency", label: "Visits per patient seen", unit: "ratio", source: "doc:100", definition: "Visits made ÷ patients seen." },
        made.map((xs, k) => (seen[k]! > 0 ? round(xs.length / seen[k]!, 2) : null)),
      ),
      row(
        { key: "visits_per_day", label: "Visits per weekday", unit: "ratio", source: "doc:107", definition: "Visits made ÷ weekdays (Monday to Friday) in the month, up to today for a month still under way." },
        made.map((xs, k) => (elapsed[k]! > 0 ? round(xs.length / elapsed[k]!, 2) : null)),
      ),
      row(
        { key: "visits_by_clinician", label: "Visits made, by clinician", unit: "count", source: "doc:106", definition: "Visits made, by the clinician who made them." },
        made.map((xs) => xs.length),
        clinicians.map(([id, name]) =>
          row({ key: `visits:clinician:${id}`, label: name, unit: "count", source: "doc:106", definition: "Visits this clinician made." }, made.map((xs) => xs.filter((v) => v.clinicianId === id).length)),
        ),
      ),
    ],
  };
}

function careManagementSection(sp: Spans, i: KpiInputs): KpiSection {
  const inForce = (program: CareProgram | null) =>
    sp.all.map(({ from, to }) =>
      new Set(
        i.enrollments
          .filter((e) => (program === null || e.program === program) && e.enrolledOn <= to && (e.endedOn === null || e.endedOn >= from))
          .map((e) => e.patientId),
      ).size,
    );
  const minutes = (program: CareProgram | null) =>
    within(sp, i.careTime.filter((t) => program === null || t.program === program), (t) => t.serviceOn).map((xs) => sum(xs.map((t) => t.minutes)));
  const charged = (program: CareProgram | null) => {
    const keys = sp.months.map((m) => m.key);
    const ofProgram = i.careCharges.filter((c) => program === null || c.program === program);
    return [...keys.map((k) => ofProgram.filter((c) => c.month === k).length), ofProgram.filter((c) => keys.includes(c.month)).length];
  };
  const PROGRAMS: [CareProgram, string][] = [["pcm", "PCM"], ["ccm", "CCM"]];
  return {
    key: "care_management",
    title: "Care between visits (PCM/CCM)",
    rows: [
      row(
        { key: "cm_enrolled", label: "Patients enrolled", unit: "count", source: "doc:101", definition: "Patients with a PCM or CCM enrolment in force on any day of the month." },
        inForce(null),
        PROGRAMS.map(([p, label]) => row({ key: `cm_enrolled:${p}`, label, unit: "count", source: "doc:101", definition: `Enrolled in ${label}.` }, inForce(p))),
      ),
      row(
        { key: "cm_minutes", label: "Care management minutes logged", unit: "minutes", source: "doc:101", definition: "Minutes on the PCM/CCM time log, by the day the work was done (voided entries left out)." },
        minutes(null),
        PROGRAMS.map(([p, label]) => row({ key: `cm_minutes:${p}`, label, unit: "minutes", source: "doc:101", definition: `Minutes logged under ${label}.` }, minutes(p))),
      ),
      row(
        { key: "cm_months_billed", label: "Months billed", unit: "count", source: "doc:101", definition: "PCM/CCM months charged, by the month the time was logged in." },
        charged(null),
        PROGRAMS.map(([p, label]) => row({ key: `cm_months_billed:${p}`, label, unit: "count", source: "doc:101", definition: `${label} months charged.` }, charged(p))),
      ),
    ],
  };
}

function clinicalSection(sp: Spans, i: KpiInputs): KpiSection {
  const rows: KpiRow[] = SYMPTOMS.map((s) => {
    const scored = i.scores.filter((x) => x[s.key] !== null).sort((a, b) => a.at.localeCompare(b.at));
    const first = new Map<string, KpiScore>();
    for (const x of scored) if (!first.has(x.patientId)) first.set(x.patientId, x);
    // Each patient once per span: their last score in it.
    const lastIn = sp.all.map(({ from, to }) => {
      const m = new Map<string, KpiScore>();
      for (const x of scored) if (inDays(x.day, from, to)) m.set(x.patientId, x);
      return [...m.values()];
    });
    const value = (x: KpiScore) => x[s.key]!;
    const improved = lastIn.map((xs) => {
      const compared = xs.filter((x) => first.get(x.patientId)!.at < x.at);
      return percentOf(compared.filter((x) => value(x) < value(first.get(x.patientId)!)).length, compared.length);
    });
    return row(
      {
        key: `symptom:${s.key}`, label: `${s.label}: average score`, unit: "score", source: s.source,
        definition: `0-10, from visits' vitals and calls. Each patient counts once: their last score in the month.`,
      },
      lastIn.map((xs) => mean(xs.map(value))),
      [
        row({ key: `symptom:${s.key}:n`, label: "Patients scored", unit: "count", source: s.source, definition: "Different patients with a score in the month." }, lastIn.map((xs) => xs.length)),
        row(
          { key: `symptom:${s.key}:severe`, label: `Severe (${SEVERE_SCORE}-10)`, unit: "percent", source: s.source, definition: `Share of the patients scored whose last score was ${SEVERE_SCORE} or more.` },
          lastIn.map((xs) => percentOf(xs.filter((x) => value(x) >= SEVERE_SCORE).length, xs.length)),
        ),
        row(
          {
            key: `symptom:${s.key}:improved`, label: "Better than their first score", unit: "percent", source: "doc:83",
            definition: "Of the patients scored who had an earlier score, the share whose last score is lower than the first one on record: symptom change over time.",
          },
          improved,
        ),
      ],
    );
  });
  const levels = sp.all.map(({ from, to }) => (from > i.today ? null : acuityOn(censusDay(to, i.today), i.episodes, i.acuity)));
  const levelRow = (level: string | null, label: string) =>
    row(
      { key: `acuity:${level ?? "none"}`, label, unit: "count", source: "doc:84", definition: level ? `Patients under care whose acuity was ${label.toLowerCase()}.` : "Patients under care with no acuity recorded." },
      levels.map((m) => (m ? [...m.values()].filter((a) => a === level).length : null)),
    );
  rows.push(
    row(
      {
        key: "acuity", label: "High or critical acuity (month end)", unit: "percent", source: "doc:84",
        definition: "Of the patients under care at the month's end, the share whose acuity, as last recorded by then, was high or critical.",
      },
      levels.map((m) => (m ? percentOf([...m.values()].filter((a) => a === "high" || a === "critical").length, m.size) : null)),
      [...ACUITY_LEVELS.map((l) => levelRow(l, ACUITY_LABEL[l]!)), levelRow(null, "Not recorded")],
    ),
  );
  return { key: "clinical", title: "Symptoms and acuity", rows };
}

function utilizationSection(sp: Spans, i: KpiInputs): KpiSection {
  const byPatient = new Map<string, KpiEvent[]>();
  for (const e of i.events) byPatient.set(e.patientId, [...(byPatient.get(e.patientId) ?? []), e]);
  const readmitted = new Set<string>();
  for (const evs of byPatient.values()) {
    // The chart's own rule, per patient, so the two agree.
    const tagged = readmissionIds(
      evs.map((e) => ({ id: e.id, kind: e.kind as EventKind, occurredOn: e.occurredOn, endedOn: e.endedOn, voidedAt: null })),
    );
    for (const id of tagged) readmitted.add(id);
  }
  const kind = (k: string) => i.events.filter((e) => e.kind === k);
  const day = (e: KpiEvent) => e.occurredOn;
  return {
    key: "utilization",
    title: "Hospital use, falls and other events",
    rows: [
      countRow(sp, { key: "ed_visits", label: "ED visits", source: "doc:86", definition: "Emergency department visits recorded on charts, by the day of the visit." }, kind("ed_visit"), day),
      countRow(
        sp,
        { key: "admissions_hospital", label: "Hospital admissions", source: "doc:87", definition: "Hospital admissions recorded on charts, by the day admitted." },
        kind("hospital_admission"),
        day,
        [countRow(sp, { key: "readmissions", label: "Readmissions within 30 days", source: "doc:87", definition: "Admissions within 30 days of the patient's last hospital discharge, as the chart tags them." }, kind("hospital_admission").filter((e) => readmitted.has(e.id)), day)],
      ),
      countRow(
        sp,
        { key: "falls", label: "Falls", source: "doc:88", definition: "Falls recorded on charts." },
        kind("fall"),
        day,
        [countRow(sp, { key: "falls:injury", label: "With injury", source: "doc:88", definition: "Falls recorded with an injury." }, kind("fall").filter((e) => e.injury === true), day)],
      ),
      countRow(sp, { key: "other_events", label: "Other significant events", source: "doc:89", definition: "Other significant events recorded on charts." }, kind("other"), day),
    ],
  };
}

function hospiceSection(sp: Spans, i: KpiInputs): KpiSection {
  const discharged = (d: KpiDischarge) => d.dischargedOn;
  const transitions = i.discharges.filter((d) => d.reason && isHospiceCategory(d.reason.category));
  const partner = transitions.filter((d) => d.reason!.category === "hospice_partner");
  const other = transitions.filter((d) => d.reason!.category === "hospice_other");
  const partnerN = within(sp, partner, discharged).map((xs) => xs.length);
  const otherN = within(sp, other, discharged).map((xs) => xs.length);
  const stays = i.discharges.filter((d) => d.hospiceAdmittedOn && d.hospiceEndedOn);
  const ended = within(sp, stays, (d) => d.hospiceEndedOn);
  const reasonOf = (d: KpiDischarge) => (d.reason ? `${d.reason.code} ${d.reason.label}` : "No reason recorded");
  return {
    key: "hospice",
    title: "Hospice and discharges",
    rows: [
      countRow(
        sp,
        { key: "hospice_assessed", label: "Hospice appropriateness assessed", source: "doc:91", definition: "Assessments of whether a patient is appropriate for hospice, by the day assessed." },
        i.assessments,
        (a) => a.assessedOn,
        [countRow(sp, { key: "hospice_assessed:yes", label: "Appropriate", source: "doc:91", definition: "Assessed as appropriate for hospice." }, i.assessments.filter((a) => a.eligible), (a) => a.assessedOn)],
      ),
      countRow(sp, { key: "hospice_discussions", label: "Hospice discussions", source: "doc:92", definition: "Hospice discussions recorded on charts." }, i.events.filter((e) => e.kind === "hospice_discussion"), (e) => e.occurredOn),
      countRow(sp, { key: "hospice_referrals", label: "Hospice referrals", source: "doc:92", definition: "Referrals to a hospice recorded on charts." }, i.events.filter((e) => e.kind === "hospice_referral"), (e) => e.occurredOn),
      row(
        { key: "transitions", label: "Transitions to hospice", unit: "count", source: "doc:93 · Trend Report rows 31-35", definition: "Discharges to a hospice, by the day discharged." },
        partnerN.map((n, k) => n + otherN[k]!),
        [
          row({ key: "transitions:partner", label: "To the partner hospice", unit: "count", source: "Trend Report row 31", definition: "Discharged with a partner-hospice reason code." }, partnerN),
          row({ key: "transitions:other", label: "To another hospice", unit: "count", source: "Trend Report row 32", definition: "Discharged with another-hospice reason code." }, otherN),
        ],
      ),
      row(
        { key: "transitions_partner_share", label: "Share to the partner hospice", unit: "percent", source: "Trend Report row 43", definition: "Partner-hospice transitions ÷ all transitions to hospice." },
        partnerN.map((n, k) => percentOf(n, n + otherN[k]!)),
      ),
      countRow(sp, { key: "hospice_admissions", label: "Hospice admissions", source: "doc:94", definition: "Hospice admissions recorded on discharges, by the day the hospice admitted the patient." }, i.discharges, (d) => d.hospiceAdmittedOn),
      row(
        {
          key: "hospice_los", label: "Hospice length of stay (median days)", unit: "days", source: "doc:95",
          definition: "For hospice stays that ended in the month: days from the hospice admission to the end of the stay (same day = 0).",
        },
        ended.map((xs) => median(xs.map((d) => daysBetween(d.hospiceAdmittedOn, d.hospiceEndedOn)!))),
        [row({ key: "hospice_los:n", label: "Stays ended", unit: "count", source: "doc:95", definition: "Hospice stays whose end was recorded in the month." }, ended.map((xs) => xs.length))],
      ),
      countRow(
        sp,
        { key: "deaths", label: "Deaths on palliative care", source: "Trend Report row 45", definition: "Discharges with a death reason code." },
        i.discharges.filter((d) => d.reason?.category === "death"),
        discharged,
      ),
      countRow(
        sp,
        {
          key: "discharges", label: "Discharges, by reason", source: "doc:108 · Trend Report D&N",
          definition: "Discharges by the day discharged, including those later followed by a readmission.",
        },
        i.discharges,
        discharged,
        partsBy(sp, "discharges", i.discharges, discharged, reasonOf, "Discharged with this reason.", "doc:108"),
      ),
    ],
  };
}

function revenueSection(sp: Spans, i: KpiInputs): KpiSection {
  // A draft was never raised and a voided bill was cancelled: neither is a
  // charge (reports-pure revenueSummary).
  const charges = i.bills.filter((b) => b.status !== "draft" && b.status !== "voided");
  const byDos = within(sp, charges, (b) => b.dos);
  const billed = byDos.map((xs) => sum(xs.map((b) => b.billedCents)));
  const paid = byDos.map((xs) => sum(xs.map((b) => b.paidCents ?? 0)));
  const submitted = within(sp, i.bills, (b) => b.submittedOn);
  const denied = within(sp, i.denials, (d) => d.dos);
  const deniedCents = denied.map((xs) => sum(xs.map((d) => d.deniedCents)));
  const patients = byDos.map((xs) => new Set(xs.map((b) => b.patientId)).size);
  const payers = [...new Set(denied.at(-1)!.map((d) => d.payerName ?? "Payer not recorded"))].sort();
  const clinicians = [...new Map(byDos.at(-1)!.map((b) => [b.clinicianId ?? "", b.clinicianName ?? "Not recorded"])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const cohort = "Claims with a date of service in the month (drafts and voided bills left out).";
  return {
    key: "revenue",
    title: "Billing and revenue",
    rows: [
      row({ key: "billed", label: "Charges billed", unit: "money", source: "doc:102", definition: cohort }, billed),
      row(
        { key: "claims_submitted", label: "Claims submitted", unit: "count", source: "doc:103", definition: "Claims recorded as submitted to the payer, by the day they were." },
        submitted.map((xs) => xs.length),
        [row({ key: "claims_submitted:billed", label: "Billed on them", unit: "money", source: "doc:103", definition: "What the claims submitted in the month billed." }, submitted.map((xs) => sum(xs.map((b) => b.billedCents))))],
      ),
      row({ key: "collected", label: "Collected", unit: "money", source: "doc:104", definition: `Paid on the ${cohort.charAt(0).toLowerCase()}${cohort.slice(1)}` }, paid),
      row({ key: "collection_rate", label: "Collection rate", unit: "percent", source: "doc:104", definition: "Collected ÷ billed, on the same claims." }, paid.map((p, k) => percentOf(p, billed[k]!))),
      row(
        { key: "denied", label: "Denied", unit: "money", source: "doc:104", definition: "Denied dollars on claims with a date of service in the month, by payer below." },
        deniedCents,
        payers.map((p) =>
          row({ key: `denied:${p}`, label: p, unit: "money", source: "doc:104", definition: "Denied by this payer." }, denied.map((xs) => sum(xs.filter((d) => (d.payerName ?? "Payer not recorded") === p).map((d) => d.deniedCents)))),
        ),
      ),
      row({ key: "denial_rate", label: "Denial rate", unit: "percent", source: "doc:104", definition: "Denied ÷ billed, on claims with a date of service in the month." }, deniedCents.map((d, k) => percentOf(d, billed[k]!))),
      row(
        { key: "billed_per_patient", label: "Billed per patient", unit: "money", source: "doc:105", definition: "Charges billed ÷ the patients billed for." },
        billed.map((b, k) => (patients[k]! > 0 ? Math.round(b / patients[k]!) : null)),
      ),
      row(
        { key: "collected_per_patient", label: "Collected per patient", unit: "money", source: "doc:105", definition: "Collected ÷ the patients billed for. Lags billing while claims are with payers." },
        paid.map((p, k) => (patients[k]! > 0 ? Math.round(p / patients[k]!) : null)),
      ),
      row(
        { key: "billed_by_clinician", label: "Billed, by rendering clinician", unit: "money", source: "doc:106", definition: `${cohort} By the clinician whose visit the claim is for.` },
        billed,
        clinicians.map(([id, name]) =>
          row({ key: `billed:clinician:${id}`, label: name, unit: "money", source: "doc:106", definition: "Billed for this clinician's visits." }, byDos.map((xs) => sum(xs.filter((b) => (b.clinicianId ?? "") === id).map((b) => b.billedCents)))),
        ),
      ),
      row(
        { key: "collected_by_clinician", label: "Collected, by rendering clinician", unit: "money", source: "doc:106", definition: "Collected on those claims, by clinician." },
        paid,
        clinicians.map(([id, name]) =>
          row({ key: `collected:clinician:${id}`, label: name, unit: "money", source: "doc:106", definition: "Collected for this clinician's visits." }, byDos.map((xs) => sum(xs.filter((b) => (b.clinicianId ?? "") === id).map((b) => b.paidCents ?? 0)))),
        ),
      ),
    ],
  };
}

/** The report, from what the service read. */
export function buildKpiReport(i: KpiInputs): KpiReport {
  const sp = spansOf(i.range);
  return {
    range: i.range,
    today: i.today,
    months: sp.months,
    sections: [
      intakeSection(sp, i),
      sourcesSection(sp, i),
      visitsSection(sp, i),
      careManagementSection(sp, i),
      clinicalSection(sp, i),
      utilizationSection(sp, i),
      hospiceSection(sp, i),
      revenueSection(sp, i),
    ],
  };
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** A row anywhere in a report, a measure or a part of one. */
export function findKpiRow(r: KpiReport, key: string): KpiRow | null {
  for (const s of r.sections) {
    for (const top of s.rows) {
      if (top.key === key) return top;
      const part = top.children?.find((c) => c.key === key);
      if (part) return part;
    }
  }
  return null;
}

/** A value as the page and the CSV write it: dollars, a percent, minutes. */
export function formatKpi(v: number | null, unit: KpiUnit, opts: { csv?: boolean } = {}): string {
  if (v === null) return opts.csv ? "" : "—";
  switch (unit) {
    case "money":
      return opts.csv ? (v / 100).toFixed(2) : `$${(v / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    case "percent":
      return opts.csv ? v.toFixed(1) : `${v.toFixed(1)}%`;
    case "ratio":
      return v.toFixed(2);
    case "days":
    case "score":
    case "average":
      return v.toFixed(1);
    default:
      return opts.csv ? String(v) : v.toLocaleString("en-US");
  }
}

/** "Oct 2026"; "Oct 2026 (1-28)" for a month the window only partly covers, "Jul 2026 (31)" for one day of it. */
export function kpiMonthLabel(m: KpiMonth): string {
  const name = new Date(`${m.key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  if (m.from === `${m.key}-01` && m.to === monthEnd(m.key)) return name;
  const [a, b] = [Number(m.from.slice(8)), Number(m.to.slice(8))];
  return `${name} (${a === b ? a : `${a}-${b}`})`;
}

const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * The report as a CSV: one line per measure and per part of one, its
 * definition beside it, then a column a month and the window's. Money in
 * dollars, percents as numbers: a spreadsheet adds them up as they are. The
 * last column names the months entered by hand, so a reader can tell them from
 * the counted ones.
 */
export function kpiCsv(r: KpiReport): string {
  const labels = r.months.map(kpiMonthLabel);
  const head = ["section", "measure", "part of", "unit", "source", "definition", ...labels, `${r.range.fromDate} to ${r.range.toDate}`, "entered by hand"];
  const lines: string[][] = [head];
  for (const s of r.sections) {
    for (const top of s.rows) {
      for (const [x, parent] of [[top, ""] as const, ...(top.children ?? []).map((c) => [c, top.label] as const)]) {
        lines.push([
          s.title, x.label, parent, x.unit === "money" ? "dollars" : x.unit, x.source, x.definition,
          ...x.months.map((v) => formatKpi(v, x.unit, { csv: true })), formatKpi(x.total, x.unit, { csv: true }),
          (x.entered ?? []).map((at) => labels[at]).join("; "),
        ]);
      }
    }
  }
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
