/**
 * The KPI report as a workbook: the table a column a month, the year-over-year
 * table, and every measure's definition. Money is in dollars and a percent is a
 * true percent, so Excel adds and charts them as they are. Counts and money
 * only; no patient is named.
 */
import { kpiMonthLabel, type KpiReport, type KpiRow, type KpiUnit } from "./kpi-report";
import { yearChange, type KpiYearOverYear } from "./kpi-year-over-year";
import { buildXlsx, type Cell, type CellInput, type CellStyle, type Sheet } from "./xlsx-writer";

export const HEAD: CellStyle = { bold: true, color: "FFFFFF", fill: "334155" };
export const HEAD_RIGHT: CellStyle = { ...HEAD, align: "right" };
export const SECTION: CellStyle = { bold: true, fill: "E2E8F0" };
export const TITLE: CellStyle = { bold: true, size: 14 };
export const NOTE: CellStyle = { italic: true, color: "64748B" };

const FORMAT: Record<KpiUnit, string> = {
  count: "#,##0",
  money: '"$"#,##0.00',
  percent: "0.0%",
  days: "0.0",
  score: "0.0",
  average: "0.0",
  ratio: "0.00",
  minutes: "#,##0",
};

/** A value as Excel should hold it. */
export function kpiCell(v: number | null, unit: KpiUnit, style: CellStyle = {}): Cell {
  const value = v === null ? null : unit === "money" ? v / 100 : unit === "percent" ? v / 100 : v;
  return { v: value, s: { ...style, format: FORMAT[unit], align: "right" } };
}

/** The cells of months entered by hand (0125). */
export const ENTERED: CellStyle = { fill: "FEF3C7" };

function reportSheet(r: KpiReport): Sheet {
  const months = r.months.map(kpiMonthLabel);
  const period = `${r.range.fromDate} to ${r.range.toDate}`;
  const blank = (s: CellStyle) => Array.from({ length: months.length + 1 }, (): Cell => ({ v: null, s }));
  const rows: CellInput[][] = [
    [{ v: "KPI report", s: TITLE }],
    [{ v: `${period}. Shaded months were entered by hand on Monthly history.`, s: NOTE }],
    [{ v: "Measure", s: HEAD }, ...months.map((m) => ({ v: m, s: HEAD_RIGHT })), { v: "Period", s: HEAD_RIGHT }],
  ];
  const line = (x: KpiRow, part: boolean) => [
    { v: x.label, s: part ? { indent: 1, color: "475569" } : { bold: true } },
    ...x.months.map((v, k) => kpiCell(v, x.unit, { ...(part ? { color: "475569" } : {}), ...(x.entered?.includes(k) ? ENTERED : {}) })),
    kpiCell(x.total, x.unit, part ? { color: "475569" } : { bold: true }),
  ];
  for (const s of r.sections) {
    rows.push([{ v: s.title, s: SECTION }, ...blank(SECTION)]);
    for (const top of s.rows) {
      rows.push(line(top, false));
      for (const c of top.children ?? []) rows.push(line(c, true));
    }
  }
  return { name: "KPI report", rows, widths: [46, ...months.map((m) => Math.max(11, m.length + 2)), 14], freeze: { rows: 3, columns: 1 } };
}

function yearSheet(y: KpiYearOverYear): Sheet {
  const head = (r: { fromDate: string; toDate: string }) => `${r.fromDate} to ${r.toDate}`;
  return {
    name: "Year over year",
    rows: [
      [{ v: "Year over year", s: TITLE }],
      [{ v: "A period beside the same days a year before. Per-month rows divide by the months the period covers.", s: NOTE }],
      [{ v: "Measure", s: HEAD }, { v: head(y.prior), s: HEAD_RIGHT }, { v: head(y.current), s: HEAD_RIGHT }, { v: "Change", s: HEAD_RIGHT }],
      ...y.rows.map((row) => [{ v: row.label, s: { bold: true } }, kpiCell(row.prior, row.unit), kpiCell(row.current, row.unit), { v: yearChange(row), s: { align: "right" as const } }]),
    ],
    widths: [46, 26, 26, 12],
    freeze: { rows: 3, columns: 1 },
  };
}

function definitionsSheet(r: KpiReport, y: KpiYearOverYear): Sheet {
  const rows: CellInput[][] = [
    [{ v: "What each measure counts", s: TITLE }],
    [{ v: "Measure", s: HEAD }, { v: "Part of", s: HEAD }, { v: "Asked for by", s: HEAD }, { v: "Definition", s: HEAD }],
  ];
  const wrapped = (v: string): Cell => ({ v, s: { wrap: true } });
  for (const s of r.sections) {
    rows.push([{ v: s.title, s: SECTION }, { v: null, s: SECTION }, { v: null, s: SECTION }, { v: null, s: SECTION }]);
    for (const top of s.rows) {
      rows.push([wrapped(top.label), null, wrapped(top.source), wrapped(top.definition)]);
      for (const c of top.children ?? []) rows.push([wrapped(c.label), wrapped(top.label), wrapped(c.source), wrapped(c.definition)]);
    }
  }
  rows.push([{ v: "Year over year", s: SECTION }, { v: null, s: SECTION }, { v: null, s: SECTION }, { v: null, s: SECTION }]);
  for (const row of y.rows) rows.push([wrapped(row.label), null, wrapped("Trend Report YoY"), wrapped(row.definition)]);
  return { name: "Definitions", rows, widths: [40, 34, 28, 90], freeze: { rows: 2, columns: 0 } };
}

export const kpiWorkbook = (r: KpiReport, y: KpiYearOverYear): Uint8Array => buildXlsx([reportSheet(r), yearSheet(y), definitionsSheet(r, y)]);
